import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { CLOUDFLARED_VERSION, EXPECTED_CODEX_VERSION } from "../config.js";

interface BinaryManifest {
  name: string;
  fileName: string;
  url: string;
  sha256: string;
  size: number;
}

const CODEX: BinaryManifest = {
  name: `Codex CLI ${EXPECTED_CODEX_VERSION}`,
  fileName: `codex-${EXPECTED_CODEX_VERSION}.exe`,
  url: `https://github.com/openai/codex/releases/download/rust-v${EXPECTED_CODEX_VERSION}/codex-x86_64-pc-windows-msvc.exe`,
  sha256: "6aeaca6a797ed7e5d8163d750e10947f098ceb0f1faff02fedaef487602c2fe2",
  size: 353_726_768,
};

const CLOUDFLARED: BinaryManifest = {
  name: `cloudflared ${CLOUDFLARED_VERSION}`,
  fileName: `cloudflared-${CLOUDFLARED_VERSION}.exe`,
  url: `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-windows-amd64.exe`,
  sha256: "8635da433b6df8194746e88ed9d2589566c20e38bfc2a80e431a348b7c765841",
  size: 54_213_360,
};

export class BinaryManager {
  constructor(private readonly binDir: string) {}

  async ensureCodex(explicitPath: string | null, allowDownload: boolean): Promise<string> {
    if (explicitPath) return explicitPath;
    const installed = await findInstalledCodex();
    if (installed) return installed;
    return this.ensure(CODEX, allowDownload);
  }

  async ensureCloudflared(explicitPath: string | null, allowDownload: boolean): Promise<string> {
    if (explicitPath) return explicitPath;
    return this.ensure(CLOUDFLARED, allowDownload);
  }

  private async ensure(manifest: BinaryManifest, allowDownload: boolean): Promise<string> {
    const target = join(this.binDir, manifest.fileName);
    if (await matchesManifest(target, manifest)) return target;
    if (!allowDownload) throw new Error(`${manifest.name} is missing and automatic download is disabled`);
    await mkdir(this.binDir, { recursive: true });
    const temporary = `${target}.download`;
    await rm(temporary, { force: true });
    const response = await fetch(manifest.url, { redirect: "follow" });
    if (!response.ok || !response.body) throw new Error(`Failed to download ${manifest.name}: HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(temporary));
    if (!(await matchesManifest(temporary, manifest))) {
      await rm(temporary, { force: true });
      throw new Error(`${manifest.name} checksum verification failed`);
    }
    await rename(temporary, target);
    await chmod(target, 0o755).catch(() => undefined);
    return target;
  }
}

async function findInstalledCodex(): Promise<string | null> {
  const candidates = [
    join(homedir(), ".codex", "plugins", ".plugin-appserver", "codex.exe"),
  ];
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const desktopBin = join(localAppData, "OpenAI", "Codex", "bin");
    candidates.push(join(desktopBin, "codex.exe"));
    try {
      for (const entry of await readdir(desktopBin, { withFileTypes: true })) {
        if (entry.isDirectory()) candidates.push(join(desktopBin, entry.name, "codex.exe"));
      }
    } catch {
      // Codex Desktop is optional; fall back to the managed download below.
    }
  }
  for (const candidate of candidates) {
    if (await matchesManifest(candidate, CODEX)) return candidate;
  }
  return null;
}

async function matchesManifest(path: string, manifest: BinaryManifest): Promise<boolean> {
  try {
    const info = await stat(path);
    if (info.size !== manifest.size) return false;
    const { createReadStream } = await import("node:fs");
    const hash = createHash("sha256");
    await pipeline(createReadStream(path), hash);
    return hash.digest("hex") === manifest.sha256;
  } catch {
    return false;
  }
}

export function binaryDirectory(dataDir: string): string {
  return join(dirname(dataDir), "codex-control-binaries");
}
