import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type {
  ApprovalSummary,
  ModelSummary,
  ReasoningEffort,
  ServiceStatus,
  ThreadSummary,
  TimelineItem,
} from "@codex-control/shared";
import { EXPECTED_CODEX_VERSION } from "../config.js";
import { EventHub } from "../events.js";
import type { LocalThreadDetail, LocalThreadSummary } from "../types.js";
import { publicThread } from "../types.js";
import { CodexRpcClient, type JsonRpcNotification, type JsonRpcRequest } from "./json-rpc.js";

const execFileAsync = promisify(execFile);

interface CodexThread {
  id: string;
  preview?: string;
  name?: string | null;
  cwd?: string;
  model?: string;
  modelProvider?: string;
  createdAt?: number | string;
  updatedAt?: number | string;
  status?: { type?: string } | string;
  turns?: CodexTurn[];
}

interface CodexTurn {
  id: string;
  status?: string;
  items?: Array<Record<string, unknown>>;
}

interface PendingApproval {
  rpcId: number | string;
  summary: ApprovalSummary;
}

export class CodexController {
  readonly #rpc: CodexRpcClient;
  readonly #pendingApprovals = new Map<string, PendingApproval>();
  readonly #activeTurns = new Map<string, string>();
  readonly #loadedThreads = new Set<string>();
  readonly #ownedThreads = new Set<string>();
  readonly #ownedPath: string;
  #models: ModelSummary[] = [];
  #restartAttempt = 0;
  #restartTimer: NodeJS.Timeout | null = null;
  #stopping = false;
  #status: ServiceStatus["codex"] = "starting";
  #version: string | null = null;

  constructor(
    private readonly command: string,
    dataDir: string,
    private readonly events: EventHub,
    private readonly statusListener: (state: ServiceStatus["codex"], version: string | null, message?: string) => void,
  ) {
    this.#rpc = new CodexRpcClient(this.command);
    this.#ownedPath = join(dataDir, "owned-threads.json");
    this.#rpc.on("notification", (notification: JsonRpcNotification) => this.#handleNotification(notification));
    this.#rpc.on("request", (request: JsonRpcRequest) => this.#handleServerRequest(request));
    this.#rpc.on("close", (error: Error) => this.#handleClose(error));
  }

  get connected(): boolean {
    return this.#status === "connected";
  }

  get models(): ModelSummary[] {
    return this.#models;
  }

  get approvals(): ApprovalSummary[] {
    return [...this.#pendingApprovals.values()].map(({ summary }) => summary);
  }

  isOwnedThread(threadId: string): boolean {
    return this.#ownedThreads.has(threadId);
  }

  activeTurn(threadId: string): string | null {
    return this.#activeTurns.get(threadId) ?? null;
  }

  async start(): Promise<void> {
    this.#stopping = false;
    await mkdir(dirname(this.#ownedPath), { recursive: true }).catch(() => undefined);
    await this.#loadOwnedThreads();
    await this.#connect();
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#restartTimer) clearTimeout(this.#restartTimer);
    this.#restartTimer = null;
    await this.#rpc.stop();
  }

  async listThreads(cwd: string | null = null): Promise<LocalThreadSummary[]> {
    const response = await this.#rpc.request<{ data: CodexThread[] }>("thread/list", {
      cwd,
      archived: false,
      limit: 100,
      sortKey: "updated_at",
      sortDirection: "desc",
      useStateDbOnly: false,
    });
    return response.data.map((thread) => this.#mapThread(thread));
  }

  async readThread(threadId: string): Promise<LocalThreadDetail> {
    const response = await this.#rpc.request<{ thread: CodexThread }>("thread/read", { threadId, includeTurns: true });
    const summary = this.#mapThread(response.thread);
    return { ...summary, items: mapTurns(response.thread.id, response.thread.turns ?? []) };
  }

  async createThread(input: { cwd: string; model?: string; effort?: ReasoningEffort; initialMessage?: string }): Promise<LocalThreadSummary> {
    const response = await this.#rpc.request<{ thread: CodexThread }>("thread/start", {
      cwd: input.cwd,
      model: input.model ?? null,
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      ephemeral: false,
    });
    const threadId = response.thread.id;
    this.#ownedThreads.add(threadId);
    this.#loadedThreads.add(threadId);
    await this.#persistOwnedThreads();
    const summary = this.#mapThread(response.thread);
    this.events.publish("thread-upserted", publicThread(summary));
    if (input.initialMessage?.trim()) {
      await this.startTurn(threadId, input.initialMessage, input.model, input.effort);
    }
    return summary;
  }

