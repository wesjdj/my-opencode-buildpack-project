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
 * Markdown — a deliberately small, SAFE renderer (no deps).
 * Strategy: HTML-escape everything first, THEN layer a known-safe subset of
 * markdown on top. Because the source is escaped before any tag is inserted,
 * model output can never inject live HTML; the only attributes we emit are
 * http(s) hrefs that we validate. Covers code fences, inline code, headings,
 * lists, emphasis, links, and paragraphs — enough for agent responses.
 * ------------------------------------------------------------------ */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

function renderInline(escaped) {
  return escaped
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      (_, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`,
    )
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>");
}

function renderMarkdown(src) {
  const lines = String(src).split("\n");
  let html = "";
  let i = 0;
  let list = null; // "ul" | "ol"
  const closeList = () => {
    if (list) {
      html += `</${list}>`;
      list = null;
    }
  };

  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^```(\w+)?\s*$/);
    if (fence) {
      closeList();
      const buf = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) buf.push(lines[i++]);
      i++; // closing fence
      html += `<pre class="code"><code>${escapeHtml(buf.join("\n"))}</code></pre>`;
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeList();
      const lvl = h[1].length;
      html += `<h${lvl}>${renderInline(escapeHtml(h[2]))}</h${lvl}>`;
      i++;
      continue;
    }
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ul || ol) {
      const want = ul ? "ul" : "ol";
      if (list !== want) {
        closeList();
        html += `<${want}>`;
        list = want;
      }
      html += `<li>${renderInline(escapeHtml((ul || ol)[1]))}</li>`;
      i++;
      continue;
    }
    if (/^\s*$/.test(line)) {
      closeList();
      i++;
      continue;
    }
    // paragraph: gather consecutive plain lines
    closeList();
    const para = [line];
    i++;
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^```/.test(lines[i]) &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !/^\s*(?:[-*]|\d+\.)\s/.test(lines[i])
    ) {
      para.push(lines[i++]);
    }
    html += `<p>${renderInline(escapeHtml(para.join("\n"))).replace(/\n/g, "<br>")}</p>`;
  }
  closeList();
  return html;
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
const sessionCount = $("session-count");
const transcript = $("transcript");
const input = $("input");
const composer = $("composer");
const btnSend = $("btn-send");
const btnAbort = $("btn-abort");
const btnNew = $("btn-new");
const btnRefresh = $("btn-refresh");
const statusPill = $("status-pill");
const statusText = $("status-text");
const sessionTitle = $("session-title");
const sessionSub = $("session-sub");
const modelPill = $("model-pill");
const thinkingPill = $("thinking-pill");
const btnAttach = $("btn-attach");
const fileInput = $("file-input");
const attachmentsEl = $("attachments");
const acMenu = $("ac-menu");
const statTokens = $("stat-tokens");
const statContext = $("stat-context");
const statCost = $("stat-cost");

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */
const state = {
  sessions: [],
  activeId: null,
  ws: null,
  connected: false,
  streaming: false,
  current: null, // WireState
  models: [], // WireModel[]
  commands: null, // WireCommand[] | null (null = not yet loaded)
  attachments: [], // { data, mimeType, name }
  msgNodes: new Map(), // messageId -> { wrap, thinkingEl, textEl, raw }
  toolNodes: new Map(), // toolCallId -> { root, summary, body }
};

function nearBottom() {
  return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 120;
}
function scrollToBottom(force) {
  if (force || nearBottom()) transcript.scrollTop = transcript.scrollHeight;
}

function setStatus(kind, label) {
  statusPill.className = kind;
  statusText.textContent = label;
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
  sessionCount.textContent = String(state.sessions.length);
  sidebarList.replaceChildren();
  if (state.sessions.length === 0) {
    sidebarList.appendChild(el("li", "empty-item", "No sessions yet"));
    return;
  }
  for (const s of state.sessions) {
    const li = el("li");
    if (s.id === state.activeId) li.classList.add("active");
    li.append(
      el("span", "s-name", s.name || s.project || s.id.slice(0, 8)),
      el("span", "s-sub", `${s.project} · ${s.messageCount} msg`),
    );
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
  state.connected = false;
  state.msgNodes.clear();
  state.toolNodes.clear();
  transcript.replaceChildren();
  renderSessionList();
  setStatus("connecting", "connecting…");

  const ws = new WebSocket(wsUrl(sessionId));
  state.ws = ws;

  ws.onopen = () => {
    state.connected = true;
    setStatus("connected", "idle");
  };
  ws.onclose = () => {
    if (state.ws === ws) {
      state.connected = false;
      setStatus("disconnected", "disconnected");
      setComposerEnabled(false);
    }
  };
  ws.onerror = () => setStatus("disconnected", "connection error");
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
      // The "history" event (sent right after) populates the transcript + header.
      sessionTitle.textContent = e.sessionName || e.sessionId.slice(0, 12);
      setComposerEnabled(true);
      send({ type: "get_stats" });
      send({ type: "list_commands" });
      break;
    case "history":
      transcript.replaceChildren(el("div", "transcript-head", "Beginning of session"));
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
      state.models = e.models || [];
      break;
    case "commands":
      state.commands = e.commands || [];
      // If the user is mid-"/" typing, refresh the menu now that we have data.
      if (document.activeElement === input) updateAutocomplete();
      break;
    case "agent_start":
      setStreaming(true);
      break;
    case "agent_end":
    case "turn_end":
      setStreaming(false);
      send({ type: "get_stats" });
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
      break;
    case "approval_request":
      renderApproval(e);
      break;
    case "compaction_start":
      setStatus("streaming", "compacting…");
      break;
    case "compaction_end":
      setStatus(state.streaming ? "streaming" : "connected", state.streaming ? "streaming…" : "idle");
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
const ROLE_LABEL = { user: "You", assistant: "pi", system: "system", bash: "bash", tool: "tool" };

function makeBubble(role) {
  const wrap = el("div", `msg ${role}`);
  const head = el("div", "msg-head");
  head.appendChild(el("span", "who", ROLE_LABEL[role] || role));
  const copy = el("button", "copy", "copy");
  copy.type = "button";
  head.appendChild(copy);
  const thinkingEl = el("div", "thinking");
  thinkingEl.hidden = true;
  const bubble = el("div", "bubble");
  const textEl = el("div");
  bubble.appendChild(textEl);
  wrap.append(head, thinkingEl, bubble);
  transcript.appendChild(wrap);

  const node = { wrap, thinkingEl, bubble, textEl, raw: "" };
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(node.raw);
      copy.textContent = "copied";
      setTimeout(() => (copy.textContent = "copy"), 1200);
    } catch {
      /* clipboard blocked */
    }
  });
  return node;
}

function setBubbleMarkdown(node, text) {
  node.raw = text || "";
  node.wrap.classList.remove("streaming");
  node.textEl.innerHTML = renderMarkdown(node.raw);
}

function renderHistoryMessage(m) {
  if (m.role === "tool") {
    if (m.toolResult) renderToolResultBlock(m.toolResult.toolName, m.toolResult.text, m.toolResult.isError);
    return;
  }
  const node = makeBubble(m.role);
  if (m.thinking) {
    node.thinkingEl.hidden = false;
    node.thinkingEl.textContent = m.thinking;
  }
  setBubbleMarkdown(node, m.text || "");
  if (Array.isArray(m.toolCalls)) {
    for (const tc of m.toolCalls) renderToolCallBlock(tc.name, tc.argsPreview, "");
  }
}

function startMessage(m) {
  // The user's own messages are rendered optimistically on submit (single source of truth
  // for live input). The bridge also echoes them back as message_start/message_end events;
  // ignore that echo here so the message isn't painted twice. History reload is a separate
  // path (renderHistoryMessage) and still shows user messages correctly.
  if (m.role === "user") return;
  const node = makeBubble(m.role || "assistant");
  // While streaming, render as plain pre-wrap text (cheap); finalize to markdown on end.
  node.wrap.classList.add("streaming");
  node.raw = m.text || "";
  node.textEl.textContent = node.raw;
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
    node.wrap.classList.add("streaming");
    state.msgNodes.set(messageId, node);
  }
  if (kind === "thinking") {
    node.thinkingEl.hidden = false;
    node.thinkingEl.textContent += delta;
  } else {
    node.raw += delta;
    node.textEl.textContent = node.raw;
  }
  scrollToBottom();
}

function endMessage(m) {
  if (m.role === "user") return; // see startMessage: user echoes are rendered optimistically
  const node = state.msgNodes.get(m.id);
  if (!node) {
    renderHistoryMessage(m);
    return;
  }
  setBubbleMarkdown(node, m.text || node.raw);
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
  state.toolNodes.set(e.toolCallId, renderToolCallBlock(e.toolName, e.argsPreview, ""));
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

  const opts = el("div", "opts");
  if (req.method === "input") {
    const field = el("input");
    field.type = "text";
    if (req.placeholder) field.placeholder = req.placeholder;
    card.append(field);
    const submit = el("button", "", "Submit");
    submit.addEventListener("click", () => finish({ value: field.value }));
    const cancel = el("button", "", "Cancel");
    cancel.addEventListener("click", () => finish({ cancelled: true }));
    opts.append(submit, cancel);
  } else if (req.method === "confirm") {
    const yes = el("button", "", "Yes");
    yes.addEventListener("click", () => finish({ confirmed: true }));
    const no = el("button", "", "No");
    no.addEventListener("click", () => finish({ confirmed: false }));
    opts.append(yes, no);
  } else {
    for (const option of req.options || []) {
      const b = el("button", "", option);
      b.addEventListener("click", () => finish({ value: option }));
      opts.append(b);
    }
  }
  card.append(opts);
  transcript.appendChild(card);
  scrollToBottom(true);
}

/* ------------------------------------------------------------------ *
 * Notifications + state + stats
 * ------------------------------------------------------------------ */
function notify(message, level) {
  const node = makeBubble("system");
  node.wrap.querySelector(".who").textContent = level || "info";
  setBubbleMarkdown(node, message);
  if (level === "error") node.bubble.style.borderColor = "var(--danger)";
  if (level === "warning") node.bubble.style.borderColor = "var(--warn)";
  scrollToBottom();
}

function applyState(s) {
  state.current = s;
  setStreaming(s.isStreaming);
  if (s.sessionName) sessionTitle.textContent = s.sessionName;
  modelPill.textContent = s.model ? `${s.model.provider}/${s.model.name}` : "—";
  thinkingPill.textContent = `🧠 ${s.thinkingLevel || "?"}`;
  const sub = [];
  if (s.pendingSteering) sub.push(`${s.pendingSteering} steering`);
  if (s.pendingFollowUp) sub.push(`${s.pendingFollowUp} queued`);
  sub.push(s.cwd);
  sessionSub.textContent = sub.join("  ·  ");
}

function renderStats(stats) {
  statTokens.textContent = `${stats.tokensTotal.toLocaleString()} tok`;
  statContext.textContent = stats.contextPercent != null ? `context ${Math.round(stats.contextPercent)}%` : "";
  statCost.textContent = `$${stats.cost.toFixed(4)}`;
}

/* ------------------------------------------------------------------ *
 * Composer
 * ------------------------------------------------------------------ */
function setComposerEnabled(on) {
  input.disabled = !on;
  btnSend.disabled = !on;
  input.placeholder = on
    ? "Message pi…  (Enter to send, Shift+Enter for newline)"
    : "Select or create a session…";
  if (on) input.focus();
}

function setStreaming(on) {
  state.streaming = on;
  btnAbort.hidden = !on;
  btnSend.title = on ? "Steer the running turn" : "Send (Enter)";
  if (state.connected) setStatus(on ? "streaming" : "connected", on ? "streaming…" : "idle");
}

/* ---- Popover menu (model + thinking pickers) ---- */
let menuEl = null;
function closeMenu() {
  if (menuEl) {
    menuEl.remove();
    menuEl = null;
    document.removeEventListener("click", onDocClick, true);
  }
}
function onDocClick(ev) {
  if (menuEl && !menuEl.contains(ev.target)) closeMenu();
}
function openMenu(anchor, items, onPick) {
  closeMenu();
  const menu = el("div", "menu");
  for (const it of items) {
    const row = el("div", "menu-item" + (it.active ? " active" : ""));
    row.append(el("span", "mi-label", it.label));
    if (it.sub) row.append(el("span", "mi-sub", it.sub));
    row.addEventListener("click", () => {
      closeMenu();
      onPick(it);
    });
    menu.appendChild(row);
  }
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${r.left}px`;
  menu.style.bottom = `${window.innerHeight - r.top + 6}px`;
  document.body.appendChild(menu);
  menuEl = menu;
  setTimeout(() => document.addEventListener("click", onDocClick, true), 0);
}

