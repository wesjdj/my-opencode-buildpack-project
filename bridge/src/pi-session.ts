/**
 * PiSession — wraps the pi SDK for one attached session and translates its event
 * stream into the bridge wire protocol.
 *
 * This is the only file that touches the pre-1.0 SDK internals; the rest of the bridge
 * speaks `protocol.ts`. Verified against @earendil-works/pi-coding-agent@0.79.6.
 */

import { randomUUID } from "node:crypto";
import {
  type AgentSessionEvent,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionUIContext,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type {
  ServerEvent,
  WireCommand,
  WireImage,
  WireMessage,
  WireModel,
  WireState,
  WireStats,
  WireToolCall,
} from "./protocol.ts";

/** pi's reasoning-effort levels (SDK `ThinkingLevel`). */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

type Emit = (event: ServerEvent) => void;

/** A pending approval awaiting the client's `approval_response`. */
interface PendingApproval {
  resolve: (value: unknown) => void;
  /** Shape the raw client response into what the SDK dialog method expects. */
  finish: (r: { value?: string; confirmed?: boolean; cancelled?: boolean }) => unknown;
}

export class PiSession {
  private runtime!: AgentSessionRuntime;
  private unsubscribe?: () => void;
  /** Id of the assistant message currently streaming, for delta correlation. */
  private streamingMessageId?: string;
  private readonly pendingApprovals = new Map<string, PendingApproval>();

  private constructor(private emit: Emit) {}

  /** Re-point this session's event stream (used when a parked new session is adopted by a WS). */
  setEmit(emit: Emit): void {
    this.emit = emit;
  }

  sessionId(): string {
    return this.session.sessionId;
  }

  /** Attach to an existing session file. */
  static async attach(sessionFile: string, cwd: string, emit: Emit): Promise<PiSession> {
    const self = new PiSession(emit);
    await self.initRuntime(cwd);
    await self.runtime.switchSession(sessionFile);
    await self.bind();
    return self;
  }

  /** Start a brand-new pi session in `cwd` (file is persisted on first message). */
  static async create(cwd: string, emit: Emit): Promise<PiSession> {
    const self = new PiSession(emit);
    await self.initRuntime(cwd);
    // The runtime starts with an initial session; force a guaranteed-fresh one.
    await self.runtime.newSession();
    await self.bind();
    return self;
  }

  /** Build the runtime (shared by attach/create). Leaves the active session unbound. */
  private async initRuntime(cwd: string): Promise<void> {
    const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd: rtCwd, sessionManager, sessionStartEvent }) => {
      const services = await createAgentSessionServices({ cwd: rtCwd });
      const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent });
      return { ...result, services, diagnostics: services.diagnostics };
    };
    this.runtime = await createAgentSessionRuntime(createRuntime, {
      cwd,
      agentDir: getAgentDir(),
      sessionManager: SessionManager.create(cwd),
    });
  }

  /** Bind the UI context (for approvals) and subscribe to events on the current session. */
  private async bind(): Promise<void> {
    await this.session.bindExtensions({ uiContext: this.makeUIContext(), mode: "rpc" });
    this.unsubscribe = this.session.subscribe((e) => this.onEvent(e));
  }

  private get session() {
    return this.runtime.session;
  }

  /* ------------------------------------------------------------------ *
   * Commands (driven by the WS connection)
   * ------------------------------------------------------------------ */

  async prompt(text: string, images?: WireImage[]): Promise<void> {
    const imgs = toImageContent(images);
    if (this.session.isStreaming) {
      // Mid-turn steering is text-only; attachments only make sense when opening a turn.
      await this.session.steer(text);
    } else {
      await this.session.prompt(text, imgs ? { images: imgs } : undefined);
    }
  }

  /** Set the reasoning-effort level. Returns false for an unknown level. */
  async setThinkingLevel(level: string): Promise<boolean> {
    if (!(THINKING_LEVELS as readonly string[]).includes(level)) return false;
    await (this.session as { setThinkingLevel(l: string): Promise<void> | void }).setThinkingLevel(level);
    return true;
  }

  /** Slash commands the agent exposes (best-effort; empty if the SDK build has none). */
  async getCommands(): Promise<WireCommand[]> {
    const fn = (this.session as { getCommands?: () => unknown }).getCommands;
    if (typeof fn !== "function") return [];
    try {
      const res = await fn.call(this.session);
      const arr = Array.isArray(res) ? (res as any[]) : [];
      return arr
        .map((c) => ({ name: String(c?.name ?? c?.command ?? ""), description: c?.description ?? c?.summary ?? "" }))
        .filter((c) => c.name);
    } catch {
      return [];
    }
  }

  steer(text: string) {
    return this.session.steer(text);
  }
  followUp(text: string) {
    return this.session.followUp(text);
  }
  abort() {
    return this.session.abort();
  }

  /** All models pi knows about (built-in + custom from models.json). */
  listModels(): WireModel[] {
    const all = (this.session.modelRegistry.getAll() ?? []) as any[];
    return all.map((m) => ({ provider: m.provider, id: m.id, name: m.name ?? m.id }));
  }

  /** Switch the active model. Returns false if no model matches provider+id. */
  async setModel(provider: string, modelId: string): Promise<boolean> {
    const model = this.session.modelRegistry.find(provider, modelId);
    if (!model) return false;
    await this.session.setModel(model);
    return true;
  }

  resolveApproval(id: string, r: { value?: string; confirmed?: boolean; cancelled?: boolean }): boolean {
    const pending = this.pendingApprovals.get(id);
    if (!pending) return false;
    this.pendingApprovals.delete(id);
    pending.resolve(pending.finish(r));
    return true;
  }

  history(): WireMessage[] {
    return this.session.messages.map((m) => toWireMessage(m));
  }

  state(): WireState {
    const s = this.session;
    const m = s.model;
    return {
      sessionId: s.sessionId,
      sessionName: s.sessionName,
      cwd: this.runtime.cwd,
      model: m ? { provider: (m as any).provider, id: (m as any).id, name: (m as any).name } : undefined,
      thinkingLevel: String(s.thinkingLevel),
      isStreaming: s.isStreaming,
      isCompacting: s.isCompacting,
      messageCount: s.messages.length,
      pendingSteering: 0,
      pendingFollowUp: 0,
    };
  }

  stats(): WireStats {
    const st = this.session.getSessionStats();
    const ctx = st.contextUsage;
    return {
      tokensTotal: st.tokens.total,
      cost: st.cost,
      contextTokens: ctx?.tokens ?? null,
      contextWindow: ctx?.contextWindow ?? null,
      contextPercent: ctx?.percent ?? null,
    };
  }

  async dispose(): Promise<void> {
    this.unsubscribe?.();
    for (const [, p] of this.pendingApprovals) p.resolve(p.finish({ cancelled: true }));
    this.pendingApprovals.clear();
    await this.runtime.dispose();
  }

  /* ------------------------------------------------------------------ *
   * Approval bridge: ExtensionUIContext dialog methods -> WS round-trip
   * ------------------------------------------------------------------ */

  private makeUIContext(): ExtensionUIContext {
    const ask = <T>(
      req: Extract<ServerEvent, { type: "approval_request" }>,
      finish: PendingApproval["finish"],
    ): Promise<T> =>
      new Promise<T>((resolve) => {
        this.pendingApprovals.set(req.id, { resolve: resolve as (v: unknown) => void, finish });
        this.emit(req);
      });

    const noop = () => {};
    type Opts = { timeout?: number } | undefined;
    return {
      select: (title: string, options: string[], opts?: Opts) =>
        ask<string | undefined>(
          { type: "approval_request", id: randomUUID(), method: "select", title, options, timeoutMs: opts?.timeout },
          (r) => (r.cancelled ? undefined : r.value),
        ),
      confirm: (title: string, message: string, opts?: Opts) =>
        ask<boolean>(
          { type: "approval_request", id: randomUUID(), method: "confirm", title, message, timeoutMs: opts?.timeout },
          (r) => (r.cancelled ? false : !!r.confirmed),
        ),
      input: (title: string, placeholder?: string, opts?: Opts) =>
        ask<string | undefined>(
          { type: "approval_request", id: randomUUID(), method: "input", title, placeholder, timeoutMs: opts?.timeout },
          (r) => (r.cancelled ? undefined : r.value),
        ),
      notify: (message: string, type?: "info" | "warning" | "error") =>
        this.emit({ type: "notify", message, level: type ?? "info" }),
      // TUI-only / decorative methods are safe no-ops in a headless bridge.
      onTerminalInput: () => noop,
      setStatus: noop,
      setWorkingMessage: noop,
      setWorkingVisible: noop,
      setWorkingIndicator: noop,
      setHiddenThinkingLabel: noop,
      setWidget: noop,
      setFooter: noop,
      setHeader: noop,
      setTitle: noop,
      custom: () => undefined as any,
      getEditorText: () => "",
      setEditorText: noop,
      pasteToEditor: noop,
      getToolsExpanded: () => false,
      setToolsExpanded: noop,
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false, error: "unsupported in bridge" }),
      setEditorComponent: noop,
    } as unknown as ExtensionUIContext;
  }

  /* ------------------------------------------------------------------ *
   * Event translation: AgentSessionEvent -> ServerEvent
   * ------------------------------------------------------------------ */

  private onEvent(e: AgentSessionEvent): void {
    switch (e.type) {
      case "agent_start":
        this.emit({ type: "agent_start" });
        break;
      case "agent_end":
        this.streamingMessageId = undefined;
        this.emit({ type: "agent_end", willRetry: (e as any).willRetry ?? false });
        break;
      case "turn_end":
        this.emit({ type: "turn_end" });
        break;
      case "message_start": {
        const id = randomUUID();
        this.streamingMessageId = id;
        const msg = toWireMessage((e as any).message, id);
        this.emit({ type: "message_start", message: msg });
        break;
      }
      case "message_update": {
        const ev = (e as any).assistantMessageEvent;
        const id = this.streamingMessageId ?? randomUUID();
        if (ev?.type === "text_delta") this.emit({ type: "message_delta", messageId: id, kind: "text", delta: ev.delta });
        else if (ev?.type === "thinking_delta")
          this.emit({ type: "message_delta", messageId: id, kind: "thinking", delta: ev.delta });
        break;
      }
      case "message_end": {
        const id = this.streamingMessageId ?? randomUUID();
        this.emit({ type: "message_end", message: toWireMessage((e as any).message, id) });
        break;
      }
      case "tool_execution_start":
        this.emit({
          type: "tool_start",
          messageId: this.streamingMessageId ?? "",
          toolCallId: (e as any).toolCallId,
          toolName: (e as any).toolName,
          argsPreview: previewArgs((e as any).args),
        });
        break;
      case "tool_execution_update":
        this.emit({
          type: "tool_update",
          toolCallId: (e as any).toolCallId,
          partialText: extractToolText((e as any).partialResult),
        });
        break;
      case "tool_execution_end":
        this.emit({
          type: "tool_end",
          toolCallId: (e as any).toolCallId,
          toolName: (e as any).toolName,
          text: extractToolText((e as any).result),
          isError: !!(e as any).isError,
        });
        break;
      case "queue_update":
        this.emit({ type: "queue_update", steering: [...(e as any).steering], followUp: [...(e as any).followUp] });
        break;
      case "compaction_start":
        this.emit({ type: "compaction_start", reason: (e as any).reason });
        break;
      case "compaction_end":
        this.emit({ type: "compaction_end", reason: (e as any).reason, aborted: !!(e as any).aborted });
        break;
      default:
        // agent_start/turn_start and other lifecycle events we don't surface.
        break;
    }
  }
}

