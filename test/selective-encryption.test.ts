/**
 * Tests for DASH-148: selective encryption — episodic memory only.
 * Verifies that experiences.jsonl is encrypted while semantic.jsonl stays plaintext.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { FileSystemLongTermMemory } from "../src/memory/file-backed.js";
import { isEncryptedLine } from "../src/lib/encryption.js";
import { shouldEncryptFile, getEncryptedFileList } from "../src/lib/encryption-config.js";
import { createTestBrainDir, randomKey } from "./helpers.js";

let memoryDir: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  const env = await createTestBrainDir();
  memoryDir = env.memoryDir;
  cleanup = env.cleanup;
});

afterEach(async () => {
  await cleanup();
});

describe("encryption config", () => {
  it("marks memory files as encrypted", () => {
    expect(shouldEncryptFile("experiences.jsonl")).toBe(true);
    expect(shouldEncryptFile("decisions.jsonl")).toBe(true);
    expect(shouldEncryptFile("failures.jsonl")).toBe(true);
    expect(shouldEncryptFile("triads.jsonl")).toBe(true);
    expect(shouldEncryptFile("semantic.jsonl")).toBe(true);
    expect(shouldEncryptFile("embeddings.jsonl")).toBe(true);
    expect(shouldEncryptFile("open-loops.jsonl")).toBe(true);
    expect(shouldEncryptFile("resonances.jsonl")).toBe(true);
  });

  it("keeps structural files plaintext", () => {
    expect(shouldEncryptFile("procedural.jsonl")).toBe(false);
    expect(shouldEncryptFile("queue.jsonl")).toBe(false);
    expect(shouldEncryptFile("goals.yaml")).toBe(false);
  });

  it("returns the full encrypted file list", () => {
    const list = getEncryptedFileList();
    expect(list).toContain("experiences.jsonl");
    expect(list).toContain("decisions.jsonl");
    expect(list).toContain("failures.jsonl");
    expect(list).toContain("triads.jsonl");
    expect(list).toContain("semantic.jsonl");
    expect(list).toContain("embeddings.jsonl");
    expect(list).toContain("open-loops.jsonl");
    expect(list).toContain("resonances.jsonl");
    expect(list).toHaveLength(9);
  });
});

describe("selective encryption — episodic encrypted, semantic plaintext", () => {
  it("encrypts episodic entries on disk when key is provided", async () => {
    const key = randomKey();
    const ltm = new FileSystemLongTermMemory(memoryDir, key);

    await ltm.add({ type: "episodic", content: "Secret experience" });

    const raw = await readFile(join(memoryDir, "experiences.jsonl"), "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim());
    // Both schema line and data line should be encrypted
    expect(lines.every((l) => isEncryptedLine(l))).toBe(true);
    // Plaintext content should NOT appear on disk
    expect(raw).not.toContain("Secret experience");
  });

  it("encrypts semantic entries on disk when key is provided", async () => {
    const key = randomKey();
    const ltm = new FileSystemLongTermMemory(memoryDir, key);

    await ltm.add({ type: "semantic", content: "Sensitive fact" });

    const raw = await readFile(join(memoryDir, "semantic.jsonl"), "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim());
    // All lines should be encrypted
    expect(lines.every((l) => isEncryptedLine(l))).toBe(true);
    // Plaintext content should NOT appear on disk
    expect(raw).not.toContain("Sensitive fact");
  });

  it("keeps procedural entries plaintext even with encryption key", async () => {
    const key = randomKey();
    const ltm = new FileSystemLongTermMemory(memoryDir, key);

    await ltm.add({ type: "procedural", content: "How to deploy" });

    const raw = await readFile(join(memoryDir, "procedural.jsonl"), "utf-8");
    expect(raw).toContain("How to deploy");
    const lines = raw.split("\n").filter((l) => l.trim());
    expect(lines.some((l) => isEncryptedLine(l))).toBe(false);
  });

  it("roundtrips encrypted episodic entries correctly", async () => {
    const key = randomKey();
    const ltm = new FileSystemLongTermMemory(memoryDir, key);

    const added = await ltm.add({ type: "episodic", content: "Roundtrip test" });

    // Read back with same key
    const ltm2 = new FileSystemLongTermMemory(memoryDir, key);
    const all = await ltm2.list("episodic");
    expect(all).toHaveLength(1);
    expect(all[0].content).toBe("Roundtrip test");
    expect(all[0].id).toBe(added.id);
  });

  it("roundtrips encrypted semantic entries with same key", async () => {
    const key = randomKey();
    const ltm = new FileSystemLongTermMemory(memoryDir, key);

    await ltm.add({ type: "semantic", content: "Fact survives" });

    // Read back with same key
    const ltm2 = new FileSystemLongTermMemory(memoryDir, key);
    const all = await ltm2.list("semantic");
    expect(all).toHaveLength(1);
    expect(all[0].content).toBe("Fact survives");
  });

  it("handles mixed encrypted and plaintext lines (backward compat)", async () => {
    // Write one entry without encryption
    const ltmPlain = new FileSystemLongTermMemory(memoryDir);
    await ltmPlain.add({ type: "episodic", content: "Old plaintext entry" });

    // Write another with encryption
    const key = randomKey();
    const ltmEncrypted = new FileSystemLongTermMemory(memoryDir, key);
    await ltmEncrypted.add({ type: "episodic", content: "New encrypted entry" });

    // Read with key — should see both
    const ltm3 = new FileSystemLongTermMemory(memoryDir, key);
    const all = await ltm3.list("episodic");
    expect(all).toHaveLength(2);
    const contents = all.map((e) => e.content);
    expect(contents).toContain("Old plaintext entry");
    expect(contents).toContain("New encrypted entry");
  });
});
