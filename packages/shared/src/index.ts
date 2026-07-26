export type ConnectionState = "starting" | "connected" | "degraded" | "offline";
export type ThreadOrigin = "desktop" | "web" | "unknown";
export type ControlMode = "full" | "read-only" | "available-after-completion";
export type TurnState = "idle" | "running" | "completed" | "interrupted" | "failed";

export interface ProjectSummary {
  id: string;
  name: string;
  selected: boolean;
}

export interface ModelSummary {
  id: string;
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  defaultReasoningEffort: ReasoningEffort;
  supportedReasoningEfforts: ReasoningEffort[];
}

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface ThreadSummary {
  id: string;
  title: string;
  projectId: string | null;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  createdAt: string;
  updatedAt: string;
  origin: ThreadOrigin;
  controlMode: ControlMode;
  state: TurnState;
  activeTurnId: string | null;
}

export type TimelineItemKind =
  | "user-message"
  | "agent-message"
  | "reasoning"
  | "command"
  | "file-change"
  | "status"
  | "error";

export interface TimelineItem {
  id: string;
  threadId: string;
  turnId: string | null;
  kind: TimelineItemKind;
  timestamp: string;
  text: string;
  phase?: "commentary" | "final" | "unknown";
  status?: "running" | "completed" | "failed" | "interrupted";
  command?: string;
  exitCode?: number | null;
  changes?: FileChange[];
}

export interface FileChange {
  path: string;
  kind: "add" | "update" | "delete" | "unknown";
  diff?: string;
}

export interface ThreadDetail extends ThreadSummary {
  items: TimelineItem[];
}

export interface ApprovalSummary {
  id: string;
  threadId: string;
  turnId: string | null;
  kind: "command" | "file-change" | "permissions" | "user-input" | "unknown";
  title: string;
  detail: string;
  createdAt: string;
}

export interface DeviceSummary {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string;
}

export interface ServiceStatus {
  codex: ConnectionState;
  tunnel: ConnectionState;
  tunnelUrl: string | null;
  codexVersion: string | null;
  expectedCodexVersion: string;
  desktopSync: ConnectionState;
  message?: string;
}

export interface BootstrapResponse {
  csrfToken: string;
  projects: ProjectSummary[];
  threads: ThreadSummary[];
  models: ModelSummary[];
  approvals: ApprovalSummary[];
  status: ServiceStatus;
  eventSequence: number;
}

export type RealtimeEventType =
  | "snapshot-invalidated"
  | "thread-upserted"
  | "timeline-item-upserted"
  | "agent-message-delta"
  | "approval-created"
  | "approval-resolved"
  | "status-changed"
  | "turn-state-changed";

export interface RealtimeEvent<T = unknown> {
  sequence: number;
  type: RealtimeEventType;
  timestamp: string;
  payload: T;
}

export interface PairRequest {
  token: string;
  deviceName: string;
}

export interface CreateThreadRequest {
  projectId: string;
  model?: string;
  effort?: ReasoningEffort;
  initialMessage?: string;
}

export interface StartTurnRequest {
  text: string;
  model?: string;
  effort?: ReasoningEffort;
}

export interface ResolveApprovalRequest {
  decision: "accept" | "decline";
}
