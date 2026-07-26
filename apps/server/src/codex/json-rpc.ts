import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";

export interface JsonRpcRequest {
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

export class CodexRpcClient extends EventEmitter {
  #child: ChildProcessWithoutNullStreams | null = null;
  #pending = new Map<number, PendingRequest>();
  #nextId = 1;
  #stderr = "";
  #closedIntentionally = false;

  constructor(
    private readonly command: string,
    private readonly timeoutMs = 30_000,
    private readonly args: string[] = ["app-server", "--listen", "stdio://"],
  ) {
    super();
  }

  get running(): boolean {
    return this.#child !== null && this.#child.exitCode === null;
  }

  get stderrTail(): string {
    return this.#stderr.slice(-4_096);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.#closedIntentionally = false;
    const child = spawn(this.command, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, RUST_BACKTRACE: "1" },
    });
    this.#child = child;
    this.#stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.#stderr = `${this.#stderr}${chunk}`.slice(-8_192);
      this.emit("stderr", chunk);
    });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.#handleLine(line));
    child.on("error", (error) => this.#handleClose(error));
    child.on("exit", (code, signal) => this.#handleClose(new Error(`Codex app-server exited (${code ?? signal ?? "unknown"})`)));
    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        child.off("spawn", onSpawn);
        child.off("error", onError);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
  }

  request<T>(method: string, params: unknown = {}): Promise<T> {
    const child = this.#child;
    if (!child || !this.running) return Promise.reject(new Error("Codex app-server is not running"));
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, this.timeoutMs);
      timer.unref();
      this.#pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  respond(id: number | string, result: unknown): void {
    this.#child?.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }

  async stop(): Promise<void> {
    this.#closedIntentionally = true;
    const child = this.#child;
    this.#child = null;
    if (!child) return;
    child.stdin.end();
    if (child.exitCode === null) child.kill();
  }

  #handleLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.emit("protocol-warning", line.slice(0, 300));
      return;
    }
    if ("id" in message && ("result" in message || "error" in message)) {
      const id = Number(message.id);
      const pending = this.#pending.get(id);
      if (!pending) return;
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      if (message.error && typeof message.error === "object") {
        const detail = message.error as { message?: string; code?: number };
        const error = new Error(detail.message ?? `Codex request failed: ${pending.method}`) as Error & { code?: number };
        if (detail.code !== undefined) error.code = detail.code;
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if ("id" in message && typeof message.method === "string") {
      this.emit("request", message as unknown as JsonRpcRequest);
      return;
    }
    if (typeof message.method === "string") this.emit("notification", message as unknown as JsonRpcNotification);
  }

  #handleClose(error: Error): void {
    if (!this.#child && this.#closedIntentionally) return;
    this.#child = null;
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.#pending.delete(id);
    }
    if (!this.#closedIntentionally) this.emit("close", error);
  }
}
