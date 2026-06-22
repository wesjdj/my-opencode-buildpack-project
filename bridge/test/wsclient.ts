/**
 * Manual smoke-test client for the bridge.
 *
 * Usage:
 *   node --import tsx test/wsclient.ts                 # list sessions, attach to newest, prompt
 *   node --import tsx test/wsclient.ts <sessionId> "your prompt here"
 *
 * Set PI_BRIDGE_TOKEN to match the server if auth is enabled.
 * Prints streamed deltas inline and auto-approves any approval_request with "Allow"/yes.
 */

import { WebSocket } from "ws";
import type { ServerEvent, WireSessionSummary } from "../src/protocol.ts";

const BASE = process.env.PI_BRIDGE_URL ?? "http://127.0.0.1:8080";
const TOKEN = process.env.PI_BRIDGE_TOKEN;
const auth = TOKEN ? `&token=${encodeURIComponent(TOKEN)}` : "";

const [, , argSession, argPrompt] = process.argv;
const promptText = argPrompt ?? "In one sentence, what is in the current directory?";

async function main() {
  const headers = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : undefined;
  const sessions = (await (await fetch(`${BASE}/api/sessions`, { headers })).json()) as WireSessionSummary[];
  if (!sessions.length) {
    console.error("No pi sessions found under ~/.pi/agent/sessions. Run `pi` once to create one.");
    process.exit(1);
  }
  const sessionId = argSession ?? sessions[0]!.id;
  const chosen = sessions.find((s) => s.id === sessionId) ?? sessions[0]!;
  console.log(`Attaching to session ${chosen.id}  (${chosen.project}, ${chosen.messageCount} msgs)\n`);

  const wsBase = BASE.replace(/^http/, "ws");
  const ws = new WebSocket(`${wsBase}/ws?session=${encodeURIComponent(sessionId)}${auth}`);

  ws.on("open", () => console.error("[ws open]"));
  ws.on("close", (c) => console.error(`\n[ws close ${c}]`));
  ws.on("error", (e) => console.error("[ws error]", e.message));

  let sentPrompt = false;
  ws.on("message", (raw) => {
    const e = JSON.parse(raw.toString()) as ServerEvent;
    switch (e.type) {
      case "hello":
        console.error(`[hello] ${e.sessionName ?? e.sessionId} @ ${e.cwd}`);
        break;
      case "history":
        console.error(`[history] ${e.messages.length} messages`);
        if (!sentPrompt) {
          sentPrompt = true;
          console.error(`\n> ${promptText}\n`);
          ws.send(JSON.stringify({ type: "prompt", text: promptText }));
        }
        break;
      case "message_delta":
        if (e.kind === "text") process.stdout.write(e.delta);
        break;
      case "tool_start":
        console.error(`\n[tool ${e.toolName}] ${e.argsPreview}`);
        break;
      case "tool_end":
        console.error(`[tool ${e.toolName} done${e.isError ? " ERROR" : ""}]`);
        break;
      case "approval_request":
        console.error(`\n[approval] ${e.title} ${e.options ? `(${e.options.join(" / ")})` : ""} -> auto-allow`);
        ws.send(
          JSON.stringify({
            type: "approval_response",
            id: e.id,
            value: e.options?.find((o) => /allow|yes|approve/i.test(o)) ?? e.options?.[0],
            confirmed: true,
          }),
        );
        break;
      case "agent_end":
        console.error(`\n\n[agent_end willRetry=${e.willRetry}]`);
        ws.close();
        break;
      case "error":
        console.error(`[error] ${e.message}`);
        break;
    }
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
