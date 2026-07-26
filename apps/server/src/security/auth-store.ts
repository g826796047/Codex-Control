import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { DeviceSummary } from "@codex-control/shared";

interface DeviceRecord extends DeviceSummary {
  sessionHash: string;
}

interface AuthData {
  serverSecret: string;
  devices: DeviceRecord[];
}

interface PairingRecord {
  tokenHash: string;
  codeHash: string;
  expiresAt: number;
}

export class AuthStore {
  #data: AuthData = { serverSecret: "", devices: [] };
  #pairing: PairingRecord | null = null;
  #lastPersist = 0;

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    try {
      this.#data = JSON.parse(await readFile(this.path, "utf8")) as AuthData;
    } catch {
      this.#data = { serverSecret: randomBytes(32).toString("base64url"), devices: [] };
      await this.#persist();
    }
    if (!this.#data.serverSecret) {
      this.#data.serverSecret = randomBytes(32).toString("base64url");
      await this.#persist();
    }
  }

  createPairing(): { token: string; code: string; expiresAt: string } {
    const token = randomBytes(32).toString("base64url");
    const code = String(Math.floor(100_000_000 + Math.random() * 900_000_000));
    const expiresAt = Date.now() + 5 * 60_000;
    this.#pairing = { tokenHash: hash(token), codeHash: hash(code), expiresAt };
    return { token, code, expiresAt: new Date(expiresAt).toISOString() };
  }

  pairingOpen(): boolean {
    return this.#pairing !== null && this.#pairing.expiresAt > Date.now();
  }

  async pair(credential: string, deviceName: string): Promise<{ sessionToken: string; csrfToken: string; device: DeviceSummary }> {
    const pairing = this.#pairing;
    if (!pairing || pairing.expiresAt <= Date.now()) {
      this.#pairing = null;
      throw new Error("Pairing is closed or expired");
    }
    const credentialHash = hash(credential);
    if (!safeEqual(credentialHash, pairing.tokenHash) && !safeEqual(credentialHash, pairing.codeHash)) {
      throw new Error("Invalid pairing token or code");
    }
    this.#pairing = null;
    const sessionToken = randomBytes(32).toString("base64url");
    const now = new Date().toISOString();
    const record: DeviceRecord = {
      id: randomUUID(),
      name: sanitizeDeviceName(deviceName),
      sessionHash: hash(sessionToken),
      createdAt: now,
      lastSeenAt: now,
    };
    this.#data.devices.push(record);
    await this.#persist();
    return { sessionToken, csrfToken: this.csrfToken(record.id), device: toSummary(record) };
  }

  async authenticate(sessionToken: string | undefined): Promise<DeviceSummary | null> {
    if (!sessionToken) return null;
    const sessionHash = hash(sessionToken);
    const record = this.#data.devices.find((device) => safeEqual(device.sessionHash, sessionHash));
    if (!record) return null;
    record.lastSeenAt = new Date().toISOString();
    if (Date.now() - this.#lastPersist > 60_000) await this.#persist();
    return toSummary(record);
  }

  csrfToken(deviceId: string): string {
    return createHmac("sha256", this.#data.serverSecret).update(`csrf:${deviceId}`).digest("base64url");
  }

  validateCsrf(deviceId: string, token: string | undefined): boolean {
    return Boolean(token) && safeEqual(this.csrfToken(deviceId), token!);
  }

  listDevices(): DeviceSummary[] {
    return this.#data.devices.map(toSummary);
  }

  async revokeDevice(id: string): Promise<boolean> {
    const before = this.#data.devices.length;
    this.#data.devices = this.#data.devices.filter((device) => device.id !== id);
    if (this.#data.devices.length === before) return false;
    await this.#persist();
    return true;
  }

  async #persist(): Promise<void> {
    this.#lastPersist = Date.now();
    await writeFile(this.path, JSON.stringify(this.#data, null, 2), "utf8");
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function sanitizeDeviceName(value: string): string {
  const trimmed = value.trim().replace(/[\u0000-\u001f\u007f]/g, "");
  return trimmed.slice(0, 80) || "Mobile device";
}

function toSummary(record: DeviceRecord): DeviceSummary {
  return { id: record.id, name: record.name, createdAt: record.createdAt, lastSeenAt: record.lastSeenAt };
}