modelPill.addEventListener("click", () => {
  if (!state.models.length) {
    send({ type: "list_models" });
    return;
  }
  const cur = state.current?.model;
  openMenu(
    modelPill,
    state.models.map((m) => ({
      label: `${m.provider}/${m.name}`,
      value: m,
      active: cur && cur.provider === m.provider && cur.id === m.id,
    })),
    (it) => send({ type: "set_model", provider: it.value.provider, modelId: it.value.id }),
  );
});

thinkingPill.addEventListener("click", () => {
  const cur = state.current?.thinkingLevel;
  openMenu(
    thinkingPill,
    THINKING_LEVELS.map((l) => ({ label: l, value: l, active: l === cur })),
    (it) => send({ type: "set_thinking_level", level: it.value }),
  );
});

/* ---- Image attachments ---- */
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]); // strip data: prefix
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
function renderAttachments() {
  attachmentsEl.replaceChildren();
  attachmentsEl.hidden = state.attachments.length === 0;
  state.attachments.forEach((a, i) => {
    const chip = el("span", "chip", a.name || a.mimeType);
    const x = el("button", "chip-x", "×");
    x.type = "button";
    x.addEventListener("click", () => {
      state.attachments.splice(i, 1);
      renderAttachments();
    });
    chip.appendChild(x);
    attachmentsEl.appendChild(chip);
  });
}
btnAttach.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", async () => {
  for (const file of fileInput.files) {
    if (!file.type.startsWith("image/")) continue;
    try {
      state.attachments.push({ data: await fileToBase64(file), mimeType: file.type, name: file.name });
    } catch {
      notify(`Could not read ${file.name}`, "error");
    }
  }
  fileInput.value = "";
  renderAttachments();
});

