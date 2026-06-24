/**
 * pi-bridge wire protocol.
 *
 * This file is the single source of truth for the messages exchanged between the
 * bridge and the watchOS/iOS clients. The Swift `PiKit` Codable types mirror these
 * shapes 1:1 — keep them in lockstep. We deliberately re-shape the pi SDK's internal
 * events into a small, stable surface so the apps never depend on SDK internals.
 *
 * Transport: one JSON object per WebSocket text frame. `type` discriminates.
 */

export const PROTOCOL_VERSION = 1;

/* ------------------------------------------------------------------ *
 * Shared value types
 * ------------------------------------------------------------------ */

export type Role = "user" | "assistant" | "tool" | "bash" | "system";

export interface WireImage {
  /** base64-encoded image data */
  data: string;
  mimeType: string;
}

/** A render-friendly message. Streaming deltas mutate the assistant message in place. */
export interface WireMessage {
  id: string;
  role: Role;
  /** Concatenated visible text (assistant/user). */
  text: string;
  /** Hidden by default on the watch; surfaced on demand. */
  thinking?: string;
  /** Tool calls attached to an assistant message. */
  toolCalls?: WireToolCall[];
  /** For role === "tool": the tool result this message carries. */
  toolResult?: WireToolResult;
  model?: string;
  timestamp: number;
}

export interface WireToolCall {
  id: string;
  name: string;
  /** Stringified arguments for compact display. */
  argsPreview: string;
}

export interface WireToolResult {
  toolCallId: string;
  toolName: string;
  text: string;
  isError: boolean;
}

export interface WireSessionSummary {
  id: string;
  name?: string;
  cwd: string;
  /** Project basename, for quick scanning on a small screen. */
  project: string;
  messageCount: number;
  updatedAt: number;
  sessionFile: string;
}

export interface WireModel {
  provider: string;
  id: string;
  name: string;
}

/** A slash command the agent exposes (for the composer's `/` menu). */
export interface WireCommand {
  name: string;
  description?: string;
}

export interface WireState {
  sessionId: string;
  sessionName?: string;
  cwd: string;
  model?: WireModel;
  thinkingLevel: string;
  isStreaming: boolean;
  isCompacting: boolean;
  messageCount: number;
  pendingSteering: number;
  pendingFollowUp: number;
}

export interface WireStats {
  tokensTotal: number;
  cost: number;
  contextTokens: number | null;
  contextWindow: number | null;
  contextPercent: number | null;
}

/* ------------------------------------------------------------------ *
 * Client -> Bridge commands
 * ------------------------------------------------------------------ */

export type ClientCommand =
  | { type: "attach"; sessionId: string }
  | { type: "list_sessions"; cwd?: string }
  | { type: "prompt"; text: string; images?: WireImage[]; streamingBehavior?: "steer" | "followUp" }
  | { type: "steer"; text: string }
  | { type: "follow_up"; text: string }
  | { type: "abort" }
  | { type: "set_model"; provider: string; modelId: string }
  | { type: "set_thinking_level"; level: string }
  | { type: "list_models" }
  | { type: "list_commands" }
  | { type: "get_state" }
  | { type: "get_stats" }
  /** Reply to an `approval_request`. Exactly one of value/confirmed/cancelled is meaningful per method. */
  | { type: "approval_response"; id: string; value?: string; confirmed?: boolean; cancelled?: boolean }
  | { type: "ping" };

/* ------------------------------------------------------------------ *
 * Bridge -> Client events
 * ------------------------------------------------------------------ */

export type AssistantDeltaKind = "text" | "thinking";

export type ServerEvent =
  | { type: "hello"; protocolVersion: number; sessionId: string; sessionName?: string; cwd: string }
  | { type: "sessions"; sessions: WireSessionSummary[] }
  | { type: "history"; messages: WireMessage[] }
  | { type: "state"; state: WireState }
  | { type: "stats"; stats: WireStats }
  | { type: "models"; models: WireModel[] }
  | { type: "commands"; commands: WireCommand[] }
  | { type: "agent_start" }
  | { type: "agent_end"; willRetry: boolean }
  | { type: "turn_end" }
  | { type: "message_start"; message: WireMessage }
  | { type: "message_delta"; messageId: string; kind: AssistantDeltaKind; delta: string }
  | { type: "message_end"; message: WireMessage }
  | { type: "tool_start"; messageId: string; toolCallId: string; toolName: string; argsPreview: string }
  | { type: "tool_update"; toolCallId: string; partialText: string }
  | { type: "tool_end"; toolCallId: string; toolName: string; text: string; isError: boolean }
  | { type: "queue_update"; steering: string[]; followUp: string[] }
  | { type: "compaction_start"; reason: string }
  | { type: "compaction_end"; reason: string; aborted: boolean }
  | {
      type: "approval_request";
      id: string;
      method: "select" | "confirm" | "input";
      title: string;
      message?: string;
      options?: string[];
      placeholder?: string;
      timeoutMs?: number;
    }
  | { type: "notify"; message: string; level: "info" | "warning" | "error" }
  | { type: "error"; message: string; code?: string }
  | { type: "pong" };
