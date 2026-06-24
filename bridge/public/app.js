// pi-bridge browser client.
//
// Talks to the same bridge that the iOS/watchOS PiKit clients use:
//   GET  api/sessions            -> list
//   POST api/sessions            -> create
//   WS   ws?session=<id>         -> attach, stream events, send commands
//
// Every URL here is RELATIVE and resolved against document.baseURI, which the server
// sets from RENKU_BASE_URL_PATH via <base href>. That is what lets this UI work behind
// Renku's path-prefix proxy (and unchanged over direct/Tailscale access, where base = "/").
// Do not hardcode "/" or an absolute origin anywhere.

"use strict";

/* ------------------------------------------------------------------ *
 * URL helpers (proxy-safe)
 * ------------------------------------------------------------------ */
const BASE = document.baseURI; // absolute, includes the Renku prefix + trailing slash

// Like code-server in Renku, this UI runs behind the gateway with no app-level auth. An
// optional ?token= is still forwarded for local dev / direct (Tailscale) access where the
// bridge may have PI_BRIDGE_TOKEN set; in a normal Renku session there is no token.
const TOKEN = new URLSearchParams(location.search).get("token") || "";

function authHeaders() {
  return TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};
}

function wsUrl(sessionId) {
  const u = new URL("ws", BASE);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.searchParams.set("session", sessionId);
  if (TOKEN) u.searchParams.set("token", TOKEN);
  return u.toString();
}

async function apiGet(path) {
  const res = await fetch(new URL(path, BASE), { headers: authHeaders() });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}

async function apiPost(path, body) {
  const res = await fetch(new URL(path, BASE), {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}

/* ------------------------------------------------------------------ *
 * DOM refs + small helpers
 * ------------------------------------------------------------------ */
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const sidebarList = $("session-list");
const transcript = $("transcript");
const input = $("input");
const composer = $("composer");
const btnSend = $("btn-send");
const btnAbort = $("btn-abort");
const btnNew = $("btn-new");
const btnRefresh = $("btn-refresh");
const connStatus = $("conn-status");
const sessionTitle = $("session-title");
const sessionMeta = $("session-meta");

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */
const state = {
  sessions: [],
  activeId: null,
  ws: null,
  streaming: false,
  current: null, // WireState
  // live-render bookkeeping
  msgNodes: new Map(), // messageId -> { bubble, thinkingEl, textEl }
  toolNodes: new Map(), // toolCallId -> { body, summary, root }
};

function setConn(status, label) {
  connStatus.className = status;
  connStatus.textContent = label ?? status;
}

function nearBottom() {
  return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 120;
}
function scrollToBottom(force) {
  if (force || nearBottom()) transcript.scrollTop = transcript.scrollHeight;
}

/* ------------------------------------------------------------------ *
 * Session list
 * ------------------------------------------------------------------ */
async function loadSessions() {
  try {
    state.sessions = await apiGet("api/sessions");
  } catch (err) {
    state.sessions = [];
    notify(`Failed to list sessions: ${err.message}`, "error");
  }
  renderSessionList();
}

function renderSessionList() {
  sidebarList.replaceChildren();
  if (state.sessions.length === 0) {
    const li = el("li", "", "No sessions yet — create one.");
    li.style.color = "var(--muted)";
    li.style.cursor = "default";
    sidebarList.appendChild(li);
    return;
  }
  for (const s of state.sessions) {
    const li = el("li");
    if (s.id === state.activeId) li.classList.add("active");
    const name = el("span", "s-name", s.name || s.project || s.id.slice(0, 8));
    const sub = el("span", "s-sub", `${s.project} · ${s.messageCount} msg`);
    li.append(name, sub);
    li.addEventListener("click", () => attach(s.id));
    sidebarList.appendChild(li);
  }
}

/* ------------------------------------------------------------------ *
 * WebSocket attach + event handling
 * ------------------------------------------------------------------ */
function attach(sessionId) {
  if (state.ws) {
    state.ws.onclose = null;
    state.ws.close();
    state.ws = null;
  }
  state.activeId = sessionId;
  state.streaming = false;
  state.msgNodes.clear();
  state.toolNodes.clear();
  transcript.replaceChildren();
  renderSessionList();
  setConn("connecting", "connecting…");

  const ws = new WebSocket(wsUrl(sessionId));
  state.ws = ws;

  ws.onopen = () => setConn("connected", "connected");
  ws.onclose = () => {
    if (state.ws === ws) {
      setConn("disconnected");
      setComposerEnabled(false);
    }
  };
  ws.onerror = () => setConn("disconnected", "connection error");
  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    handleEvent(msg);
  };
}

function send(cmd) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(cmd));
}

