import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { EventHub } from "../events.js";
import { readDesktopProjects } from "./projects.js";
import { SessionRecordParser } from "./session-parser.js";
import { StateStore } from "./state-store.js";

interface FileCursor {
  offset: number;
  remainder: string;
  parser: SessionRecordParser;
  identity: string | null;
}

export class DesktopSessionSync {
  readonly #cursors = new Map<string, FileCursor>();
  #watcher: FSWatcher | null = null;
  #projectTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly codexHome: string,
    private readonly store: StateStore,
    private readonly events: EventHub,
    private readonly onState: (state: "connected" | "degraded" | "offline", message?: string) => void,
  ) {}

  async start(): Promise<void> {
    await this.#refreshProjects();
    const sessions = join(this.codexHome, "sessions");
    this.#watcher = chokidar.watch(sessions, {
      ignoreInitial: false,
      depth: 5,
      awaitWriteFinish: { stabilityThreshold: 180, pollInterval: 80 },
    });
    this.#watcher.on("add", (path) => { if (path.toLowerCase().endsWith(".jsonl")) void this.#consume(path); });
    this.#watcher.on("change", (path) => { if (path.toLowerCase().endsWith(".jsonl")) void this.#consume(path); });
    this.#watcher.on("unlink", (path) => this.#cursors.delete(path));
    this.#watcher.on("error", (error) => this.onState("degraded", String(error)));
    this.#projectTimer = setInterval(() => void this.#refreshProjects(), 2_000);
    this.#projectTimer.unref();
    this.onState("connected");
  }

  async stop(): Promise<void> {
    if (this.#projectTimer) clearInterval(this.#projectTimer);
    this.#projectTimer = null;
    await this.#watcher?.close();
    this.#watcher = null;
  }

  async #refreshProjects(): Promise<void> {
    try {
      this.store.setProjects(await readDesktopProjects(this.codexHome));
    } catch (error) {
      this.onState("degraded", error instanceof Error ? error.message : String(error));
    }
  }

  async #consume(path: string): Promise<void> {
    let cursor = this.#cursors.get(path);
    if (!cursor) {
      cursor = { offset: 0, remainder: "", parser: new SessionRecordParser(), identity: null };
      this.#cursors.set(path, cursor);
    }
    try {
      const info = await stat(path);
      const identity = `${info.dev}:${info.ino}:${info.birthtimeMs}`;
      if (shouldResetCursor(cursor.identity, identity, info.size, cursor.offset)) {
        cursor.offset = 0;
        cursor.remainder = "";
        cursor.parser = new SessionRecordParser();
      }
      cursor.identity = identity;
      if (info.size === cursor.offset) return;
      // libuv opens Windows files with shared read/write/delete access, so the
      // desktop app can keep appending or rotate the rollout while we read it.
      const handle = await open(path, "r");
      try {
        const length = info.size - cursor.offset;
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, cursor.offset);
        cursor.offset += bytesRead;
        const split = splitCompleteLines(cursor.remainder, buffer.subarray(0, bytesRead).toString("utf8"));
        const lines = split.lines;
        cursor.remainder = split.remainder;
        for (const line of lines) {
          if (!line.trim()) continue;
          for (const update of cursor.parser.parse(line)) {
            if (update.thread) this.store.upsertThread(update.thread as Parameters<StateStore["upsertThread"]>[0]);
            if (update.item) this.store.upsertItem(update.item);
          }
        }
      } finally {
        await handle.close();
      }
    } catch (error) {
      this.events.publish("status-changed", { desktopSync: "degraded", message: String(error) });
      this.onState("degraded", error instanceof Error ? error.message : String(error));
    }
  }
}

export function splitCompleteLines(previousRemainder: string, chunk: string): { lines: string[]; remainder: string } {
  const parts = `${previousRemainder}${chunk}`.split(/\r?\n/);
  return { lines: parts.slice(0, -1), remainder: parts.at(-1) ?? "" };
}

export function shouldResetCursor(previousIdentity: string | null, nextIdentity: string, size: number, offset: number): boolean {
  return (previousIdentity !== null && previousIdentity !== nextIdentity) || size < offset;
}