/* ---- Inline autocomplete (@ files, / commands) ---- */
let ac = null; // { items: [{label, sub?, apply()}], index }
let fileTimer = null;
function closeAC() {
  ac = null;
  acMenu.hidden = true;
  acMenu.replaceChildren();
}
function renderAC(items) {
  if (!items.length) {
    closeAC();
    return;
  }
  ac = { items, index: 0 };
  acMenu.replaceChildren();
  items.forEach((it, i) => {
    const row = el("div", "ac-item" + (i === 0 ? " active" : ""));
    row.append(el("span", "ac-label", it.label));
    if (it.sub) row.append(el("span", "ac-sub", it.sub));
    row.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      it.apply();
      closeAC();
    });
    acMenu.appendChild(row);
  });
  acMenu.hidden = false;
}
function moveAC(delta) {
  if (!ac) return;
  ac.index = (ac.index + delta + ac.items.length) % ac.items.length;
  [...acMenu.children].forEach((c, i) => c.classList.toggle("active", i === ac.index));
}
function acceptAC() {
  if (!ac) return false;
  ac.items[ac.index].apply();
  closeAC();
  return true;
}

function updateAutocomplete() {
  if (input.disabled) return closeAC();
  const pos = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, pos);
  const slash = before.match(/^\/([\w:-]*)$/); // only at the very start of the message
  const at = before.match(/(?:^|\s)@([^\s@]*)$/);
  if (slash) showCommandAC(slash[1]);
  else if (at) showFileAC(at[1], pos - at[1].length - 1, pos);
  else closeAC();
}