function handleEvent(e) {
  switch (e.type) {
    case "hello":
      sessionTitle.textContent = e.sessionName || e.sessionId.slice(0, 12);
      setComposerEnabled(true);
      break;
    case "history":
      transcript.replaceChildren();
      state.msgNodes.clear();
      state.toolNodes.clear();
      for (const m of e.messages) renderHistoryMessage(m);
      scrollToBottom(true);
      break;
    case "state":
      applyState(e.state);
      break;
    case "stats":
      renderStats(e.stats);
      break;
    case "models":
      // models list available for a future model picker; ignored for now.
      break;
    case "agent_start":
      setStreaming(true);
      break;
    case "agent_end":
    case "turn_end":
      setStreaming(false);
      break;
    case "message_start":
      startMessage(e.message);
      break;
    case "message_delta":
      appendDelta(e.messageId, e.kind, e.delta);
      break;
    case "message_end":
      endMessage(e.message);
      break;
    case "tool_start":
      startTool(e);
      break;
    case "tool_update":
      updateTool(e.toolCallId, e.partialText);
      break;
    case "tool_end":
      endTool(e);
      break;
    case "queue_update":
      // reflected via state.pendingSteering/FollowUp; nothing extra to render for now.
      break;
    case "approval_request":
      renderApproval(e);
      break;
    case "compaction_start":
      notify(`Compacting context (${e.reason})…`, "info");
      break;
    case "compaction_end":
      notify(e.aborted ? "Compaction aborted" : "Compaction done", "info");
      break;
    case "notify":
      notify(e.message, e.level);
      break;
    case "error":
      notify(e.message, "error");
      break;
    case "pong":
      break;
  }
}

/* ------------------------------------------------------------------ *
 * Rendering: messages
 * ------------------------------------------------------------------ */
function makeBubble(role) {
  const wrap = el("div", `msg ${role}`);
  wrap.appendChild(el("div", "role", role));
  const thinkingEl = el("div", "thinking");
  thinkingEl.hidden = true;
  const bubble = el("div", "bubble");
  const textEl = el("span");
  bubble.appendChild(textEl);
  wrap.append(thinkingEl, bubble);
  transcript.appendChild(wrap);
  return { wrap, thinkingEl, bubble, textEl };
}

function renderHistoryMessage(m) {
  if (m.role === "tool") {
    if (m.toolResult) {
      renderToolResultBlock(m.toolResult.toolName, m.toolResult.text, m.toolResult.isError);
    }
    return;
  }
  const node = makeBubble(m.role);
  if (m.thinking) {
    node.thinkingEl.hidden = false;
    node.thinkingEl.textContent = m.thinking;
  }
  node.textEl.textContent = m.text || "";
  // Tool calls attached to an assistant message (collapsed; their results arrive as tool msgs).
  if (Array.isArray(m.toolCalls)) {
    for (const tc of m.toolCalls) renderToolCallBlock(tc.name, tc.argsPreview, "");
  }
}

function startMessage(m) {
  const role = m.role || "assistant";
  const node = makeBubble(role);
  node.textEl.textContent = m.text || "";
  if (m.thinking) {
    node.thinkingEl.hidden = false;
    node.thinkingEl.textContent = m.thinking;
  }
  state.msgNodes.set(m.id, node);
  scrollToBottom();
}

function appendDelta(messageId, kind, delta) {
  let node = state.msgNodes.get(messageId);
  if (!node) {
    node = makeBubble("assistant");
    state.msgNodes.set(messageId, node);
  }
  if (kind === "thinking") {
    node.thinkingEl.hidden = false;
    node.thinkingEl.textContent += delta;
  } else {
    node.textEl.textContent += delta;
  }
  scrollToBottom();
}

function endMessage(m) {
  const node = state.msgNodes.get(m.id);
  if (!node) {
    renderHistoryMessage(m);
    return;
  }
  // Reconcile with the authoritative final text.
  node.textEl.textContent = m.text || node.textEl.textContent;
  if (m.thinking) {
    node.thinkingEl.hidden = false;
    node.thinkingEl.textContent = m.thinking;
  }
  scrollToBottom();
}

/* ------------------------------------------------------------------ *
 * Rendering: tools
 * ------------------------------------------------------------------ */
function renderToolCallBlock(name, argsPreview, bodyText) {
  const root = el("details", "tool");
  const summary = el("summary");
  summary.append(document.createTextNode(`🔧 ${name} `));
  summary.appendChild(el("span", "tool-args", argsPreview || ""));
  const body = el("div", "tool-body", bodyText || "");
  root.append(summary, body);
  transcript.appendChild(root);
  return { root, summary, body };
}

function renderToolResultBlock(name, text, isError) {
  const node = renderToolCallBlock(name, "", text);
  if (isError) node.root.classList.add("error");
  return node;
}

function startTool(e) {
  const node = renderToolCallBlock(e.toolName, e.argsPreview, "");
  state.toolNodes.set(e.toolCallId, node);
  scrollToBottom();
}

function updateTool(toolCallId, partialText) {
  const node = state.toolNodes.get(toolCallId);
  if (node) {
    node.body.textContent = partialText;
    scrollToBottom();
  }
}