  async startTurn(threadId: string, text: string, model?: string, effort?: ReasoningEffort): Promise<string> {
    if (this.#activeTurns.has(threadId)) throw new Error("This thread already has a bridge-controlled turn running");
    if (!this.#ownedThreads.has(threadId)) this.#ownedThreads.add(threadId);
    await this.#ensureResumed(threadId, model);
    const response = await this.#rpc.request<{ turn: CodexTurn }>("turn/start", {
      threadId,
      input: [{ type: "text", text, text_elements: [] }],
      model: model ?? null,
      effort: effort ?? null,
      approvalPolicy: "on-request",
    });
    this.#activeTurns.set(threadId, response.turn.id);
    await this.#persistOwnedThreads();
    this.events.publish("turn-state-changed", { threadId, turnId: response.turn.id, state: "running" });
    return response.turn.id;
  }

  async interrupt(threadId: string): Promise<void> {
    const turnId = this.#activeTurns.get(threadId);
    if (!turnId) throw new Error("This task is not controlled by the web bridge");
    await this.#rpc.request("turn/interrupt", { threadId, turnId });
  }

  async resolveApproval(id: string, decision: "accept" | "decline"): Promise<void> {
    const pending = this.#pendingApprovals.get(id);
    if (!pending) throw new Error("Approval not found or already resolved");
    if (!this.#ownedThreads.has(pending.summary.threadId)) throw new Error("Desktop-originated approvals are read-only");
    this.#rpc.respond(pending.rpcId, { decision });
    this.#pendingApprovals.delete(id);
    this.events.publish("approval-resolved", { id, decision });
  }

  async refreshModels(): Promise<ModelSummary[]> {
    const response = await this.#rpc.request<{
      data: Array<{
        id: string;
        model: string;
        displayName: string;
        description: string;
        isDefault: boolean;
        hidden: boolean;
        defaultReasoningEffort: ReasoningEffort;
        supportedReasoningEfforts: Array<{ reasoningEffort: ReasoningEffort }>;
      }>;
    }>("model/list", { limit: 100, includeHidden: false });
    this.#models = response.data
      .filter((model) => !model.hidden)
      .map((model) => ({
        id: model.id,
        model: model.model,
        displayName: model.displayName,
        description: model.description,
        isDefault: model.isDefault,
        defaultReasoningEffort: model.defaultReasoningEffort,
        supportedReasoningEfforts: model.supportedReasoningEfforts.map((entry) => entry.reasoningEffort),
      }));
    return this.#models;
  }

