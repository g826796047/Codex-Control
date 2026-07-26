import type {
  BootstrapResponse,
  CreateThreadRequest,
  PairRequest,
  RealtimeEvent,
  ResolveApprovalRequest,
  StartTurnRequest,
  ThreadDetail,
  ThreadSummary,
} from "@codex-control/shared";

let csrfToken = "";

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (csrfToken && init.method && init.method !== "GET") headers.set("x-csrf-token", csrfToken);
  const response = await fetch(path, { ...init, headers, credentials: "include" });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(body.error ?? `Request failed (${response.status})`, response.status);
  }
  return response.json() as Promise<T>;
}

export async function bootstrap(): Promise<BootstrapResponse> {
  const result = await request<BootstrapResponse>("/api/bootstrap");
  csrfToken = result.csrfToken;
  return result;
}

export async function pair(body: PairRequest): Promise<void> {
  const result = await request<{ csrfToken: string }>("/api/auth/pair", { method: "POST", body: JSON.stringify(body) });
  csrfToken = result.csrfToken;
}

export const getThread = (id: string) => request<ThreadDetail>(`/api/threads/${encodeURIComponent(id)}`);

export const createThread = (body: CreateThreadRequest) => request<ThreadSummary>("/api/threads", {
  method: "POST",
  body: JSON.stringify(body),
});

export const startTurn = (id: string, body: StartTurnRequest) => request<{ turnId: string }>(`/api/threads/${encodeURIComponent(id)}/turns`, {
  method: "POST",
  body: JSON.stringify(body),
});

export const interrupt = (id: string) => request<{ ok: true }>(`/api/threads/${encodeURIComponent(id)}/interrupt`, { method: "POST" });

export const resolveApproval = (id: string, body: ResolveApprovalRequest) => request<{ ok: true }>(`/api/approvals/${encodeURIComponent(id)}/resolve`, {
  method: "POST",
  body: JSON.stringify(body),
});

export function connectEvents(after: number, onEvent: (event: RealtimeEvent) => void, onState: (connected: boolean) => void): () => void {
  let closed = false;
  let socket: WebSocket | null = null;
  let timer: number | null = null;
  const connect = () => {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(`${protocol}//${location.host}/api/events?after=${after}`);
    socket.onopen = () => onState(true);
    socket.onmessage = (message) => onEvent(JSON.parse(message.data as string) as RealtimeEvent);
    socket.onerror = () => socket?.close();
    socket.onclose = () => {
      onState(false);
      if (!closed) timer = window.setTimeout(connect, 1_500);
    };
  };
  connect();
  return () => {
    closed = true;
    if (timer !== null) clearTimeout(timer);
    socket?.close();
  };
}

