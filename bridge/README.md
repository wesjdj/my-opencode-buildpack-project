# pi-bridge

Host-side bridge that exposes a [pi-agent](https://github.com/earendil-works) session over
WebSocket so clients can drive it. It embeds the pi SDK (`@earendil-works/pi-coding-agent`)
directly — no subprocess parsing. Two clients share one protocol:

- the **watchOS/iOS PiKit** apps in this repo, and
- a **browser chat UI** served from `public/` at the bridge's own origin.

In production this runs **inside a Renku 2.0 session** as the session's exposed app; the
Renku gateway provides TLS + user auth in front of it. It also runs standalone for local dev.

## Serving behind Renku's proxy (base path)

Renku proxies a session under `RENKU_BASE_URL_PATH` (e.g. `/sessions/<id>/`) and **does not
strip** that prefix before forwarding — exactly like JupyterLab's `--ServerApp.base_url`. So
the bridge mounts every route (UI, `/api`, `/ws`) under that base, and **also** at root so
direct access (e.g. over Tailscale, where the pod port is hit without the proxy prefix) keeps
working for the mobile clients. `/healthz` stays unprefixed for k8s liveness probes.

The browser client never hardcodes an origin or `/`: the server injects the base into
`index.html`'s `<base href>`, and `app.js` resolves every fetch/WebSocket URL relative to
`document.baseURI`. That relative-only discipline is what makes it work inside the Renku
iframe — a root-absolute SPA (like upstream pi-web) cannot.

### Browser UI features

- Markdown rendering of messages (safe, escape-first, no deps), collapsible tool calls,
  inline approval cards, copy-per-message, streaming text/thinking, live stats bar.
- **Model picker** and **thinking-level** switch (pills in the composer).
- **Image attachments** (📎 → carried on the next `prompt`).
- **`@` file mentions** — autocomplete over `GET /api/files?q=&cwd=` (session-cwd file index).
- **`/` commands** — the menu lists the extension- and skill-registered commands the agent can
  actually run headless (sourced from the extension runtime; see `pi-session.getCommands`), and
  selecting one dispatches via `prompt("/name")`. TUI-only built-ins (`/settings`, `/compact`, …)
  are intentionally excluded — they're owned by the interactive mode and wouldn't execute here.

### Session persistence

Sessions are kept **running across browser disconnects** (a live registry in `server.ts`,
keyed by sessionId), like pi-web's `sessiond`. Closing the tab or a proxy hiccup no longer
kills a running turn; a reconnect re-adopts the same `PiSession`. A detached session is
reclaimed only after an idle TTL (or a short pending TTL if a created session is never attached).

## What it does

- Lists pi sessions from `~/.pi/agent/sessions/` (`GET /api/sessions`).
- Attaches to one session over WebSocket (`/ws?session=<id>`), backfills history + state,
  then streams live events (assistant text/thinking deltas, tool calls, turn/agent lifecycle).
- Accepts commands: `prompt` (with optional `images`), `steer`, `follow_up`, `abort`,
  `set_model`, `set_thinking_level`, `list_models`, `list_commands`, `get_state`, `get_stats`,
  `list_sessions`.
- **Approvals:** pi's permission prompts (the `pi-permission-system` `edit/write/git → ask`
  config) surface through the SDK `ExtensionUIContext` and are forwarded as `approval_request`
  events; the client replies with `approval_response`. The full N-option permission menu is
  preserved (e.g. *Yes / Yes allow pattern for session / No / No with reason*).

The wire protocol is defined once in [`src/protocol.ts`](src/protocol.ts) and mirrored by the
Swift `PiKit` package. Keep them in lockstep.

## Run locally

```bash
npm install
npm run typecheck          # tsc --noEmit
PORT=8088 npm start        # node --import tsx src/server.ts
```

Smoke test against a real session (uses your configured pi model):

```bash
# create a throwaway session
mkdir -p /tmp/pi-bridge-test && cd /tmp/pi-bridge-test
pi -p -n bridge-smoke "Reply with READY"

# then, from bridge/:
PI_BRIDGE_URL=http://127.0.0.1:8088 \
  node --import tsx test/wsclient.ts <partial-session-id> "list the files here"
```

The test client prints streamed deltas and auto-approves any approval request.

## Config (env)

| Var | Default | Purpose |
|-----|---------|---------|
| `PORT` / `PI_BRIDGE_PORT` / `RENKU_SESSION_PORT` | `8080` | Listen port (the Renku session app port). |
| `HOST` / `RENKU_SESSION_IP` | `0.0.0.0` | Bind address. |
| `RENKU_BASE_URL_PATH` | `/` | Path prefix the session is proxied under. All routes are mounted here (and at root). Set by Renku at runtime. |
| `PI_BRIDGE_TOKEN` | _(unset)_ | Optional shared bearer token checked on `/api/*` and WS upgrade. **Leave unset in Renku** — like code-server (`--auth none`), the gateway authenticates and the app trusts it. Set it only to add a token on the direct (Tailscale) path for the mobile clients; the browser UI then needs `?token=` in the URL. |

## Layout

| File | Role |
|------|------|
| `src/protocol.ts` | Wire types — single source of truth shared with `PiKit`. |
| `src/pi-session.ts` | The only file touching pi SDK internals. Wraps `createAgentSessionRuntime` + `switchSession`, binds `uiContext` for approvals, translates `AgentSessionEvent` → wire events. |
| `src/sessions-index.ts` | Read-only filesystem index of `~/.pi/agent/sessions/`. |
| `src/server.ts` | Fastify REST + `@fastify/websocket`. |
| `src/auth.ts` | Shared-token check (defense in depth behind the gateway). |
| `public/index.html` | Browser UI shell. `<base href="__BASE__">` is templated by the server. |
| `public/app.js` | Vanilla-JS chat client (no build step). All URLs relative to `document.baseURI`. |
| `public/app.css` | UI styles. |
| `test/wsclient.ts` | Manual smoke-test client. |

## Notes

- Pinned to `@earendil-works/pi-coding-agent@0.79.6`; the pre-1.0 runtime APIs are isolated in
  `pi-session.ts`. Pin this to whatever version is baked into the Renku session image.
- Runs via `tsx` (no build step). The session image just needs Node ≥ 20 + `npm install`.
- Image attachments on `prompt` are not wired yet (text only in v1).