  async #connect(): Promise<void> {
    try {
      this.#setStatus("starting");
      const { stdout } = await execFileAsync(this.command, ["--version"], { windowsHide: true, timeout: 10_000 });
      const match = stdout.match(/codex-cli\s+([^\s]+)/);
      this.#version = match?.[1] ?? null;
      if (this.#version !== EXPECTED_CODEX_VERSION) {
        throw new Error(`Codex CLI ${EXPECTED_CODEX_VERSION} is required, found ${this.#version ?? "unknown"}`);
      }
      await this.#rpc.start();
      await this.#rpc.request("initialize", {
        clientInfo: { name: "codex-control", title: "Codex Control", version: "0.1.0" },
        capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
      });
      await this.refreshModels();
      this.#restartAttempt = 0;
      this.#setStatus("connected");
    } catch (error) {
      this.#setStatus("offline", error instanceof Error ? error.message : String(error));
      await this.#rpc.stop().catch(() => undefined);
      this.#scheduleRestart();
    }
  }

  #handleClose(error: Error): void {
    this.#loadedThreads.clear();
    this.#activeTurns.clear();
    this.#pendingApprovals.clear();
    this.#setStatus("offline", error.message);
    this.#scheduleRestart();
  }

  #scheduleRestart(): void {
    if (this.#stopping || this.#restartTimer) return;
    const delay = Math.min(30_000, 1_000 * 2 ** this.#restartAttempt++);
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null;
      void this.#connect();
    }, delay);
    this.#restartTimer.unref();
  }

  #setStatus(state: ServiceStatus["codex"], message?: string): void {
    this.#status = state;
    this.statusListener(state, this.#version, message);
  }

  async #ensureResumed(threadId: string, model?: string): Promise<void> {
    if (this.#loadedThreads.has(threadId)) return;
    await this.#rpc.request("thread/resume", { threadId, model: model ?? null, excludeTurns: true });
    this.#loadedThreads.add(threadId);
  }

  #handleServerRequest(request: JsonRpcRequest): void {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const method = request.method;
    const isApproval = method.includes("requestApproval") || method === "applyPatchApproval" || method === "execCommandApproval";
    if (!isApproval) return;
    const id = String(request.id);
    const threadId = String(params.threadId ?? "");
    const detail = approvalDetail(method, params);
    const summary: ApprovalSummary = {
      id,
      threadId,
      turnId: typeof params.turnId === "string" ? params.turnId : null,
      kind: method.includes("command") || method === "execCommandApproval" ? "command" : method.includes("fileChange") || method === "applyPatchApproval" ? "file-change" : method.includes("permissions") ? "permissions" : "unknown",
      title: detail.title,
      detail: detail.detail,
      createdAt: new Date().toISOString(),
    };
    this.#pendingApprovals.set(id, { rpcId: request.id, summary });
    this.events.publish("approval-created", summary);
  }

  #handleNotification(notification: JsonRpcNotification): void {
    const params = (notification.params ?? {}) as Record<string, unknown>;
    const threadId = typeof params.threadId === "string" ? params.threadId : "";
    if (notification.method === "thread/started" && params.thread && typeof params.thread === "object") {
      this.events.publish("thread-upserted", publicThread(this.#mapThread(params.thread as CodexThread)));
      return;
    }
    if (notification.method === "turn/started") {
      const turn = params.turn as CodexTurn | undefined;
      if (threadId && turn?.id && this.#ownedThreads.has(threadId)) this.#activeTurns.set(threadId, turn.id);
      this.events.publish("turn-state-changed", { threadId, turnId: turn?.id ?? null, state: "running" });
      return;
    }
    if (notification.method === "turn/completed") {
      const turn = params.turn as CodexTurn | undefined;
      this.#activeTurns.delete(threadId);
      this.events.publish("turn-state-changed", {
        threadId,
        turnId: turn?.id ?? null,
        state: normalizeTurnStatus(turn?.status),
      });
      return;
    }
    if (notification.method === "item/agentMessage/delta") {
      this.events.publish("agent-message-delta", {
        threadId,
        turnId: params.turnId ?? null,
        itemId: params.itemId ?? null,
        delta: params.delta ?? "",
      });
      return;
    }
    if (notification.method === "item/started" || notification.method === "item/completed") {
      const item = params.item as Record<string, unknown> | undefined;
      if (item) {
        const mapped = mapLiveItem(threadId, String(params.turnId ?? ""), item, notification.method === "item/completed");
        if (mapped) this.events.publish("timeline-item-upserted", mapped);
      }
      return;
    }
    if (notification.method === "item/fileChange/patchUpdated") {
      this.events.publish("timeline-item-upserted", {
        id: String(params.itemId ?? crypto.randomUUID()),
        threadId,
        turnId: String(params.turnId ?? "") || null,
        kind: "file-change",
        timestamp: new Date().toISOString(),
        text: "Files changed",
        status: "running",
        changes: Array.isArray(params.changes) ? params.changes : [],
      } satisfies TimelineItem);
      return;
    }
    if (notification.method === "error") {
      this.events.publish("timeline-item-upserted", {
        id: crypto.randomUUID(),
        threadId,
        turnId: typeof params.turnId === "string" ? params.turnId : null,
        kind: "error",
        timestamp: new Date().toISOString(),
        text: String(params.message ?? params.error ?? "Codex reported an error"),
        status: "failed",
      } satisfies TimelineItem);
    }
  }

  #mapThread(thread: CodexThread): LocalThreadSummary {
    const activeTurnId = this.#activeTurns.get(thread.id) ?? null;
    return {
      id: thread.id,
      title: thread.name?.trim() || thread.preview?.trim() || "New task",
      cwd: thread.cwd ?? "",
      projectId: null,
      model: thread.model ?? null,
      reasoningEffort: null,
      createdAt: toIso(thread.createdAt),
      updatedAt: toIso(thread.updatedAt),
      origin: this.#ownedThreads.has(thread.id) ? "web" : "desktop",
      controlMode: this.#ownedThreads.has(thread.id) ? "full" : activeTurnId ? "available-after-completion" : "read-only",
      state: activeTurnId ? "running" : normalizeTurnStatus(typeof thread.status === "string" ? thread.status : thread.status?.type),
      activeTurnId,
    };
  }

  async #loadOwnedThreads(): Promise<void> {
    try {
      const ids = JSON.parse(await readFile(this.#ownedPath, "utf8")) as string[];
      for (const id of ids) this.#ownedThreads.add(id);
    } catch {
      // First launch has no owned thread registry.
    }
  }

  async #persistOwnedThreads(): Promise<void> {
    await writeFile(this.#ownedPath, JSON.stringify([...this.#ownedThreads], null, 2), "utf8");
  }
}

function toIso(value: string | number | undefined): string {
  if (typeof value === "number") return new Date(value < 10_000_000_000 ? value * 1_000 : value).toISOString();
  if (typeof value === "string" && value) return new Date(value).toISOString();
  return new Date().toISOString();
}

function normalizeTurnStatus(status: string | undefined): ThreadSummary["state"] {
  if (!status) return "idle";
  if (/interrupt|cancel/i.test(status)) return "interrupted";
  if (/fail|error/i.test(status)) return "failed";
  if (/run|progress|active/i.test(status)) return "running";
  if (/complete|finish|success/i.test(status)) return "completed";
  return "idle";
}

function approvalDetail(method: string, params: Record<string, unknown>): { title: string; detail: string } {
  if (method.includes("command") || method === "execCommandApproval") {
    return { title: "Run command", detail: String(params.command ?? params.reason ?? "Codex requests command execution") };
  }
  if (method.includes("fileChange") || method === "applyPatchApproval") {
    return { title: "Apply file changes", detail: String(params.reason ?? "Codex requests permission to edit files") };
  }
  return { title: "Permission required", detail: String(params.reason ?? "Codex requests approval") };
}

function mapTurns(threadId: string, turns: CodexTurn[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (const turn of turns) {
    for (const item of turn.items ?? []) {
      const mapped = mapLiveItem(threadId, turn.id, item, true);
      if (mapped) items.push(mapped);
    }
  }
  return items;
}

function mapLiveItem(threadId: string, turnId: string, item: Record<string, unknown>, completed: boolean): TimelineItem | null {
  const type = String(item.type ?? "");
  const id = String(item.id ?? crypto.randomUUID());
  const base = { id, threadId, turnId: turnId || null, timestamp: new Date().toISOString() };
  if (type === "userMessage") return { ...base, kind: "user-message", text: String(item.text ?? "") };
  if (type === "agentMessage") return { ...base, kind: "agent-message", text: String(item.text ?? ""), phase: "unknown" };
  if (type === "reasoning") return { ...base, kind: "reasoning", text: String(item.summary ?? item.text ?? "") };
  if (type === "commandExecution") {
    return {
      ...base,
      kind: "command",
      text: String(item.aggregatedOutput ?? item.command ?? ""),
      command: String(item.command ?? ""),
      status: completed ? (Number(item.exitCode ?? 0) === 0 ? "completed" : "failed") : "running",
      exitCode: completed ? Number(item.exitCode ?? 0) : null,
    };
  }
  if (type === "fileChange") {
    return { ...base, kind: "file-change", text: "Files changed", status: completed ? "completed" : "running", changes: [] };
  }
  return null;
}
