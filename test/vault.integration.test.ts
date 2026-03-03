/**
 * Integration tests: Encrypted vault key storage.
 *
 * Tests CRUD operations on the vault with encryption,
 * env hydration, and multi-key management.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomKey, createTempDir } from "./helpers.js";
import { encrypt, decrypt } from "../src/auth/crypto.js";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Vault operations (tested at the crypto + file layer since the vault module
// uses process.cwd() for paths — we replicate the logic here)
// ---------------------------------------------------------------------------

describe("Vault encrypted storage", () => {
  let vaultDir: string;
  let vaultFile: string;
  let cleanup: () => Promise<void>;

  type VaultEntry = { value: string; label?: string };
  type VaultData = Record<string, VaultEntry>;

  async function saveVault(data: VaultData, key: Buffer): Promise<void> {
    const payload = encrypt(JSON.stringify(data), key);
    await writeFile(vaultFile, JSON.stringify({ v: 1, ...payload }));
  }

  async function loadVault(key: Buffer): Promise<VaultData> {
    try {
      const raw = await readFile(vaultFile, "utf-8");
      const file = JSON.parse(raw);
      const plaintext = decrypt(
        { ciphertext: file.ciphertext, iv: file.iv, authTag: file.authTag },
        key,
      );
      return JSON.parse(plaintext) as VaultData;
    } catch {
      return {};
    }
  }

  beforeEach(async () => {
    const tmp = await createTempDir("dash-vault-");
    vaultDir = join(tmp.dir, "vault");
    vaultFile = join(vaultDir, "keys.json");
    await mkdir(vaultDir, { recursive: true });
    cleanup = tmp.cleanup;
  });

  afterEach(async () => {
    await cleanup();
  });

  it("should store and retrieve a single key", async () => {
    const key = randomKey();
    const data: VaultData = {
      OPENROUTER_API_KEY: { value: "sk-or-abc123", label: "OpenRouter" },
    };

    await saveVault(data, key);
    const loaded = await loadVault(key);
    expect(loaded.OPENROUTER_API_KEY.value).toBe("sk-or-abc123");
    expect(loaded.OPENROUTER_API_KEY.label).toBe("OpenRouter");
  });

  it("should store and retrieve multiple keys", async () => {
    const key = randomKey();
    const data: VaultData = {
      OPENROUTER_API_KEY: { value: "sk-or-abc" },
      LINEAR_API_KEY: { value: "lin_abc" },
      PERPLEXITY_API_KEY: { value: "pplx-abc", label: "Perplexity" },
    };

    await saveVault(data, key);
    const loaded = await loadVault(key);
    expect(Object.keys(loaded).length).toBe(3);
    expect(loaded.LINEAR_API_KEY.value).toBe("lin_abc");
  });

  it("should update an existing key", async () => {
    const key = randomKey();
    await saveVault({ API_KEY: { value: "old" } }, key);

    const loaded = await loadVault(key);
    loaded.API_KEY = { value: "new", label: "Updated" };
    await saveVault(loaded, key);

    const updated = await loadVault(key);
    expect(updated.API_KEY.value).toBe("new");
    expect(updated.API_KEY.label).toBe("Updated");
  });

  it("should delete a key", async () => {
    const key = randomKey();
    await saveVault({
      KEEP: { value: "a" },
      DELETE_ME: { value: "b" },
    }, key);

    const loaded = await loadVault(key);
    delete loaded.DELETE_ME;
    await saveVault(loaded, key);

    const updated = await loadVault(key);
    expect(updated.KEEP).toBeDefined();
    expect(updated.DELETE_ME).toBeUndefined();
  });

  it("should list keys without exposing values", async () => {
    const key = randomKey();
    const data: VaultData = {
      SECRET_1: { value: "s1", label: "First" },
      SECRET_2: { value: "s2" },
    };

    await saveVault(data, key);
    const loaded = await loadVault(key);

    // Simulate listVaultKeys behavior
    const listing = Object.entries(loaded).map(([name, entry]) => ({
      name,
      label: entry.label,
    }));

    expect(listing).toEqual([
      { name: "SECRET_1", label: "First" },
      { name: "SECRET_2", label: undefined },
    ]);

    // Ensure values are not in the listing
    const listingStr = JSON.stringify(listing);
    expect(listingStr).not.toContain("s1");
    expect(listingStr).not.toContain("s2");
  });

  it("should fail to read vault with wrong key", async () => {
    const key1 = randomKey();
    const key2 = randomKey();
    await saveVault({ SECRET: { value: "hidden" } }, key1);

    // loadVault should return empty on wrong key (graceful)
    const loaded = await loadVault(key2);
    expect(loaded).toEqual({});
  });

  it("should return empty vault when file doesn't exist", async () => {
    const key = randomKey();
    const loaded = await loadVault(key);
    expect(loaded).toEqual({});
  });

  it("should simulate env hydration", async () => {
    const key = randomKey();
    const data: VaultData = {
      MY_API_KEY: { value: "test-key-123" },
      OTHER_KEY: { value: "other-456" },
    };

    await saveVault(data, key);
    const loaded = await loadVault(key);

    // Simulate hydrateEnv
    const savedEnv: Record<string, string | undefined> = {};
    for (const [name, entry] of Object.entries(loaded)) {
      savedEnv[name] = process.env[name]; // save current
      process.env[name] = entry.value;
    }

    expect(process.env.MY_API_KEY).toBe("test-key-123");
    expect(process.env.OTHER_KEY).toBe("other-456");

    // Cleanup
    for (const [name] of Object.entries(loaded)) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
  });

  it("should use fresh IV on every write (different ciphertext each time)", async () => {
    const key = randomKey();
    const data: VaultData = { KEY: { value: "same" } };

    await saveVault(data, key);
    const raw1 = await readFile(vaultFile, "utf-8");

    await saveVault(data, key);
    const raw2 = await readFile(vaultFile, "utf-8");

    const f1 = JSON.parse(raw1);
    const f2 = JSON.parse(raw2);

    // Different IVs → different ciphertext
    expect(f1.iv).not.toBe(f2.iv);
    expect(f1.ciphertext).not.toBe(f2.ciphertext);
  });

  it("should handle special characters in values", async () => {
    const key = randomKey();
    const data: VaultData = {
      SPECIAL: { value: "p@$$w0rd!#%^&*()=+[]{}" },
      UNICODE: { value: "日本語キー🔑" },
      MULTILINE: { value: "line1\nline2\nline3" },
    };

    await saveVault(data, key);
    const loaded = await loadVault(key);

    expect(loaded.SPECIAL.value).toBe("p@$$w0rd!#%^&*()=+[]{}");
    expect(loaded.UNICODE.value).toBe("日本語キー🔑");
    expect(loaded.MULTILINE.value).toBe("line1\nline2\nline3");
  });
});
