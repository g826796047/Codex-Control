import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  CircleStop,
  Command,
  FileDiff,
  FolderGit2,
  LoaderCircle,
  Menu,
  MessageSquarePlus,
  PanelLeftClose,
  RefreshCw,
  Send,
  ShieldCheck,
  WifiOff,
  X,
} from "lucide-react";
import type {
  ApprovalSummary,
  BootstrapResponse,
  ReasoningEffort,
  RealtimeEvent,
  ThreadDetail,
  ThreadSummary,
  TimelineItem,
} from "@codex-control/shared";
import { Markdown } from "./components/Markdown";
import { Pairing } from "./components/Pairing";
import {
  ApiError,
  bootstrap,
  connectEvents,
  createThread,
  getThread,
  interrupt,
  resolveApproval,
  startTurn,
} from "./lib/api";

export function App() {
  const [data, setData] = useState<BootstrapResponse | null>(null);
  const [paired, setPaired] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [projectId, setProjectId] = useState("");
  const [threadId, setThreadId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  const [newThread, setNewThread] = useState(false);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState<ReasoningEffort>("medium");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const sequence = useRef(0);
  const timelineEnd = useRef<HTMLDivElement>(null);

  async function loadBootstrap() {
    setError("");
    try {
      const next = await bootstrap();
      sequence.current = next.eventSequence;
      setData(next);
      setPaired(true);
      setProjectId((current) => current || next.projects.find((project) => project.selected)?.id || next.projects[0]?.id || "");
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) setPaired(false);
      else setError(reason instanceof Error ? reason.message : "无法连接到 PC");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadBootstrap();
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  const projectThreads = useMemo(
    () => (data?.threads ?? []).filter((thread) => !projectId || thread.projectId === projectId),
    [data, projectId],
  );

  useEffect(() => {
    if (!projectThreads.some((thread) => thread.id === threadId)) {
      setThreadId(projectThreads[0]?.id ?? null);
      setNewThread(projectThreads.length === 0);
    }
  }, [projectId, projectThreads, threadId]);

  useEffect(() => {
    if (!threadId || newThread) {
      setDetail(null);
      return;
    }
    void getThread(threadId).then((thread) => {
      setDetail(thread);
      if (thread.model) setModel(thread.model);
      if (thread.reasoningEffort) setEffort(thread.reasoningEffort);
    }).catch((reason) => setError(reason instanceof Error ? reason.message : "会话加载失败"));
  }, [threadId, newThread]);

  useEffect(() => {
    if (!data || !paired) return;
    return connectEvents(sequence.current, handleEvent, setWsConnected);
    // Reconnect only after a fresh bootstrap establishes a sequence baseline.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(data), paired]);

  useEffect(() => {
    timelineEnd.current?.scrollIntoView({ block: "end" });
  }, [detail?.items.length, sending]);

  function handleEvent(event: RealtimeEvent) {
    sequence.current = Math.max(sequence.current, event.sequence ?? 0);
    if (event.type === "snapshot-invalidated") {
      void loadBootstrap();
      return;
    }
    if (event.type === "status-changed") {
      setData((current) => current ? { ...current, status: event.payload as BootstrapResponse["status"] } : current);
      return;
    }
    if (event.type === "thread-upserted") {
      const thread = event.payload as ThreadSummary;
      setData((current) => current ? { ...current, threads: upsert(current.threads, thread) } : current);
      setDetail((current) => current?.id === thread.id ? { ...current, ...thread } : current);
      return;
    }
    if (event.type === "turn-state-changed") {
      const payload = event.payload as { threadId: string; turnId: string | null; state: ThreadSummary["state"] };
      setDetail((current) => current?.id === payload.threadId ? { ...current, state: payload.state, activeTurnId: payload.state === "running" ? payload.turnId : null } : current);
      if (payload.state !== "running" && payload.threadId === threadId) void getThread(payload.threadId).then(setDetail);
      return;
    }
    if (event.type === "timeline-item-upserted") {
      const item = event.payload as TimelineItem;
      setDetail((current) => current?.id === item.threadId ? { ...current, items: upsert(current.items, item) } : current);
      return;
    }
    if (event.type === "agent-message-delta") {
      const payload = event.payload as { threadId: string; turnId: string | null; itemId: string; delta: string };
      setDetail((current) => {
        if (!current || current.id !== payload.threadId) return current;
        const id = payload.itemId || `stream:${payload.turnId}`;
        const existing = current.items.find((item) => item.id === id);
        const item: TimelineItem = {
          id,
          threadId: payload.threadId,
          turnId: payload.turnId,
          kind: "agent-message",
          timestamp: existing?.timestamp ?? new Date().toISOString(),
          text: `${existing?.text ?? ""}${payload.delta}`,
          phase: "unknown",
          status: "running",
        };
        return { ...current, items: upsert(current.items, item) };
      });
      return;
    }
    if (event.type === "approval-created" || event.type === "approval-resolved") void loadBootstrap();
  }

  async function sendMessage() {
    const text = message.trim();
    if (!text || sending || !online) return;
    setSending(true);
    setError("");
    setMessage("");
    try {
      if (newThread || !threadId) {
        const created = await createThread({ projectId, effort, initialMessage: text, ...(model ? { model } : {}) });
        setThreadId(created.id);
        setNewThread(false);
        setSidebarOpen(false);
        await loadBootstrap();
      } else {
        setDetail((current) => current ? {
          ...current,
          items: [...current.items, {
            id: `optimistic:${Date.now()}`,
            threadId,
            turnId: null,
            kind: "user-message",
            timestamp: new Date().toISOString(),
            text,
          }],
        } : current);
        await startTurn(threadId, { text, effort, ...(model ? { model } : {}) });
      }
    } catch (reason) {
      setMessage(text);
      setError(reason instanceof Error ? reason.message : "发送失败");
    } finally {
      setSending(false);
    }
  }

  async function stopTurn() {
    if (!threadId) return;
    try {
      await interrupt(threadId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "停止失败");
    }
  }

  async function decide(approval: ApprovalSummary, decision: "accept" | "decline") {
    try {
      await resolveApproval(approval.id, { decision });
      setData((current) => current ? { ...current, approvals: current.approvals.filter((item) => item.id !== approval.id) } : current);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "审批失败");
    }
  }

  if (loading) return <div className="center-state"><LoaderCircle className="spin" /><span>连接 PC...</span></div>;
  if (!paired) return <Pairing onPaired={() => { setLoading(true); void loadBootstrap(); }} />;
  if (!data) return <div className="center-state"><AlertTriangle /><span>{error || "服务不可用"}</span><button onClick={() => void loadBootstrap()}><RefreshCw size={17} />重试</button></div>;

  const selectedThread = detail ?? data.threads.find((thread) => thread.id === threadId) ?? null;
  const selectedModel = data.models.find((entry) => entry.model === model || entry.id === model) ?? data.models.find((entry) => entry.isDefault);
  const effortOptions = selectedModel?.supportedReasoningEfforts.length ? selectedModel.supportedReasoningEfforts : ["low", "medium", "high"] as ReasoningEffort[];
  const writeDisabled = !online || sending || (selectedThread?.state === "running" && selectedThread.controlMode !== "full");

  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="icon-button mobile-only" title="打开会话列表" onClick={() => setSidebarOpen(true)}><Menu /></button>
        <div className="app-identity"><span className="identity-icon"><Command size={18} /></span><strong>Codex Control</strong></div>
        <div className="connection-summary">
          <span className={`status-dot ${data.status.codex}`} />
          <span>{data.status.codex === "connected" ? "Codex 已连接" : "Codex 离线"}</span>
          {!wsConnected && <WifiOff size={15} />}
        </div>
      </header>

      <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
        <div className="sidebar-header">
          <label className="project-picker">
            <FolderGit2 size={17} />
            <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
              {data.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
            <ChevronDown size={15} />
          </label>
          <button className="icon-button mobile-only" title="关闭会话列表" onClick={() => setSidebarOpen(false)}><PanelLeftClose /></button>
        </div>
        <button className="new-thread-button" onClick={() => { setNewThread(true); setThreadId(null); setDetail(null); setSidebarOpen(false); }}>
          <MessageSquarePlus size={18} /> 新建对话
        </button>
        <nav className="thread-list" aria-label="对话">
          {projectThreads.map((thread) => (
            <button key={thread.id} className={thread.id === threadId && !newThread ? "thread-row active" : "thread-row"} onClick={() => { setThreadId(thread.id); setNewThread(false); setSidebarOpen(false); }}>
              <span className="thread-title">{thread.title}</span>
              <span className="thread-meta"><span className={`mini-state ${thread.state}`} />{relativeTime(thread.updatedAt)}</span>
            </button>
          ))}
          {projectThreads.length === 0 && <p className="empty-list">这个项目还没有对话</p>}
        </nav>
      </aside>
      {sidebarOpen && <button className="sidebar-scrim" aria-label="关闭" onClick={() => setSidebarOpen(false)} />}

      <main className="workspace">
        <div className="thread-toolbar">
          <div className="thread-heading">
            <h1>{newThread ? "新建对话" : selectedThread?.title ?? "选择一个对话"}</h1>
            {selectedThread && <span className={`control-badge ${selectedThread.controlMode}`}>{controlLabel(selectedThread)}</span>}
          </div>
          <div className="model-controls">
            <select aria-label="模型" value={model || selectedModel?.model || ""} onChange={(event) => setModel(event.target.value)}>
              {data.models.map((entry) => <option key={entry.id} value={entry.model}>{entry.displayName}</option>)}
            </select>
            <select aria-label="推理强度" value={effort} onChange={(event) => setEffort(event.target.value as ReasoningEffort)}>
              {effortOptions.map((entry) => <option key={entry} value={entry}>{effortLabel(entry)}</option>)}
            </select>
          </div>
        </div>

        {!online && <div className="offline-strip"><WifiOff size={16} />当前离线，写操作已禁用，恢复网络后会自动续传事件。</div>}
        {error && <div className="error-strip"><AlertTriangle size={16} /><span>{error}</span><button title="关闭" onClick={() => setError("")}><X size={16} /></button></div>}

        {data.approvals.filter((approval) => approval.threadId === threadId).map((approval) => (
          <section className="approval-bar" key={approval.id}>
            <ShieldCheck size={20} />
            <div><strong>{approval.title}</strong><p>{approval.detail}</p></div>
            <button className="approve" onClick={() => void decide(approval, "accept")}><Check size={17} />批准</button>
            <button className="deny" onClick={() => void decide(approval, "decline")}><X size={17} />拒绝</button>
          </section>
        ))}

        <div className="timeline">
          {newThread && <div className="blank-thread"><MessageSquarePlus size={30} /><h2>开始一个 Codex 任务</h2><p>选择模型后直接输入任务。项目目录与权限由 PC 端控制。</p></div>}
          {!newThread && detail?.items.map((item) => <TimelineEntry key={item.id} item={item} />)}
          {!newThread && detail && detail.items.length === 0 && <div className="blank-thread"><p>这个对话暂时没有可显示的消息。</p></div>}
          {sending && <div className="working-indicator"><LoaderCircle className="spin" size={16} />正在提交...</div>}
          <div ref={timelineEnd} />
        </div>

        <div className="composer-wrap">
          {selectedThread?.state === "running" && selectedThread.controlMode === "full" && (
            <button className="stop-button" onClick={() => void stopTurn()}><CircleStop size={17} />停止任务</button>
          )}
          {selectedThread?.state === "running" && selectedThread.controlMode !== "full" && (
            <div className="readonly-notice">此任务正在 PC 桌面端运行，手机当前只读；结束后可从手机继续。</div>
          )}
          <div className="composer">
            <textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void sendMessage();
                }
              }}
              placeholder={selectedThread?.controlMode === "available-after-completion" ? "从手机继续这个对话..." : "给 Codex 发送消息..."}
              rows={1}
              disabled={writeDisabled}
            />
            <button className="send-button" title="发送" onClick={() => void sendMessage()} disabled={writeDisabled || !message.trim()}>
              {sending ? <LoaderCircle className="spin" /> : <Send />}
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}

function TimelineEntry({ item }: { item: TimelineItem }) {
  if (item.kind === "user-message" || item.kind === "agent-message") {
    return <article className={`message ${item.kind === "user-message" ? "user" : "agent"}`}><Markdown>{item.text}</Markdown></article>;
  }
  if (item.kind === "reasoning") return <details className="reasoning"><summary>推理摘要</summary><Markdown>{item.text}</Markdown></details>;
  if (item.kind === "command") {
    return <section className="activity-row"><Command size={18} /><div><strong>{item.command || "命令"}</strong><pre>{item.text}</pre></div><ActivityState item={item} /></section>;
  }
  if (item.kind === "file-change") {
    return <section className="activity-row"><FileDiff size={18} /><div><strong>文件变更</strong>{item.changes?.map((change) => <details key={change.path}><summary>{change.path}</summary>{change.diff && <pre>{change.diff}</pre>}</details>)}</div><ActivityState item={item} /></section>;
  }
  return <section className={`activity-row ${item.kind}`}><AlertTriangle size={18} /><div>{item.text}</div></section>;
}

function ActivityState({ item }: { item: TimelineItem }) {
  return <span className={`activity-state ${item.status ?? "running"}`}>{item.status === "running" ? <LoaderCircle className="spin" size={16} /> : item.status === "failed" ? <X size={16} /> : <Check size={16} />}</span>;
}

function upsert<T extends { id: string }>(items: T[], item: T): T[] {
  const index = items.findIndex((entry) => entry.id === item.id);
  if (index < 0) return [...items, item];
  const next = [...items];
  next[index] = { ...next[index], ...item };
  return next;
}

function relativeTime(value: string): string {
  const delta = Date.now() - new Date(value).getTime();
  if (delta < 60_000) return "刚刚";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时`;
  return new Date(value).toLocaleDateString();
}

function effortLabel(value: ReasoningEffort): string {
  return ({ none: "无推理", minimal: "最少", low: "低", medium: "中", high: "高", xhigh: "极高" } as const)[value];
}

function controlLabel(thread: ThreadSummary): string {
  if (thread.controlMode === "full") return thread.state === "running" ? "手机控制中" : "可控制";
  if (thread.controlMode === "read-only") return "桌面运行中 · 只读";
  return "可从手机继续";
}