function endTool(e) {
  let node = state.toolNodes.get(e.toolCallId);
  if (!node) node = renderToolCallBlock(e.toolName, "", "");
  node.body.textContent = e.text || "";
  if (e.isError) node.root.classList.add("error");
  scrollToBottom();
}

/* ------------------------------------------------------------------ *
 * Rendering: approvals
 * ------------------------------------------------------------------ */
function renderApproval(req) {
  const card = el("div", "approval");
  card.append(el("h3", "", req.title || "Approval required"));
  if (req.message) card.append(el("p", "", req.message));

  const finish = (response) => {
    send({ type: "approval_response", id: req.id, ...response });
    card.querySelectorAll("button, input").forEach((n) => (n.disabled = true));
    card.append(el("p", "", "✓ responded"));
  };

  if (req.method === "input") {
    const field = el("input");
    field.type = "text";
    if (req.placeholder) field.placeholder = req.placeholder;
    card.append(field);
    const opts = el("div", "opts");
    const submit = el("button", "", "Submit");
    submit.addEventListener("click", () => finish({ value: field.value }));
    const cancel = el("button", "", "Cancel");
    cancel.addEventListener("click", () => finish({ cancelled: true }));
    opts.append(submit, cancel);
    card.append(opts);
  } else if (req.method === "confirm") {
    const opts = el("div", "opts");
    const yes = el("button", "", "Yes");
    yes.addEventListener("click", () => finish({ confirmed: true }));
    const no = el("button", "", "No");
    no.addEventListener("click", () => finish({ confirmed: false }));
    opts.append(yes, no);
    card.append(opts);
  } else {
    // select
    const opts = el("div", "opts");
    for (const option of req.options || []) {
      const b = el("button", "", option);
      b.addEventListener("click", () => finish({ value: option }));
      opts.append(b);
    }
    card.append(opts);
  }

  transcript.appendChild(card);
  scrollToBottom(true);
}

/* ------------------------------------------------------------------ *
 * Notifications + state + stats
 * ------------------------------------------------------------------ */
function notify(message, level) {
  const n = el("div", "msg system");
  n.appendChild(el("div", "role", level || "info"));
  const bubble = el("div", "bubble", message);
  if (level === "error") bubble.style.borderColor = "var(--danger)";
  if (level === "warning") bubble.style.borderColor = "var(--warn)";
  n.appendChild(bubble);
  transcript.appendChild(n);
  scrollToBottom();
}

function applyState(s) {
  state.current = s;
  setStreaming(s.isStreaming);
  if (s.sessionName) sessionTitle.textContent = s.sessionName;
  const bits = [];
  if (s.model) bits.push(`${s.model.provider}/${s.model.name}`);
  bits.push(`${s.messageCount} msg`);
  if (s.thinkingLevel) bits.push(`thinking: ${s.thinkingLevel}`);
  if (s.pendingSteering) bits.push(`${s.pendingSteering} steering`);
  if (s.pendingFollowUp) bits.push(`${s.pendingFollowUp} queued`);
  sessionMeta.textContent = bits.join("  ·  ");
}

function renderStats(stats) {
  if (!state.current) return;
  const ctx = stats.contextPercent != null ? ` · ctx ${Math.round(stats.contextPercent)}%` : "";
  sessionMeta.textContent += `  ·  ${stats.tokensTotal} tok · $${stats.cost.toFixed(4)}${ctx}`;
}

/* ------------------------------------------------------------------ *
 * Composer
 * ------------------------------------------------------------------ */
function setComposerEnabled(on) {
  input.disabled = !on;
  btnSend.disabled = !on;
  input.placeholder = on ? "Message pi…  (Enter to send, Shift+Enter for newline)" : "Select or create a session…";
  if (on) input.focus();
}

function setStreaming(on) {
  state.streaming = on;
  btnAbort.hidden = !on;
  btnSend.textContent = on ? "Steer" : "Send";
  setConn(on ? "streaming-dot" : "connected", on ? "streaming…" : "connected");
}

composer.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const text = input.value.trim();
  if (!text || !state.ws) return;
  // Idle → start a turn (prompt). Mid-stream → steer the running turn.
  send(state.streaming ? { type: "steer", text } : { type: "prompt", text });
  if (state.streaming) {
    notify(`↳ steer: ${text}`, "info");
  } else {
    const node = makeBubble("user");
    node.textEl.textContent = text;
    scrollToBottom(true);
  }
  input.value = "";
});

input.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && !ev.shiftKey) {
    ev.preventDefault();
    composer.requestSubmit();
  }
});

btnAbort.addEventListener("click", () => send({ type: "abort" }));
btnNew.addEventListener("click", createSession);
btnRefresh.addEventListener("click", loadSessions);

async function createSession() {
  try {
    const { sessionId } = await apiPost("api/sessions", {});
    await loadSessions();
    attach(sessionId);
  } catch (err) {
    notify(`Failed to create session: ${err.message}`, "error");
  }
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */
(async function boot() {
  setConn("disconnected");
  await loadSessions();
})();
