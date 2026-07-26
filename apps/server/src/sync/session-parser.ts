import { createHash } from "node:crypto";
import type { ReasoningEffort, ThreadSummary, TimelineItem } from "@codex-control/shared";
import type { LocalThreadSummary } from "../types.js";

export interface ParsedSessionUpdate {
  thread?: Partial<LocalThreadSummary> & Pick<LocalThreadSummary, "id">;
  item?: TimelineItem;
}

interface ParserState {
  threadId: string | null;
  cwd: string;
  model: string | null;
  effort: ReasoningEffort | null;
  turnId: string | null;
  createdAt: string;
  updatedAt: string;
  state: ThreadSummary["state"];
  title: string;
  toolItems: Map<string, TimelineItem>;
  semanticMessages: Set<string>;
}

export class SessionRecordParser {
  readonly #state: ParserState = {
    threadId: null,
    cwd: "",
    model: null,
    effort: null,
    turnId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    state: "idle",
    title: "New task",
    toolItems: new Map(),
    semanticMessages: new Set(),
  };

  parse(line: string): ParsedSessionUpdate[] {
    let record: { timestamp?: string; type?: string; payload?: Record<string, unknown> };
    try {
      record = JSON.parse(line) as typeof record;
    } catch {
      return [];
    }
    const payload = record.payload ?? {};
    const timestamp = validDate(record.timestamp) ?? new Date().toISOString();
    this.#state.updatedAt = timestamp;
    if (record.type === "session_meta") {
      this.#state.threadId = String(payload.id ?? payload.session_id ?? "");
      this.#state.cwd = String(payload.cwd ?? "");
      this.#state.createdAt = validDate(payload.timestamp) ?? timestamp;
      return this.#threadUpdate();
    }
    if (!this.#state.threadId) return [];
    if (record.type === "turn_context") {
      this.#state.turnId = stringOrNull(payload.turn_id);
      this.#state.cwd = String(payload.cwd ?? this.#state.cwd);
      this.#state.model = stringOrNull(payload.model);
      this.#state.effort = isEffort(payload.effort) ? payload.effort : null;
      return this.#threadUpdate();
    }
    if (record.type === "event_msg") return this.#parseEvent(payload, timestamp, line);
    if (record.type === "response_item") return this.#parseResponseItem(payload, timestamp, line);
    return [];
  }

  #parseEvent(payload: Record<string, unknown>, timestamp: string, raw: string): ParsedSessionUpdate[] {
    const type = String(payload.type ?? "");
    if (type === "task_started") {
      this.#state.turnId = stringOrNull(payload.turn_id);
      this.#state.state = "running";
      return this.#threadUpdate();
    }
    if (type === "task_complete") {
      this.#state.state = "completed";
      return this.#threadUpdate();
    }
    if (type === "turn_aborted") {
      this.#state.state = "interrupted";
      return this.#threadUpdate();
    }
    if (type === "user_message" || type === "agent_message") {
      const text = String(payload.message ?? "");
      if (!text) return [];
      const role = type === "user_message" ? "user-message" : "agent-message";
      const semantic = `${role}:${this.#state.turnId}:${text}`;
      if (this.#state.semanticMessages.has(semantic)) return [];
      this.#state.semanticMessages.add(semantic);
      if (role === "user-message" && this.#state.title === "New task") this.#state.title = text.slice(0, 100);
      return [
        ...this.#threadUpdate(),
        { item: this.#item(raw, timestamp, role, text, type === "agent_message" ? phase(payload.phase) : undefined) },
      ];
    }
    if (type === "agent_reasoning") {
      const text = String(payload.text ?? "");
      return text ? [{ item: this.#item(raw, timestamp, "reasoning", text) }] : [];
    }
    return [];
  }

  #parseResponseItem(payload: Record<string, unknown>, timestamp: string, raw: string): ParsedSessionUpdate[] {
    const type = String(payload.type ?? "");
    if (type === "message") {
      const role = String(payload.role ?? "");
      const text = extractContent(payload.content);
      if (!text || (role !== "user" && role !== "assistant")) return [];
      const kind = role === "user" ? "user-message" : "agent-message";
      const semantic = `${kind}:${this.#state.turnId}:${text}`;
      if (this.#state.semanticMessages.has(semantic)) return [];
      this.#state.semanticMessages.add(semantic);
      return [{ item: this.#item(raw, timestamp, kind, text, phase(payload.phase)) }];
    }
    if (type === "function_call" || type === "custom_tool_call") {
      const callId = String(payload.call_id ?? payload.id ?? hash(raw));
      const command = toolCommand(payload);
      const item: TimelineItem = {
        id: callId,
        threadId: this.#state.threadId!,
        turnId: this.#state.turnId,
        kind: command.fileChange ? "file-change" : "command",
        timestamp,
        text: command.text,
        status: "running",
        ...(command.fileChange ? { changes: [] } : { command: command.text }),
      };
      this.#state.toolItems.set(callId, item);
      return [{ item }];
    }
    if (type === "function_call_output" || type === "custom_tool_call_output") {
      const callId = String(payload.call_id ?? payload.id ?? hash(raw));
      const previous = this.#state.toolItems.get(callId);
      if (!previous) return [];
      const output = String(payload.output ?? "");
      const item: TimelineItem = { ...previous, text: output || previous.text, status: inferFailure(output) ? "failed" : "completed" };
      this.#state.toolItems.set(callId, item);
      return [{ item }];
    }
    return [];
  }

  #threadUpdate(): ParsedSessionUpdate[] {
    if (!this.#state.threadId) return [];
    return [{
      thread: {
        id: this.#state.threadId,
        title: this.#state.title,
        cwd: this.#state.cwd,
        projectId: null,
        model: this.#state.model,
        reasoningEffort: this.#state.effort,
        createdAt: this.#state.createdAt,
        updatedAt: this.#state.updatedAt,
        origin: "desktop",
        controlMode: this.#state.state === "running" ? "read-only" : "available-after-completion",
        state: this.#state.state,
        activeTurnId: this.#state.state === "running" ? this.#state.turnId : null,
      },
    }];
  }

  #item(raw: string, timestamp: string, kind: TimelineItem["kind"], text: string, itemPhase?: TimelineItem["phase"]): TimelineItem {
    return {
      id: hash(raw),
      threadId: this.#state.threadId!,
      turnId: this.#state.turnId,
      kind,
      timestamp,
      text,
      ...(itemPhase ? { phase: itemPhase } : {}),
    };
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function validDate(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function isEffort(value: unknown): value is ReasoningEffort {
  return ["none", "minimal", "low", "medium", "high", "xhigh"].includes(String(value));
}

function phase(value: unknown): TimelineItem["phase"] | undefined {
  return value === "commentary" || value === "final" ? value : undefined;
}

function extractContent(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const entry = part as Record<string, unknown>;
      return typeof entry.text === "string" ? entry.text : typeof entry.input_text === "string" ? entry.input_text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function toolCommand(payload: Record<string, unknown>): { text: string; fileChange: boolean } {
  const name = String(payload.name ?? "tool");
  const raw = String(payload.arguments ?? payload.input ?? "");
  let detail = raw;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    detail = String(parsed.command ?? parsed.cmd ?? parsed.patch ?? raw);
  } catch {
    // Keep the opaque tool payload when it is not JSON.
  }
  return { text: detail || name, fileChange: /apply_patch|write|edit|patch/i.test(name) };
}

function inferFailure(output: string): boolean {
  return /exit code[^0-9]*[1-9]|script failed|isError.?true/i.test(output);
}