/* ------------------------------------------------------------------ *
 * Structural helpers (resilient to sub-package type drift)
 * ------------------------------------------------------------------ */

/** WireImage[] -> SDK ImageContent[] ({ type:'image', data, mime_type }). */
function toImageContent(images?: WireImage[]): any[] | undefined {
  if (!images?.length) return undefined;
  return images.map((im) => ({ type: "image", data: im.data, mime_type: im.mimeType }));
}

function blocksOf(content: unknown): any[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) return content;
  return [];
}

function toWireMessage(m: any, id?: string): WireMessage {
  const role = m?.role ?? "system";
  const wire: WireMessage = {
    id: id ?? randomUUID(),
    role: normalizeRole(role),
    text: "",
    timestamp: m?.timestamp ?? Date.now(),
  };

  if (role === "toolResult") {
    wire.text = blocksOf(m.content)
      .filter((b) => b?.type === "text")
      .map((b) => b.text)
      .join("");
    wire.toolResult = { toolCallId: m.toolCallId, toolName: m.toolName, text: wire.text, isError: !!m.isError };
    return wire;
  }

  if (role === "bashExecution") {
    wire.text = m.output ?? "";
    return wire;
  }

  const texts: string[] = [];
  const thinking: string[] = [];
  const toolCalls: WireToolCall[] = [];
  for (const b of blocksOf(m?.content)) {
    if (b?.type === "text") texts.push(b.text ?? "");
    else if (b?.type === "thinking") thinking.push(b.thinking ?? "");
    else if (b?.type === "toolCall") toolCalls.push({ id: b.id, name: b.name, argsPreview: previewArgs(b.arguments) });
  }
  wire.text = texts.join("");
  if (thinking.length) wire.thinking = thinking.join("");
  if (toolCalls.length) wire.toolCalls = toolCalls;
  if (m?.model) wire.model = m.model;
  return wire;
}

function normalizeRole(role: string): WireMessage["role"] {
  switch (role) {
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "toolResult":
      return "tool";
    case "bashExecution":
      return "bash";
    default:
      return "system";
  }
}

function previewArgs(args: unknown): string {
  try {
    const s = JSON.stringify(args ?? {});
    return s.length > 240 ? s.slice(0, 240) + "…" : s;
  } catch {
    return "";
  }
}

function extractToolText(result: any): string {
  const content = result?.content;
  if (!content) return "";
  return blocksOf(content)
    .filter((b) => b?.type === "text")
    .map((b) => b.text)
    .join("");
}
