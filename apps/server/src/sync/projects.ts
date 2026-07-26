import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { LocalProjectSummary } from "../types.js";

interface GlobalState {
  "local-projects"?: Record<string, { id?: string; name?: string; rootPaths?: string[] }>;
  "selected-project"?: { type?: string; projectId?: string };
  "active-workspace-roots"?: string[];
  "electron-saved-workspace-roots"?: string[];
}

export async function readDesktopProjects(codexHome: string): Promise<LocalProjectSummary[]> {
  const state = await readState(codexHome);
  const selectedId = state["selected-project"]?.projectId ?? null;
  const projects = new Map<string, LocalProjectSummary>();
  for (const [key, value] of Object.entries(state["local-projects"] ?? {})) {
    const path = value.rootPaths?.[0];
    if (!path) continue;
    const id = value.id ?? key;
    projects.set(id, { id, name: value.name?.trim() || basename(path), path, selected: id === selectedId });
  }
  const roots = [...(state["active-workspace-roots"] ?? []), ...(state["electron-saved-workspace-roots"] ?? [])];
  for (const path of roots) {
    if ([...projects.values()].some((project) => samePath(project.path, path))) continue;
    const id = `path:${path.toLowerCase()}`;
    projects.set(id, { id, name: basename(path), path, selected: false });
  }
  return [...projects.values()];
}

async function readState(codexHome: string): Promise<GlobalState> {
  for (const name of [".codex-global-state.json", ".codex-global-state.json.bak"]) {
    try {
      return JSON.parse(await readFile(join(codexHome, name), "utf8")) as GlobalState;
    } catch {
      // The desktop app writes via replacement; retry the backup on a partial read.
    }
  }
  return {};
}

function samePath(left: string, right: string): boolean {
  return left.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase() === right.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}
