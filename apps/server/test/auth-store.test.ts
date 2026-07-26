import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuthStore } from "../src/security/auth-store.js";

describe("AuthStore", () => {
  it("consumes a one-time token, stores only hashes and revokes the device", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codex-control-auth-"));
    const path = join(dir, "auth.json");
    const store = new AuthStore(path);
    await store.load();
    const pairing = store.createPairing();
    const result = await store.pair(pairing.token, "Test phone");
    expect(await store.authenticate(result.sessionToken)).toMatchObject({ name: "Test phone" });
    expect(store.validateCsrf(result.device.id, result.csrfToken)).toBe(true);

    const persisted = await readFile(path, "utf8");
    expect(persisted).not.toContain(pairing.token);
    expect(persisted).not.toContain(result.sessionToken);

    await expect(store.pair(pairing.token, "Second use")).rejects.toThrow(/closed|expired/i);
    expect(await store.revokeDevice(result.device.id)).toBe(true);
    expect(await store.authenticate(result.sessionToken)).toBeNull();
  });

  it("rejects an invalid manual pairing code", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codex-control-auth-"));
    const store = new AuthStore(join(dir, "auth.json"));
    await store.load();
    store.createPairing();
    await expect(store.pair("000000000", "Intruder")).rejects.toThrow(/invalid/i);
  });
});
