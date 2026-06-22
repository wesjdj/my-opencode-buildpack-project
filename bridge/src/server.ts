/**
 * pi-bridge server.
 *
 * Exposes the pi SDK over a small REST + WebSocket surface for the watchOS/iOS clients.
 * Runs inside a Renku session pod and is the session's exposed app; the Renku gateway
 * provides TLS + user auth in front of it.
 *
 *   GET  /healthz                     -> liveness
 *   GET  /api/sessions[?cwd=...]       -> WireSessionSummary[]
 *   WS   /ws?session=<id>&token=<t>    -> attach to a session, stream events, send commands
 */

import Fastify from "fastify";
import websocket from "@fastify/websocket";
import type { WebSocket } from "ws";
import { authDisabled, tokenFromRequest, tokenValid } from "./auth.ts";
import { PiSession } from "./pi-session.ts";
import type { ClientCommand, ServerEvent } from "./protocol.ts";
import { PROTOCOL_VERSION } from "./protocol.ts";
import { listSessions, resolveSessionFile } from "./sessions-index.ts";

const PORT = Number(process.env.PORT ?? process.env.PI_BRIDGE_PORT ?? 8080);
const HOST = process.env.HOST ?? "0.0.0.0";

const app = Fastify({ logger: true });
await app.register(websocket);

app.get("/healthz", async () => ({ ok: true, protocolVersion: PROTOCOL_VERSION, authDisabled: authDisabled() }));

app.get("/api/sessions", async (req, reply) => {
  const token = tokenFromRequest(req.url, req.headers.authorization);
  if (!tokenValid(token)) return reply.code(401).send({ error: "unauthorized" });
  const cwd = (req.query as { cwd?: string }).cwd;
  return listSessions(cwd);
});

app.get("/ws", { websocket: true }, async (socket: WebSocket, req) => {
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

  const sessionFile = await resolveSessionFile(sessionId);
  if (!sessionFile) {
    send({ type: "error", message: `session not found: ${sessionId}`, code: "not_found" });
    socket.close(1008, "not_found");
    return;
  }

  let pi: PiSession;
  try {
    const summary = (await listSessions()).find((s) => s.sessionFile === sessionFile)!;
    pi = await PiSession.attach(sessionFile, summary.cwd, send);
  } catch (err) {
    app.log.error({ err }, "failed to attach session");
    send({ type: "error", message: `attach failed: ${(err as Error).message}`, code: "attach_failed" });
    socket.close(1011, "attach_failed");
    return;
  }

  // Greet + backfill history + current state so a cold client renders immediately.
  const st = pi.state();
  send({ type: "hello", protocolVersion: PROTOCOL_VERSION, sessionId: st.sessionId, sessionName: st.sessionName, cwd: st.cwd });
  send({ type: "history", messages: pi.history() });
  send({ type: "state", state: st });

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
    case "list_sessions":
      send({ type: "sessions", sessions: await listSessions(cmd.cwd) });
      break;
    case "ping":
      send({ type: "pong" });
      break;
    case "set_model":
    case "set_thinking_level":
    case "attach":
      // attach is implied by the WS query param in v1; model/thinking switching is TODO.
      send({ type: "error", message: `command not yet supported: ${cmd.type}`, code: "unsupported" });
      break;
  }
}

try {
  await app.listen({ port: PORT, host: HOST });
  app.log.info(`pi-bridge listening on ${HOST}:${PORT} (auth ${authDisabled() ? "disabled" : "enabled"})`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
