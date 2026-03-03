/**
 * Unit tests for FileSystemLongTermMemory (src/memory/file-backed.ts).
 * Covers add, list, get, delete (no-op), search, type-to-file mapping,
 * append-only persistence, and archived entry filtering.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FileSystemLongTermMemory } from "../src/memory/file-backed.js";
import { createTestBrainDir } from "./helpers.js";

let memoryDir: string;
let cleanup: () => Promise<void>;
let ltm: FileSystemLongTermMemory;

beforeEach(async () => {
  const env = await createTestBrainDir();
  memoryDir = env.memoryDir;
  cleanup = env.cleanup;
  ltm = new FileSystemLongTermMemory(memoryDir);
});

afterEach(async () => {
  await cleanup();
});

describe("FileSystemLongTermMemory — add", () => {
  it("adds an episodic entry and returns it with id and timestamp", async () => {
    const entry = await ltm.add({
      type: "episodic",
      content: "Had a productive meeting",
    });

    expect(entry.id).toMatch(/^mem_/);
    expect(entry.type).toBe("episodic");
    expect(entry.content).toBe("Had a productive meeting");
    expect(entry.createdAt).toBeTruthy();
  });

  it("writes episodic entries to experiences.jsonl", async () => {
    await ltm.add({ type: "episodic", content: "Experience one" });

    const raw = await readFile(join(memoryDir, "experiences.jsonl"), "utf-8");
    expect(raw).toContain("Experience one");
  });

  it("writes semantic entries to semantic.jsonl", async () => {
    await ltm.add({ type: "semantic", content: "TypeScript is typed JS" });

    const raw = await readFile(join(memoryDir, "semantic.jsonl"), "utf-8");
    expect(raw).toContain("TypeScript is typed JS");
  });

  it("writes procedural entries to procedural.jsonl", async () => {
    await ltm.add({ type: "procedural", content: "npm run build compiles TS" });

    const raw = await readFile(join(memoryDir, "procedural.jsonl"), "utf-8");
    expect(raw).toContain("npm run build compiles TS");
  });

  it("preserves metadata on entries", async () => {
    const entry = await ltm.add({
      type: "semantic",
      content: "Fact",
      meta: { topic: "testing", confidence: 0.9 },
    });

    expect(entry.meta).toEqual({ topic: "testing", confidence: 0.9 });
  });
});

describe("FileSystemLongTermMemory — list", () => {
  it("lists all entries across types", async () => {
    await ltm.add({ type: "episodic", content: "E1" });
    await ltm.add({ type: "semantic", content: "S1" });
    await ltm.add({ type: "procedural", content: "P1" });

    const all = await ltm.list();
    expect(all).toHaveLength(3);
  });

  it("filters by type", async () => {
    await ltm.add({ type: "episodic", content: "E1" });
    await ltm.add({ type: "episodic", content: "E2" });
    await ltm.add({ type: "semantic", content: "S1" });

    const episodic = await ltm.list("episodic");
    expect(episodic).toHaveLength(2);
    expect(episodic.every((e) => e.type === "episodic")).toBe(true);
  });

  it("returns newest first", async () => {
    const e1 = await ltm.add({ type: "episodic", content: "First" });
    const e2 = await ltm.add({ type: "episodic", content: "Second" });

    const list = await ltm.list("episodic");
    // e2 should come before e1 (newest first)
    expect(list[0].content).toBe("Second");
    expect(list[1].content).toBe("First");
  });
});

describe("FileSystemLongTermMemory — get", () => {
  it("finds an entry by id", async () => {
    const added = await ltm.add({ type: "semantic", content: "Find me" });
    const found = await ltm.get(added.id);

    expect(found).not.toBeNull();
    expect(found!.content).toBe("Find me");
  });

  it("returns null for nonexistent id", async () => {
    expect(await ltm.get("mem_nonexistent")).toBeNull();
  });
});

describe("FileSystemLongTermMemory — delete", () => {
  it("returns false (append-only, no delete support)", async () => {
    const entry = await ltm.add({ type: "episodic", content: "Undeletable" });
    expect(await ltm.delete(entry.id)).toBe(false);
  });
});

describe("FileSystemLongTermMemory — search", () => {
  it("finds entries by content substring", async () => {
    await ltm.add({ type: "episodic", content: "Worked on vitest setup" });
    await ltm.add({ type: "episodic", content: "Went to the store" });
    await ltm.add({ type: "semantic", content: "Vitest is fast" });

    const results = await ltm.search({ contentSubstring: "vitest" });
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results.every((r) => r.content.toLowerCase().includes("vitest"))).toBe(true);
  });

  it("filters search by type", async () => {
    await ltm.add({ type: "episodic", content: "Testing is fun" });
    await ltm.add({ type: "semantic", content: "Testing frameworks exist" });

    const results = await ltm.search({ type: "semantic", contentSubstring: "testing" });
    expect(results.every((r) => r.type === "semantic")).toBe(true);
  });

  it("filters by metadata", async () => {
    await ltm.add({ type: "semantic", content: "A", meta: { topic: "code" } });
    await ltm.add({ type: "semantic", content: "B", meta: { topic: "design" } });

    const results = await ltm.search({ meta: { topic: "code" } });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("A");
  });

  it("returns all entries when no filters given", async () => {
    await ltm.add({ type: "episodic", content: "One" });
    await ltm.add({ type: "semantic", content: "Two" });

    const results = await ltm.search({});
    expect(results).toHaveLength(2);
  });

  it("ignores short search terms (<=2 chars)", async () => {
    await ltm.add({ type: "episodic", content: "An apple" });

    // "an" is 2 chars, should be filtered out, returning all entries
    const results = await ltm.search({ contentSubstring: "an" });
    expect(results).toHaveLength(1); // all entries returned since no valid terms
  });
});

describe("FileSystemLongTermMemory — archived entries", () => {
  it("excludes entries marked as archived", async () => {
    const entry = await ltm.add({ type: "episodic", content: "Active memory" });

    // Manually append an archived version to the JSONL file
    const archivedLine = JSON.stringify({
      id: entry.id,
      status: "archived",
    });
    const filePath = join(memoryDir, "experiences.jsonl");
    const raw = await readFile(filePath, "utf-8");
    await writeFile(filePath, raw + archivedLine + "\n", "utf-8");

    // New instance should filter it out
    const ltm2 = new FileSystemLongTermMemory(memoryDir);
    const all = await ltm2.list("episodic");
    expect(all.find((e) => e.id === entry.id)).toBeUndefined();
  });
});

describe("FileSystemLongTermMemory — persistence", () => {
  it("persists entries across instances", async () => {
    await ltm.add({ type: "episodic", content: "Persistent memory" });

    const ltm2 = new FileSystemLongTermMemory(memoryDir);
    const all = await ltm2.list();
    expect(all).toHaveLength(1);
    expect(all[0].content).toBe("Persistent memory");
  });

  it("creates schema header on first write", async () => {
    await ltm.add({ type: "semantic", content: "First entry" });

    const raw = await readFile(join(memoryDir, "semantic.jsonl"), "utf-8");
    const firstLine = raw.split("\n")[0];
    const schema = JSON.parse(firstLine);
    expect(schema._schema).toBe("semantic");
    expect(schema._version).toBe("1.0");
  });
});
