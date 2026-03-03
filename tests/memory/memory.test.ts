/**
 * Unit tests for long-term memory (src/memory/long-term.ts)
 * and working memory (src/memory/working.ts).
 *
 * Covers InMemoryLongTermMemory CRUD, search/filtering, ordering,
 * and working memory creation/update/formatting.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryLongTermMemory } from "../../src/memory/long-term.js";
import {
  createWorkingMemory,
  updateWorkingMemory,
  formatWorkingMemoryForContext,
} from "../../src/memory/working.js";
import type { MemoryEntry, LongTermMemoryType } from "../../src/types.js";

// ---------------------------------------------------------------------------
// InMemoryLongTermMemory
// ---------------------------------------------------------------------------

describe("InMemoryLongTermMemory", () => {
  let mem: InMemoryLongTermMemory;

  beforeEach(() => {
    mem = new InMemoryLongTermMemory();
  });

  // --- add / get ---

  describe("add + get", () => {
    it("adds an entry and returns it with generated id and timestamp", async () => {
      const entry = await mem.add({
        type: "episodic",
        content: "Had a productive meeting",
      });

      expect(entry.id).toMatch(/^mem_/);
      expect(entry.type).toBe("episodic");
      expect(entry.content).toBe("Had a productive meeting");
      expect(entry.createdAt).toBeTruthy();
      expect(new Date(entry.createdAt).getTime()).not.toBeNaN();
    });

    it("retrieves an entry by id", async () => {
      const added = await mem.add({
        type: "semantic",
        content: "TypeScript supports generics",
      });

      const found = await mem.get(added.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(added.id);
      expect(found!.content).toBe("TypeScript supports generics");
    });

    it("returns null for nonexistent id", async () => {
      expect(await mem.get("nonexistent")).toBeNull();
    });

    it("preserves optional meta", async () => {
      const entry = await mem.add({
        type: "procedural",
        content: "Always run tests before commit",
        meta: { topic: "testing", importance: 8 },
      });

      expect(entry.meta).toEqual({ topic: "testing", importance: 8 });
    });
  });

  // --- list ---

  describe("list", () => {
    it("returns all entries when no type filter", async () => {
      await mem.add({ type: "episodic", content: "Event A" });
      await mem.add({ type: "semantic", content: "Fact B" });
      await mem.add({ type: "procedural", content: "Rule C" });

      const all = await mem.list();
      expect(all).toHaveLength(3);
    });

    it("filters by type", async () => {
      await mem.add({ type: "episodic", content: "Event A" });
      await mem.add({ type: "semantic", content: "Fact B" });
      await mem.add({ type: "episodic", content: "Event C" });

      const episodic = await mem.list("episodic");
      expect(episodic).toHaveLength(2);
      expect(episodic.every((e) => e.type === "episodic")).toBe(true);
    });

    it("returns entries sorted newest-first", async () => {
      const a = await mem.add({ type: "episodic", content: "First" });
      // Ensure different timestamp
      await new Promise((r) => setTimeout(r, 5));
      const b = await mem.add({ type: "episodic", content: "Second" });

      const list = await mem.list();
      // Most recent (b) should come first
      expect(list[0].id).toBe(b.id);
      expect(list[1].id).toBe(a.id);
    });

    it("returns empty array when store is empty", async () => {
      expect(await mem.list()).toEqual([]);
    });
  });

  // --- delete ---

  describe("delete", () => {
    it("deletes an existing entry and returns true", async () => {
      const entry = await mem.add({ type: "episodic", content: "Temporary" });
      const deleted = await mem.delete(entry.id);

      expect(deleted).toBe(true);
      expect(await mem.get(entry.id)).toBeNull();
    });

    it("returns false for nonexistent id", async () => {
      expect(await mem.delete("no_such_id")).toBe(false);
    });

    it("deleted entry no longer appears in list", async () => {
      const entry = await mem.add({ type: "episodic", content: "Gone soon" });
      await mem.delete(entry.id);

      const all = await mem.list();
      expect(all.find((e) => e.id === entry.id)).toBeUndefined();
    });
  });

  // --- search ---

  describe("search", () => {
    beforeEach(async () => {
      await mem.add({ type: "episodic", content: "Deployed the new API gateway", meta: { project: "dash" } });
      await mem.add({ type: "semantic", content: "Vitest supports ESM natively", meta: { topic: "testing" } });
      await mem.add({ type: "procedural", content: "Run npm test before deploying", meta: { project: "dash" } });
      await mem.add({ type: "episodic", content: "Fixed a bug in authentication", meta: { project: "bragbin" } });
    });

    it("searches by content substring", async () => {
      const results = await mem.search({ contentSubstring: "deploy" });
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.content.toLowerCase().includes("deploy"))).toBe(true);
    });

    it("searches by type", async () => {
      const results = await mem.search({ type: "episodic" });
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.type === "episodic")).toBe(true);
    });

    it("searches by meta filter", async () => {
      const results = await mem.search({ meta: { project: "dash" } });
      expect(results).toHaveLength(2);
    });

    it("combines type + content + meta filters", async () => {
      const results = await mem.search({
        type: "episodic",
        contentSubstring: "deploy",
        meta: { project: "dash" },
      });
      expect(results).toHaveLength(1);
      expect(results[0].content).toContain("API gateway");
    });

    it("ignores short search terms (<=2 chars)", async () => {
      // "a" is too short, should return everything (no content filter applied)
      const results = await mem.search({ contentSubstring: "a" });
      expect(results).toHaveLength(4);
    });

    it("returns empty for no matches", async () => {
      const results = await mem.search({ contentSubstring: "nonexistent_term_xyz" });
      expect(results).toEqual([]);
    });

    it("returns results sorted newest-first", async () => {
      const results = await mem.search({ meta: { project: "dash" } });
      const times = results.map((r) => new Date(r.createdAt).getTime());
      expect(times[0]).toBeGreaterThanOrEqual(times[1]);
    });

    it("returns empty when meta filter doesn't match any entries", async () => {
      const results = await mem.search({ meta: { project: "unknown" } });
      expect(results).toEqual([]);
    });

    it("handles entries without meta when filtering by meta", async () => {
      await mem.add({ type: "semantic", content: "No meta here" });
      const results = await mem.search({ meta: { project: "dash" } });
      // Should not include the entry without meta
      expect(results.find((r) => r.content === "No meta here")).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Working Memory
// ---------------------------------------------------------------------------

describe("Working Memory", () => {
  describe("createWorkingMemory", () => {
    it("creates empty working memory with defaults", () => {
      const wm = createWorkingMemory();
      expect(wm.retrieved).toEqual([]);
      expect(wm.scratch).toEqual({});
      expect(wm.perceptualInput).toBeUndefined();
      expect(wm.activeGoal).toBeUndefined();
      expect(wm.lastThought).toBeUndefined();
    });
  });

  describe("updateWorkingMemory", () => {
    it("returns a new object (immutable)", () => {
      const wm = createWorkingMemory();
      const updated = updateWorkingMemory(wm, { activeGoal: "Test" });
      expect(updated).not.toBe(wm);
    });

    it("merges scratch keys additively", () => {
      let wm = createWorkingMemory();
      wm = updateWorkingMemory(wm, { scratch: { a: 1 } });
      wm = updateWorkingMemory(wm, { scratch: { b: 2 } });
      expect(wm.scratch).toEqual({ a: 1, b: 2 });
    });

    it("overwrites existing scratch keys", () => {
      let wm = createWorkingMemory();
      wm = updateWorkingMemory(wm, { scratch: { count: 1 } });
      wm = updateWorkingMemory(wm, { scratch: { count: 5 } });
      expect(wm.scratch.count).toBe(5);
    });

    it("preserves fields not mentioned in updates", () => {
      let wm = createWorkingMemory();
      wm = updateWorkingMemory(wm, { activeGoal: "Goal A", lastThought: "Thinking..." });
      wm = updateWorkingMemory(wm, { activeGoal: "Goal B" });
      expect(wm.lastThought).toBe("Thinking...");
    });
  });

  describe("formatWorkingMemoryForContext", () => {
    it("returns empty string for bare working memory", () => {
      expect(formatWorkingMemoryForContext(createWorkingMemory())).toBe("");
    });

    it("formats only non-empty sections", () => {
      const wm = updateWorkingMemory(createWorkingMemory(), {
        activeGoal: "Ship it",
      });
      const formatted = formatWorkingMemoryForContext(wm);
      expect(formatted).toContain("## Active goal");
      expect(formatted).not.toContain("## Retrieved from memory");
      expect(formatted).not.toContain("## Latest thought");
    });

    it("formats retrieved entries with type labels", () => {
      const entry: MemoryEntry = {
        id: "m1",
        type: "semantic",
        content: "Vitest is fast",
        createdAt: new Date().toISOString(),
      };
      const wm = updateWorkingMemory(createWorkingMemory(), {
        retrieved: [entry],
      });
      const formatted = formatWorkingMemoryForContext(wm);
      expect(formatted).toContain("[semantic] Vitest is fast");
    });
  });
});
