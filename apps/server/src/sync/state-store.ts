import type { ProjectSummary, ThreadDetail, ThreadSummary, TimelineItem } from "@codex-control/shared";
import { EventHub } from "../events.js";
import type { LocalProjectSummary, LocalThreadDetail, LocalThreadSummary } from "../types.js";
import { publicProject, publicThread, publicThreadDetail } from "../types.js";

export class StateStore {
  readonly #projects = new Map<string, LocalProjectSummary>();
  readonly #threads = new Map<string, LocalThreadSummary>();
  readonly #items = new Map<string, Map<string, TimelineItem>>();

  constructor(
    private readonly events: EventHub,
    private readonly isOwnedThread: (threadId: string) => boolean,
  ) {}

  setProjects(projects: LocalProjectSummary[]): void {
    const previous = JSON.stringify([...this.#projects.values()]);
    const next = JSON.stringify(projects);
    if (previous === next) return;
    this.#projects.clear();
    for (const project of projects) this.#projects.set(project.id, project);
    for (const thread of this.#threads.values()) {
      thread.projectId = this.projectForPath(thread.cwd)?.id ?? null;
    }
    this.events.publish("snapshot-invalidated", { resource: "projects" });
  }

  get projects(): ProjectSummary[] {
    return [...this.#projects.values()].map(publicProject);
  }

  get threads(): ThreadSummary[] {
    return [...this.#threads.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(publicThread);
  }

  thread(id: string): ThreadDetail | null {
    const local = this.localThread(id);
    return local ? publicThreadDetail(local) : null;
  }

  localThread(id: string): LocalThreadDetail | null {
    const summary = this.#threads.get(id);
    if (!summary) return null;
    const items = [...(this.#items.get(id)?.values() ?? [])].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return { ...summary, items };
  }

  upsertThread(input: LocalThreadSummary, notify = true): LocalThreadSummary {
    const owned = this.isOwnedThread(input.id);
    const thread: LocalThreadSummary = {
      ...this.#threads.get(input.id),
      ...input,
      projectId: this.projectForPath(input.cwd)?.id ?? input.projectId ?? null,
      origin: owned ? "web" : input.origin,
      controlMode: owned ? "full" : input.state === "running" ? "read-only" : "available-after-completion",
    };
    this.#threads.set(thread.id, thread);
    if (notify) this.events.publish("thread-upserted", publicThread(thread));
    return thread;
  }

  updatePublicThread(input: ThreadSummary, notify = false): LocalThreadSummary | null {
    const current = this.#threads.get(input.id);
    if (!current) return null;
    return this.upsertThread({ ...current, ...input }, notify);
  }

  upsertItem(item: TimelineItem, notify = true): void {
    let items = this.#items.get(item.threadId);
    if (!items) {
      items = new Map();
      this.#items.set(item.threadId, items);
    }
    items.set(item.id, { ...items.get(item.id), ...item });
    if (notify) this.events.publish("timeline-item-upserted", items.get(item.id)!);
  }

  project(id: string): LocalProjectSummary | null {
    return this.#projects.get(id) ?? null;
  }

  private projectForPath(cwd: string): LocalProjectSummary | null {
    const normalized = normalizePath(cwd);
    let best: LocalProjectSummary | null = null;
    for (const project of this.#projects.values()) {
      const root = normalizePath(project.path);
      if ((normalized === root || normalized.startsWith(`${root}\\`)) && (!best || root.length > normalizePath(best.path).length)) {
        best = project;
      }
    }
    return best;
  }
}

function normalizePath(path: string): string {
  return path.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}