function showCommandAC(q) {
  if (state.commands == null) {
    send({ type: "list_commands" }); // arrives async; menu refreshes on the "commands" event
    return;
  }
  const ql = q.toLowerCase();
  const matches = state.commands.filter((c) => c.name.toLowerCase().startsWith(ql)).slice(0, 8);
  renderAC(
    matches.map((c) => ({
      label: `/${c.name}`,
      sub: c.description || "",
      apply() {
        input.value = `/${c.name} `;
        input.focus();
        autosize();
      },
    })),
  );
}

function showFileAC(q, start, end) {
  clearTimeout(fileTimer);
  fileTimer = setTimeout(async () => {
    const cwd = state.current?.cwd || "";
    let files = [];
    try {
      files = await apiGet(`api/files?q=${encodeURIComponent(q)}&cwd=${encodeURIComponent(cwd)}`);
    } catch {
      return;
    }
    renderAC(
      files.slice(0, 8).map((f) => ({
        label: f,
        apply() {
          const v = input.value;
          const insert = `@${f} `;
          input.value = v.slice(0, start) + insert + v.slice(end);
          const caret = start + insert.length;
          input.setSelectionRange(caret, caret);
          input.focus();
          autosize();
        },
      })),
    );
  }, 150);
}

/* ---- Send ---- */
composer.addEventListener("submit", (ev) => {
  ev.preventDefault();
  closeAC();
  const text = input.value.trim();
  const images = state.attachments.map((a) => ({ data: a.data, mimeType: a.mimeType }));
  if ((!text && !images.length) || !state.ws) return;

  // Idle → start a turn (prompt, may carry attachments). Mid-stream → steer (text only).
  if (state.streaming) {
    send({ type: "steer", text });
    notify(`↳ steer: ${text}`, "info");
  } else {
    send({ type: "prompt", text, images: images.length ? images : undefined });
    const node = makeBubble("user");
    setBubbleMarkdown(node, images.length ? `${text}\n\n_(${images.length} image attachment(s))_` : text);
    scrollToBottom(true);
  }
  input.value = "";
  state.attachments = [];
  renderAttachments();
  autosize();
});

