/**
 * pi-bridge server.
 *
 * Exposes the pi SDK over a small REST + WebSocket surface and serves a browser chat UI.
 * Runs inside a Renku session pod and is the session's exposed app; the Renku gateway
 * provides TLS + user auth in front of it.
 *
 * Renku proxies the session under RENKU_BASE_URL_PATH and does NOT strip that prefix
 * (exactly like JupyterLab's `--ServerApp.base_url`), so every route below is mounted
 * under that base. We ALSO mount at root so direct access (e.g. over Tailscale, where the
 * pod port is hit without the proxy prefix) keeps working for the iOS/watchOS clients.
 *
 *   GET  <base>/                          -> browser chat UI
 *   GET  <base>/app.js, <base>/app.css    -> UI assets
 *   GET  /healthz                         -> liveness (unprefixed; k8s probes bypass the proxy)
 *   GET  <base>/api/sessions[?cwd=...]      -> WireSessionSummary[]
 *   POST <base>/api/sessions                -> create a session
 *   WS   <base>/ws?session=<id>&token=<t>   -> attach to a session, stream events, send commands
 */

import Fastify from "fastify";
import type { FastifyPluginAsync } from "fastify";
import websocket from "@fastify/websocket";
import type { WebSocket } from "ws";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, extname, join } from "node:path";
import { authDisabled, tokenFromRequest, tokenValid } from "./auth.ts";
import { PiSession } from "./pi-session.ts";
import type { ClientCommand, ServerEvent } from "./protocol.ts";
import { PROTOCOL_VERSION } from "./protocol.ts";
import { listSessions, resolveSessionFile } from "./sessions-index.ts";

const PORT = Number(process.env.PORT ?? process.env.PI_BRIDGE_PORT ?? process.env.RENKU_SESSION_PORT ?? 8080);
const HOST = process.env.HOST ?? process.env.RENKU_SESSION_IP ?? "0.0.0.0";
/** Where freshly-created pi sessions live (the project dir, e.g. /workspace). */
const DEFAULT_CWD = process.env.PI_SESSION_CWD ?? process.cwd();
/** How long a created-but-not-yet-attached session is kept alive before being reclaimed. */
const PENDING_TTL_MS = 5 * 60 * 1000;

/** Static UI lives in bridge/public (sibling of src/). */
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const ASSET_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
};

/**
 * Renku serves the session under this path prefix (default "/"). Normalise to either "/"
 * or "/some/path" (no trailing slash) for use as a Fastify route prefix.
 */
function normalizeBase(raw: string | undefined): string {
  const trimmed = (raw ?? "/").replace(/^\/+|\/+$/g, "");
  return trimmed === "" ? "/" : `/${trimmed}`;
}
const BASE = normalizeBase(process.env.RENKU_BASE_URL_PATH);

/**
 * New sessions created via `POST /api/sessions` but not yet attached over WS. A brand-new
 * pi session has no JSONL file on disk until its first message_end, so it can't be found by
 * `resolveSessionFile` yet — we park the live PiSession here and let the WS adopt it.
 */
const pending = new Map<string, { pi: PiSession; timer: ReturnType<typeof setTimeout> }>();

function reclaimPending(id: string) {
  const entry = pending.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(id);
  void entry.pi.dispose();
}

const app = Fastify({ logger: true });
await app.register(websocket);

// Liveness is probed directly on the pod port (no proxy prefix) → keep it unprefixed.
app.get("/healthz", async () => ({ ok: true, protocolVersion: PROTOCOL_VERSION, authDisabled: authDisabled() }));

/**
 * All user-facing routes (UI + REST + WS), registered once per mount point. `uiBase` is
 * injected into index.html's <base href> so the browser resolves every relative URL under
 * the correct Renku prefix.
 */
