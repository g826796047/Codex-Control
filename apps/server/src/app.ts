import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import type {
  BootstrapResponse,
  ApprovalSummary,
  CreateThreadRequest,
  DeviceSummary,
  PairRequest,
  ResolveApprovalRequest,
  ServiceStatus,
  StartTurnRequest,
  ThreadSummary,
  TimelineItem,
  RealtimeEvent,
} from "@codex-control/shared";
import { resolveServerOptions, EXPECTED_CODEX_VERSION, type ResolvedServerOptions, type ServerOptions } from "./config.js";
import { EventHub } from "./events.js";
import { BinaryManager, binaryDirectory } from "./codex/binary-manager.js";
import { CodexController } from "./codex/controller.js";
import { AuthStore } from "./security/auth-store.js";
import { DesktopSessionSync } from "./sync/session-sync.js";
import { StateStore } from "./sync/state-store.js";
import { TunnelManager } from "./tunnel/manager.js";
import { sanitizeText, sanitizeTimelineItem } from "./types.js";

const SESSION_COOKIE = "cc_session";
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export class ControlServer {
  readonly app: FastifyInstance;
  readonly options: ResolvedServerOptions;
  readonly events = new EventHub();
  readonly auth: AuthStore;
  readonly #attempts = new Map<string, { count: number; resetAt: number }>();
  readonly #requestDevices = new WeakMap<FastifyRequest, DeviceSummary>();
  #codex: CodexController | null = null;
  #sync: DesktopSessionSync | null = null;
  #tunnel: TunnelManager | null = null;
  #store: StateStore | null = null;
  #status: ServiceStatus = {
    codex: "starting",
    tunnel: "starting",
    tunnelUrl: null,
    codexVersion: null,
    expectedCodexVersion: EXPECTED_CODEX_VERSION,
    desktopSync: "starting",
  };

  constructor(options: ServerOptions = {}) {
    this.options = resolveServerOptions(options);
    this.app = Fastify({ logger: this.options.logger, bodyLimit: 64 * 1024, connectionTimeout: 30_000 });
    this.auth = new AuthStore(join(this.options.dataDir, "auth.json"));
  }

  get status(): ServiceStatus {
    return { ...this.#status };
  }

  get devices(): DeviceSummary[] {
    return this.auth.listDevices();
  }

  createPairing(): { token: string; code: string; expiresAt: string; url: string | null } {
    const pairing = this.auth.createPairing();
    return { ...pairing, url: this.#status.tunnelUrl };
  }

  async revokeDevice(id: string): Promise<boolean> {
    return this.auth.revokeDevice(id);
  }

  async restartTunnel(): Promise<void> {
    await this.#tunnel?.restart();
  }

  async start(): Promise<string> {
    await mkdir(this.options.dataDir, { recursive: true });
    await this.auth.load();
    await this.#registerPluginsAndRoutes();

    const binaries = new BinaryManager(binaryDirectory(this.options.dataDir));
    let codexPath: string;
    try {
      codexPath = await binaries.ensureCodex(this.options.codexPath, this.options.autoDownloadBinaries);
    } catch (error) {
      this.#updateStatus({ codex: "offline", message: errorMessage(error) });
      throw error;
    }

    this.#codex = new CodexController(codexPath, this.options.dataDir, this.events, (codex, codexVersion, message) => {
      this.#updateStatus({ codex, codexVersion, ...(message ? { message } : {}) });
    });
    this.#store = new StateStore(this.events, (threadId) => this.#codex?.isOwnedThread(threadId) ?? false);
    this.#sync = new DesktopSessionSync(this.options.codexHome, this.#store, this.events, (desktopSync, message) => {
      this.#updateStatus({ desktopSync, ...(message ? { message } : {}) });
    });
    this.#wireEventState();
    await this.#sync.start();
    void this.#codex.start();

    const tunnelUrl = await this.options.getTunnelUrl();
    const tunnelToken = await this.options.getTunnelToken();
    if (this.options.externalTunnel && tunnelUrl) {
      this.#updateStatus({
        tunnel: "connected",
        tunnelUrl,
        message: "Public access is managed externally by Sakura FRP",
      });
    } else if (tunnelToken) {
      try {
        const cloudflaredPath = await binaries.ensureCloudflared(this.options.cloudflaredPath, this.options.autoDownloadBinaries);
        this.#tunnel = new TunnelManager(cloudflaredPath, this.options.getTunnelToken, this.options.getTunnelUrl, (tunnel, tunnelUrl, message) => {
          this.#updateStatus({ tunnel, tunnelUrl, ...(message ? { message } : {}) });
        });
        void this.#tunnel.start();
      } catch (error) {
        this.#updateStatus({ tunnel: "offline", message: errorMessage(error) });
      }
    } else {
      this.#updateStatus({ tunnel: "offline", tunnelUrl, message: "Tunnel is not configured" });
    }

    await this.app.listen({ host: this.options.host, port: this.options.port });
    return `http://${this.options.host}:${this.options.port}`;
  }

  async stop(): Promise<void> {
    await Promise.allSettled([this.#tunnel?.stop(), this.#sync?.stop(), this.#codex?.stop()]);
    await this.app.close();
  }

  async #registerPluginsAndRoutes(): Promise<void> {
    const devPairingEnabled = process.env.CODEX_CONTROL_DEV_PAIRING === "1" && !this.options.secureCookies;
    await this.app.register(cookie);
    await this.app.register(websocket, { options: { maxPayload: 64 * 1024 } });

    this.app.addHook("onRequest", async (request, reply) => {
      if (!request.url.startsWith("/api/")) return;
      if (!this.#originAllowed(request)) return reply.code(403).send({ error: "Origin not allowed" });
      if (
        request.url.startsWith("/api/auth/pair") ||
        request.url.startsWith("/api/pairing/status") ||
        (devPairingEnabled && request.url.startsWith("/api/dev/pairing"))
      ) return;
      const device = await this.auth.authenticate(request.cookies[SESSION_COOKIE]);
      if (!device) return reply.code(401).send({ error: "Pairing required" });
      this.#requestDevices.set(request, device);
      if (WRITE_METHODS.has(request.method) && !this.auth.validateCsrf(device.id, headerString(request.headers["x-csrf-token"]))) {
        return reply.code(403).send({ error: "Invalid CSRF token" });
      }
    });

    this.app.get("/api/pairing/status", async () => ({ open: this.auth.pairingOpen() }));
    this.app.post<{ Body: PairRequest }>("/api/auth/pair", async (request, reply) => {
      if (!this.#allowPairAttempt(clientAddress(request))) return reply.code(429).send({ error: "Too many pairing attempts" });
      try {
        const result = await this.auth.pair(request.body?.token ?? "", request.body?.deviceName ?? "Mobile device");
        reply.setCookie(SESSION_COOKIE, result.sessionToken, {
          httpOnly: true,
          secure: this.options.secureCookies,
          sameSite: "strict",
          path: "/",
          maxAge: 365 * 24 * 60 * 60,
        });
        return { csrfToken: result.csrfToken, device: result.device };
      } catch (error) {
        return reply.code(401).send({ error: errorMessage(error) });
      }
    });
    if (devPairingEnabled) {
      this.app.get("/api/dev/pairing", async () => this.createPairing());
    }
    this.app.post("/api/auth/logout", async (_request, reply) => {
      reply.clearCookie(SESSION_COOKIE, { path: "/" });
      return { ok: true };
    });

    this.app.get("/api/bootstrap", async (request) => {
      const device = this.#deviceFrom(request);
      const store = this.#requiredStore();
      return {
        csrfToken: this.auth.csrfToken(device.id),
        projects: store.projects,
        threads: store.threads,
        models: this.#codex?.models ?? [],
        approvals: (this.#codex?.approvals ?? []).map(sanitizeApproval),
        status: this.status,
        eventSequence: this.events.sequence,
      } satisfies BootstrapResponse;
    });

    this.app.get<{ Params: { id: string } }>("/api/threads/:id", async (request, reply) => {
      const detail = this.#requiredStore().thread(request.params.id);
      if (!detail) return reply.code(404).send({ error: "Thread not found" });
      return detail;
    });

    this.app.post<{ Body: CreateThreadRequest }>("/api/threads", async (request, reply) => {
      const codex = this.#requiredCodex();
      const store = this.#requiredStore();
      const project = store.project(request.body.projectId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      const thread = await codex.createThread({
        cwd: project.path,
        ...(request.body.model ? { model: request.body.model } : {}),
        ...(request.body.effort ? { effort: request.body.effort } : {}),
        ...(request.body.initialMessage ? { initialMessage: request.body.initialMessage } : {}),
      });
      store.upsertThread({ ...thread, projectId: project.id });
      return reply.code(201).send(store.thread(thread.id));
    });

    this.app.post<{ Params: { id: string }; Body: StartTurnRequest }>("/api/threads/:id/turns", async (request, reply) => {
      const codex = this.#requiredCodex();
      const store = this.#requiredStore();
      const thread = store.localThread(request.params.id);
      if (!thread) return reply.code(404).send({ error: "Thread not found" });
      if (thread.state === "running" && thread.controlMode !== "full") {
        return reply.code(409).send({ error: "Desktop task is still running and is read-only" });
      }
      if (!request.body.text?.trim()) return reply.code(400).send({ error: "Message is required" });
      const turnId = await codex.startTurn(
        thread.id,
        request.body.text.trim(),
        request.body.model,
        request.body.effort,
      );
      store.upsertThread({ ...thread, origin: "web", controlMode: "full", state: "running", activeTurnId: turnId, updatedAt: new Date().toISOString() });
      return reply.code(202).send({ turnId });
    });

    this.app.post<{ Params: { id: string } }>("/api/threads/:id/interrupt", async (request, reply) => {
      await this.#requiredCodex().interrupt(request.params.id);
      return reply.code(202).send({ ok: true });
    });

    this.app.post<{ Params: { id: string }; Body: ResolveApprovalRequest }>("/api/approvals/:id/resolve", async (request) => {
      await this.#requiredCodex().resolveApproval(request.params.id, request.body.decision);
      return { ok: true };
    });

    this.app.get("/api/events", { websocket: true }, (socket, request) => {
      void (async () => {
        const device = await this.auth.authenticate(request.cookies[SESSION_COOKIE]);
        if (!device || !this.#originAllowed(request)) {
          socket.close(1008, "Pairing required");
          return;
        }
        const after = Number((request.query as { after?: string }).after ?? 0);
        const replay = this.events.replay(Number.isFinite(after) ? after : 0);
        if (replay.expired) socket.send(JSON.stringify({ type: "snapshot-invalidated", sequence: this.events.sequence, payload: { reason: "replay-expired" } }));
        for (const event of replay.events) socket.send(JSON.stringify(this.#clientEvent(event)));
        const unsubscribe = this.events.subscribe((event) => {
          if (socket.readyState === 1) socket.send(JSON.stringify(this.#clientEvent(event)));
        });
        socket.on("close", unsubscribe);
      })();
    });

    if (this.options.webRoot) {
      await this.app.register(fastifyStatic, { root: this.options.webRoot, wildcard: false });
      this.app.get("/*", async (_request, reply) => reply.sendFile("index.html"));
    }
  }

  #wireEventState(): void {
    this.events.subscribe((event) => {
      const store = this.#store;
      if (!store) return;
      if (event.type === "thread-upserted") store.updatePublicThread(event.payload as ThreadSummary, false);
      if (event.type === "timeline-item-upserted") store.upsertItem(event.payload as Parameters<StateStore["upsertItem"]>[0], false);
      if (event.type === "turn-state-changed") {
        const payload = event.payload as { threadId: string; turnId: string | null; state: ThreadSummary["state"] };
        const current = store.localThread(payload.threadId);
        if (current) store.upsertThread({ ...current, state: payload.state, activeTurnId: payload.state === "running" ? payload.turnId : null, updatedAt: new Date().toISOString() }, false);
      }
    });
  }

  #updateStatus(update: Partial<ServiceStatus>): void {
    this.#status = { ...this.#status, ...update };
    this.events.publish("status-changed", this.#status);
  }

  #originAllowed(request: FastifyRequest): boolean {
    const origin = headerString(request.headers.origin);
    if (!origin) return request.method === "GET";
    if (this.options.publicOrigin && origin === this.options.publicOrigin) return true;
    try {
      const parsed = new URL(origin);
      if (["127.0.0.1", "localhost"].includes(parsed.hostname)) return true;
      const forwardedHost = headerString(request.headers["x-forwarded-host"]) ?? headerString(request.headers.host);
      const forwardedProto = headerString(request.headers["x-forwarded-proto"]) ?? "https";
      return origin === `${forwardedProto}://${forwardedHost}`;
    } catch {
      return false;
    }
  }

  #allowPairAttempt(address: string): boolean {
    const now = Date.now();
    const current = this.#attempts.get(address);
    if (!current || current.resetAt <= now) {
      this.#attempts.set(address, { count: 1, resetAt: now + 5 * 60_000 });
      return true;
    }
    current.count += 1;
    return current.count <= 8;
  }

  #requiredCodex(): CodexController {
    if (!this.#codex?.connected) throw new Error("Codex app-server is offline");
    return this.#codex;
  }

  #requiredStore(): StateStore {
    if (!this.#store) throw new Error("Desktop state is not ready");
    return this.#store;
  }

  #deviceFrom(request: FastifyRequest): DeviceSummary {
    const device = this.#requestDevices.get(request);
    if (!device) throw new Error("Pairing required");
    return device;
  }

  #clientEvent(event: RealtimeEvent): RealtimeEvent {
    if (event.type === "timeline-item-upserted") {
      const item = event.payload as TimelineItem;
      const cwd = this.#store?.localThread(item.threadId)?.cwd ?? "";
      return { ...event, payload: sanitizeTimelineItem(item, cwd) };
    }
    if (event.type === "agent-message-delta") {
      const payload = event.payload as { delta?: string };
      return { ...event, payload: { ...payload, delta: sanitizeText(payload.delta ?? "") } };
    }
    if (event.type === "approval-created") return { ...event, payload: sanitizeApproval(event.payload as ApprovalSummary) };
    return event;
  }
}

export async function createControlServer(options: ServerOptions = {}): Promise<ControlServer> {
  const server = new ControlServer(options);
  await server.start();
  return server;
}

function headerString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function clientAddress(request: FastifyRequest): string {
  return headerString(request.headers["cf-connecting-ip"]) ?? headerString(request.headers["x-forwarded-for"])?.split(",")[0]?.trim() ?? request.ip;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sanitizeApproval(approval: ApprovalSummary): ApprovalSummary {
  return { ...approval, detail: sanitizeText(approval.detail) };
}
