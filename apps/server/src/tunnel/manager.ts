import { spawn, type ChildProcess } from "node:child_process";
import type { ServiceStatus } from "@codex-control/shared";

export class TunnelManager {
  #child: ChildProcess | null = null;
  #stopping = false;
  #attempt = 0;
  #timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly command: string,
    private readonly getToken: () => Promise<string | null>,
    private readonly getUrl: () => Promise<string | null>,
    private readonly onStatus: (state: ServiceStatus["tunnel"], url: string | null, message?: string) => void,
  ) {}

  async start(): Promise<void> {
    this.#stopping = false;
    const token = await this.getToken();
    const url = await this.getUrl();
    if (!token || !url) {
      this.onStatus("offline", url, "Cloudflare Named Tunnel is not configured");
      return;
    }
    this.onStatus("starting", url);
    const child = spawn(this.command, ["tunnel", "--no-autoupdate", "run"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, TUNNEL_TOKEN: token },
    });
    this.#child = child;
    let ready = false;
    const handleOutput = (chunk: Buffer | string) => {
      const text = String(chunk);
      if (!ready && /registered tunnel connection|connection .* registered/i.test(text)) {
        ready = true;
        this.#attempt = 0;
        this.onStatus("connected", url);
      }
    };
    child.stdout.on("data", handleOutput);
    child.stderr.on("data", handleOutput);
    child.on("error", (error) => this.#handleClose(url, error));
    child.on("exit", (code, signal) => this.#handleClose(url, new Error(`cloudflared exited (${code ?? signal ?? "unknown"})`)));
  }

  async restart(): Promise<void> {
    await this.stop();
    this.#stopping = false;
    await this.start();
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    const child = this.#child;
    this.#child = null;
    if (child?.exitCode === null) child.kill();
  }

  #handleClose(url: string | null, error: Error): void {
    this.#child = null;
    if (this.#stopping) return;
    this.onStatus("offline", url, error.message);
    const delay = Math.min(30_000, 1_000 * 2 ** this.#attempt++);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.start();
    }, delay);
    this.#timer.unref();
  }
}