const appRoutes: FastifyPluginAsync<{ uiBase: string }> = async (fastify, { uiBase }) => {
  // --- Browser UI ---------------------------------------------------------
  fastify.get("/", async (_req, reply) => {
    let html: string;
    try {
      html = await readFile(join(PUBLIC_DIR, "index.html"), "utf8");
    } catch {
      return reply.code(404).type("text/plain").send("UI not found");
    }
    return reply
      .type("text/html; charset=utf-8")
      .header("cache-control", "no-store")
      .send(html.replaceAll("__BASE__", uiBase));
  });
  // Fixed, known asset names — no user-controlled path component, so no traversal risk.
  for (const name of ["app.js", "app.css"] as const) {
    fastify.get(`/${name}`, async (_req, reply) => {
      try {
        const body = await readFile(join(PUBLIC_DIR, name));
        return reply.type(ASSET_TYPES[extname(name)] ?? "application/octet-stream").send(body);
      } catch {
        return reply.code(404).type("text/plain").send("not found");
      }
    });
  }

  // --- REST API -----------------------------------------------------------
  fastify.get("/api/sessions", async (req, reply) => {
    const token = tokenFromRequest(req.url, req.headers.authorization);
    if (!tokenValid(token)) return reply.code(401).send({ error: "unauthorized" });
    const cwd = (req.query as { cwd?: string }).cwd;
    return listSessions(cwd);
  });

  fastify.post("/api/sessions", async (req, reply) => {
    const token = tokenFromRequest(req.url, req.headers.authorization);
    if (!tokenValid(token)) return reply.code(401).send({ error: "unauthorized" });
    const cwd = (req.body as { cwd?: string } | undefined)?.cwd ?? DEFAULT_CWD;
    // Create the live session now (buffered with a no-op emit) and park it; the client
    // attaches over WS in the next step and adopts this same PiSession. It lands on disk
    // normally once its first message completes.
    const pi = await PiSession.create(cwd, () => {});
    const st = pi.state();
    const timer = setTimeout(() => reclaimPending(st.sessionId), PENDING_TTL_MS);
    pending.set(st.sessionId, { pi, timer });
    return { sessionId: st.sessionId, cwd: st.cwd };
  });

  fastify.get("/ws", { websocket: true }, async (socket: WebSocket, req) => {
    const send = (e: ServerEvent) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(e));
    };

    const token = tokenFromRequest(req.url, req.headers.authorization);
    if (!tokenValid(token)) {
      send({ type: "error", message: "unauthorized", code: "unauthorized" });
      socket.close(1008, "unauthorized");
      return;
    }

    const sessionId = new URL(req.url, "http://localhost").searchParams.get("session");
    if (!sessionId) {
      send({ type: "error", message: "missing ?session=<id>", code: "bad_request" });
      socket.close(1008, "bad_request");
      return;
    }

    let pi: PiSession;
    const parked = pending.get(sessionId);
    if (parked) {
      // Adopt the session created by POST /api/sessions: stop the reclaim timer and
      // re-point its event stream at this socket.
      clearTimeout(parked.timer);
      pending.delete(sessionId);
      pi = parked.pi;
      pi.setEmit(send);
    } else {
      const sessionFile = await resolveSessionFile(sessionId);
      if (!sessionFile) {
        send({ type: "error", message: `session not found: ${sessionId}`, code: "not_found" });
        socket.close(1008, "not_found");
        return;
      }
      try {
        const summary = (await listSessions()).find((s) => s.sessionFile === sessionFile)!;
        pi = await PiSession.attach(sessionFile, summary.cwd, send);
      } catch (err) {
        fastify.log.error({ err }, "failed to attach session");
        send({ type: "error", message: `attach failed: ${(err as Error).message}`, code: "attach_failed" });
        socket.close(1011, "attach_failed");
        return;
      }
    }

    // Greet + backfill history + current state so a cold client renders immediately.
    const st = pi.state();
    send({ type: "hello", protocolVersion: PROTOCOL_VERSION, sessionId: st.sessionId, sessionName: st.sessionName, cwd: st.cwd });
    send({ type: "history", messages: pi.history() });
    send({ type: "state", state: st });
    send({ type: "models", models: pi.listModels() });

    socket.on("message", async (raw) => {
      let cmd: ClientCommand;
      try {
        cmd = JSON.parse(raw.toString());
      } catch {
        send({ type: "error", message: "invalid JSON", code: "bad_json" });
        return;
      }
      try {
        await handleCommand(pi, cmd, send);
      } catch (err) {
        send({ type: "error", message: (err as Error).message, code: "command_failed" });
      }
    });

    socket.on("close", () => {
      void pi.dispose();
    });
  });
};

const uiBase = BASE === "/" ? "/" : `${BASE}/`;
// Mount at root: covers RENKU_BASE_URL_PATH="/" and direct (Tailscale) access at the pod port.
await app.register(appRoutes, { uiBase: "/" });
// Mount under the Renku base path too, when there is one (the proxy does not strip it).
if (BASE !== "/") await app.register(appRoutes, { prefix: BASE, uiBase });

async function handleCommand(pi: PiSession, cmd: ClientCommand, send: (e: ServerEvent) => void): Promise<void> {
  switch (cmd.type) {
    case "prompt":
      await pi.prompt(cmd.text);
      break;
    case "steer":
      await pi.steer(cmd.text);
      break;
    case "follow_up":
      await pi.followUp(cmd.text);
      break;
    case "abort":
      await pi.abort();
      break;
    case "approval_response":
      pi.resolveApproval(cmd.id, { value: cmd.value, confirmed: cmd.confirmed, cancelled: cmd.cancelled });
      break;
    case "get_state":
      send({ type: "state", state: pi.state() });
      break;
    case "get_stats":
      send({ type: "stats", stats: pi.stats() });
      break;
    case "list_models":
      send({ type: "models", models: pi.listModels() });
      break;
    case "set_model": {
      const ok = await pi.setModel(cmd.provider, cmd.modelId);
      if (!ok) {
        send({ type: "error", message: `unknown model: ${cmd.provider}/${cmd.modelId}`, code: "unknown_model" });
      } else {
        send({ type: "state", state: pi.state() });
      }
      break;
    }
    case "list_sessions":
      send({ type: "sessions", sessions: await listSessions(cmd.cwd) });
      break;
    case "ping":
      send({ type: "pong" });
      break;
    case "set_thinking_level":
    case "attach":
      // attach is implied by the WS query param in v1; thinking-level switching is TODO.
      send({ type: "error", message: `command not yet supported: ${cmd.type}`, code: "unsupported" });
      break;
    default: {
      const _exhaustive: never = cmd;
      send({ type: "error", message: `unknown command: ${(_exhaustive as any).type}`, code: "unknown_command" });
      break;
    }
  }
}

try {
  await app.listen({ port: PORT, host: HOST });
  app.log.info(
    `pi-bridge listening on ${HOST}:${PORT} (base "${BASE}", auth ${authDisabled() ? "disabled" : "enabled"})`,
  );
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
