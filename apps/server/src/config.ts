import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const EXPECTED_CODEX_VERSION = "0.146.0-alpha.3";
export const CLOUDFLARED_VERSION = "2026.7.3";

export interface ServerOptions {
  host?: string;
  port?: number;
  dataDir?: string;
  codexHome?: string;
  webRoot?: string | null;
  codexPath?: string | null;
  cloudflaredPath?: string | null;
  publicOrigin?: string | null;
  externalTunnel?: boolean;
  secureCookies?: boolean;
  autoDownloadBinaries?: boolean;
  getTunnelToken?: () => Promise<string | null>;
  getTunnelUrl?: () => Promise<string | null>;
  logger?: boolean;
}

export interface ResolvedServerOptions {
  host: string;
  port: number;
  dataDir: string;
  codexHome: string;
  webRoot: string | null;
  codexPath: string | null;
  cloudflaredPath: string | null;
  publicOrigin: string | null;
  externalTunnel: boolean;
  secureCookies: boolean;
  autoDownloadBinaries: boolean;
  getTunnelToken: () => Promise<string | null>;
  getTunnelUrl: () => Promise<string | null>;
  logger: boolean;
}

export function resolveServerOptions(options: ServerOptions = {}): ResolvedServerOptions {
  const dataDir = resolve(options.dataDir ?? join(homedir(), ".codex-control"));
  return {
    host: options.host ?? "127.0.0.1",
    port: options.port ?? 4689,
    dataDir,
    codexHome: resolve(options.codexHome ?? join(homedir(), ".codex")),
    webRoot: options.webRoot ? resolve(options.webRoot) : null,
    codexPath: options.codexPath ? resolve(options.codexPath) : null,
    cloudflaredPath: options.cloudflaredPath ? resolve(options.cloudflaredPath) : null,
    publicOrigin: options.publicOrigin ?? null,
    externalTunnel: options.externalTunnel ?? false,
    secureCookies: options.secureCookies ?? true,
    autoDownloadBinaries: options.autoDownloadBinaries ?? true,
    getTunnelToken: options.getTunnelToken ?? (async () => process.env.CODEX_CONTROL_TUNNEL_TOKEN ?? null),
    getTunnelUrl: options.getTunnelUrl ?? (async () => process.env.CODEX_CONTROL_PUBLIC_URL ?? null),
    logger: options.logger ?? true,
  };
}