function autosize() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 220) + "px";
}
input.addEventListener("input", () => {
  autosize();
  updateAutocomplete();
});
input.addEventListener("keydown", (ev) => {
  if (ac) {
    if (ev.key === "ArrowDown") return ev.preventDefault(), moveAC(1);
    if (ev.key === "ArrowUp") return ev.preventDefault(), moveAC(-1);
    if (ev.key === "Enter" || ev.key === "Tab") return ev.preventDefault(), acceptAC();
    if (ev.key === "Escape") return ev.preventDefault(), closeAC();
  }
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
 * View toggles — hide thinking / tool usage
 *
 * Class-driven: each button toggles a class on <body>, and CSS hides every
 * matching node at once (existing, streaming, and future). No re-render, and
 * the underlying content stays in the DOM so toggling back is instant.
 * The choice is persisted in localStorage (best-effort — it can throw in a
 * sandboxed iframe, hence the try/catch).
 * ------------------------------------------------------------------ */
const VIEW_TOGGLES = [
  { btn: "toggle-thinking", cls: "hide-thinking", key: "pi-bridge:hide-thinking" },
  { btn: "toggle-tools", cls: "hide-tools", key: "pi-bridge:hide-tools" },
];
function prefGet(key) {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}
function prefSet(key, hidden) {
  try {
    localStorage.setItem(key, hidden ? "1" : "0");
  } catch {
    /* storage unavailable (sandboxed/private) — toggle still works for the session */
  }
}
for (const t of VIEW_TOGGLES) {
  const btn = $(t.btn);
  if (!btn) continue;
  const apply = (hidden) => {
    document.body.classList.toggle(t.cls, hidden);
    btn.classList.toggle("off", hidden);
    btn.setAttribute("aria-pressed", String(!hidden)); // pressed = content shown
  };
  apply(prefGet(t.key));
  btn.addEventListener("click", () => {
    const hidden = !document.body.classList.contains(t.cls);
    prefSet(t.key, hidden);
    apply(hidden);
  });
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */
(async function boot() {
  setStatus("disconnected", "disconnected");
  await loadSessions();
})();
