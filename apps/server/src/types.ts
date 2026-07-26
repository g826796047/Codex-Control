import type { ProjectSummary, ThreadDetail, ThreadSummary, TimelineItem } from "@codex-control/shared";
import { basename, isAbsolute, relative } from "node:path";

export interface LocalProjectSummary extends ProjectSummary {
  path: string;
}

export interface LocalThreadSummary extends ThreadSummary {
  cwd: string;
}

export interface LocalThreadDetail extends LocalThreadSummary {
  items: TimelineItem[];
}

export function publicProject(project: LocalProjectSummary): ProjectSummary {
  return { id: project.id, name: project.name, selected: project.selected };
}

export function publicThread(thread: LocalThreadSummary): ThreadSummary {
  const { cwd: _cwd, ...result } = thread;
  return result;
}

export function publicThreadDetail(thread: LocalThreadDetail): ThreadDetail {
  const { cwd, ...result } = thread;
  return { ...result, items: thread.items.map((item) => sanitizeTimelineItem(item, cwd)) };
}

export function sanitizeTimelineItem(item: TimelineItem, cwd: string): TimelineItem {
  return {
    ...item,
    text: sanitizeText(item.text, cwd),
    ...(item.command ? { command: sanitizeText(item.command, cwd) } : {}),
    ...(item.changes ? {
      changes: item.changes.map((change) => ({
        ...change,
        path: sanitizeFilePath(change.path, cwd),
        ...(change.diff ? { diff: sanitizeText(change.diff, cwd) } : {}),
      })),
    } : {}),
  };
}

export function sanitizeText(text: string, cwd = ""): string {
  let result = text;
  if (cwd) result = result.split(cwd).join(".");
  return result.replace(/\b[A-Za-z]:\\[^\r\n"'`]+/g, "<local-path>");
}

function sanitizeFilePath(path: string, cwd: string): string {
  if (!isAbsolute(path)) return path.replace(/\\/g, "/");
  const candidate = relative(cwd, path);
  if (candidate && !candidate.startsWith("..") && !isAbsolute(candidate)) return candidate.replace(/\\/g, "/");
  return basename(path);
}
