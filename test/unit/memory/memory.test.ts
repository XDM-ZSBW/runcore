import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryLongTermMemory } from "../../../src/memory/long-term.js";
import {
  createWorkingMemory,
  updateWorkingMemory,
  formatWorkingMemoryForContext,
} from "../../../src/memory/working.js";
import type { MemoryEntry, WorkingMemory } from "../../../src/types.js";

// ═══════════════════════════════════════════════════════════════════════
// InMemoryLongTermMemory
// ═══════════════════════════════════════════════════════════════════════

describe("InMemoryLongTermMemory", () => {
  let memory: InMemoryLongTermMemory;

  beforeEach(() => {
    memory = new InMemoryLongTermMemory();
  });

  // ── Add ─────────────────────────────────────────────────────────────

  describe("add", () => {
    it("creates an entry with generated id and createdAt", async () => {
      const entry = await memory.add({
        type: "episodic",
        content: "Had a good meeting",
      });
      expect(entry.id).toMatch(/^mem_/);
      expect(entry.createdAt).toBeTruthy();
      expect(entry.type).toBe("episodic");
      expect(entry.content).toBe("Had a good meeting");
    });

    it("preserves metadata", async () => {
      const entry = await memory.add({
        type: "semantic",
        content: "TypeScript uses .ts extension",
        meta: { topic: "typescript", confidence: 0.9 },
      });
      expect(entry.meta).toEqual({ topic: "typescript", confidence: 0.9 });
    });

    it("generates unique ids for different entries", async () => {
      const e1 = await memory.add({ type: "episodic", content: "First" });
      const e2 = await memory.add({ type: "episodic", content: "Second" });
      expect(e1.id).not.toBe(e2.id);
    });
  });

  // ── Get ─────────────────────────────────────────────────────────────

  describe("get", () => {
    it("retrieves an entry by id", async () => {
      const added = await memory.add({ type: "procedural", content: "How to deploy" });
      const found = await memory.get(added.id);
      expect(found).not.toBeNull();
      expect(found!.content).toBe("How to deploy");
    });

    it("returns null for non-existent id", async () => {
      expect(await memory.get("mem_nonexistent")).toBeNull();
    });
  });

  // ── List ────────────────────────────────────────────────────────────

  describe("list", () => {
    it("returns all entries sorted by createdAt descending", async () => {
      // Use explicit timestamps to avoid same-millisecond non-determinism
      const e1 = await memory.add({ type: "episodic", content: "Older" });
      // Manually backdate e1 so e2 is clearly newer
      const stored1 = await memory.get(e1.id);
      (stored1 as any).createdAt = "2025-01-01T00:00:00.000Z";
      const e2 = await memory.add({ type: "semantic", content: "Newer" });
      const all = await memory.list();
      expect(all).toHaveLength(2);
      // Most recent first
      expect(all[0].id).toBe(e2.id);
      expect(all[1].id).toBe(e1.id);
    });

    it("filters by type", async () => {
      await memory.add({ type: "episodic", content: "Experience" });
      await memory.add({ type: "semantic", content: "Fact" });
      await memory.add({ type: "procedural", content: "How-to" });

      const episodic = await memory.list("episodic");
      expect(episodic).toHaveLength(1);
      expect(episodic[0].content).toBe("Experience");

      const semantic = await memory.list("semantic");
      expect(semantic).toHaveLength(1);
      expect(semantic[0].content).toBe("Fact");
    });

    it("returns empty array when no entries match type", async () => {
      await memory.add({ type: "episodic", content: "Only episodic" });
      expect(await memory.list("procedural")).toEqual([]);
    });
  });

  // ── Delete ──────────────────────────────────────────────────────────

  describe("delete", () => {
    it("removes an entry by id", async () => {
      const entry = await memory.add({ type: "episodic", content: "Temporary" });
      const result = await memory.delete(entry.id);
      expect(result).toBe(true);
      expect(await memory.get(entry.id)).toBeNull();
    });

    it("returns false for non-existent id", async () => {
      expect(await memory.delete("mem_nonexistent")).toBe(false);
    });
  });

  // ── Search ──────────────────────────────────────────────────────────

  describe("search", () => {
    beforeEach(async () => {
      await memory.add({
        type: "episodic",
        content: "Deployed the application to production",
        meta: { project: "dash", importance: 8 },
      });
      await memory.add({
        type: "semantic",
        content: "Production deployments require CI checks",
        meta: { project: "dash", category: "devops" },
      });
      await memory.add({
        type: "procedural",
        content: "Run npm build before deploying",
        meta: { project: "bragbin" },
      });
    });

    it("searches by content substring", async () => {
      const results = await memory.search({ contentSubstring: "deploy" });
      // "deploy" matches all 3: "Deployed", "deployments", "deploying"
      expect(results).toHaveLength(3);
    });

    it("filters by type", async () => {
      const results = await memory.search({ type: "semantic" });
      expect(results).toHaveLength(1);
      expect(results[0].type).toBe("semantic");
    });

    it("filters by type and content substring", async () => {
      const results = await memory.search({
        type: "episodic",
        contentSubstring: "production",
      });
      expect(results).toHaveLength(1);
      expect(results[0].content).toContain("production");
    });

    it("filters by metadata", async () => {
      const results = await memory.search({ meta: { project: "dash" } });
      expect(results).toHaveLength(2);
    });

    it("filters by combined type and metadata", async () => {
      const results = await memory.search({
        type: "semantic",
        meta: { category: "devops" },
      });
      expect(results).toHaveLength(1);
      expect(results[0].content).toContain("CI checks");
    });

    it("ignores search terms shorter than 3 characters", async () => {
      // "to" is < 3 chars, should be ignored, returning all
      const results = await memory.search({ contentSubstring: "to" });
      expect(results).toHaveLength(3);
    });

    it("returns empty for no matches", async () => {
      const results = await memory.search({ contentSubstring: "nonexistent_word_xyz" });
      expect(results).toEqual([]);
    });

    it("returns results sorted by createdAt descending", async () => {
      const results = await memory.search({ contentSubstring: "deploy" });
      const dates = results.map((r) => new Date(r.createdAt).getTime());
      for (let i = 1; i < dates.length; i++) {
        expect(dates[i - 1]).toBeGreaterThanOrEqual(dates[i]);
      }
    });

    it("returns empty when metadata does not match", async () => {
      const results = await memory.search({ meta: { project: "nonexistent" } });
      expect(results).toEqual([]);
    });

    it("entries without meta are excluded by metadata filter", async () => {
      await memory.add({ type: "episodic", content: "No meta here" });
      const results = await memory.search({ meta: { project: "dash" } });
      // Only the 2 original entries with project: "dash"
      expect(results).toHaveLength(2);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Working Memory
// ═══════════════════════════════════════════════════════════════════════

describe("Working Memory", () => {
  describe("createWorkingMemory", () => {
    it("returns initial working memory with empty retrieved and scratch", () => {
      const wm = createWorkingMemory();
      expect(wm.retrieved).toEqual([]);
      expect(wm.scratch).toEqual({});
      expect(wm.perceptualInput).toBeUndefined();
      expect(wm.activeGoal).toBeUndefined();
      expect(wm.lastThought).toBeUndefined();
    });
  });

  describe("updateWorkingMemory", () => {
    it("sets activeGoal", () => {
      const wm = createWorkingMemory();
      const updated = updateWorkingMemory(wm, { activeGoal: "Write blog post" });
      expect(updated.activeGoal).toBe("Write blog post");
    });

    it("sets perceptualInput", () => {
      const wm = createWorkingMemory();
      const updated = updateWorkingMemory(wm, { perceptualInput: "User asked a question" });
      expect(updated.perceptualInput).toBe("User asked a question");
    });

    it("sets lastThought", () => {
      const wm = createWorkingMemory();
      const updated = updateWorkingMemory(wm, { lastThought: "Need to research first" });
      expect(updated.lastThought).toBe("Need to research first");
    });

    it("replaces retrieved entries", () => {
      const wm = createWorkingMemory();
      const entries: MemoryEntry[] = [
        { id: "mem_1", type: "episodic", content: "Event", createdAt: new Date().toISOString() },
      ];
      const updated = updateWorkingMemory(wm, { retrieved: entries });
      expect(updated.retrieved).toHaveLength(1);
      expect(updated.retrieved[0].content).toBe("Event");
    });

    it("merges scratch values (does not replace)", () => {
      const wm = createWorkingMemory();
      const step1 = updateWorkingMemory(wm, { scratch: { key1: "value1" } });
      const step2 = updateWorkingMemory(step1, { scratch: { key2: "value2" } });
      expect(step2.scratch).toEqual({ key1: "value1", key2: "value2" });
    });

    it("preserves existing fields not included in updates", () => {
      const wm = createWorkingMemory();
      const step1 = updateWorkingMemory(wm, { activeGoal: "Goal A" });
      const step2 = updateWorkingMemory(step1, { lastThought: "Thinking..." });
      expect(step2.activeGoal).toBe("Goal A");
      expect(step2.lastThought).toBe("Thinking...");
    });

    it("does not mutate original working memory", () => {
      const wm = createWorkingMemory();
      const updated = updateWorkingMemory(wm, { activeGoal: "New goal" });
      expect(wm.activeGoal).toBeUndefined();
      expect(updated.activeGoal).toBe("New goal");
    });
  });

  describe("formatWorkingMemoryForContext", () => {
    it("returns empty string for empty working memory", () => {
      const wm = createWorkingMemory();
      expect(formatWorkingMemoryForContext(wm)).toBe("");
    });

    it("formats activeGoal section", () => {
      const wm = updateWorkingMemory(createWorkingMemory(), {
        activeGoal: "Deploy to production",
      });
      const result = formatWorkingMemoryForContext(wm);
      expect(result).toContain("## Active goal");
      expect(result).toContain("Deploy to production");
    });

    it("formats retrieved entries with type tags", () => {
      const entries: MemoryEntry[] = [
        { id: "1", type: "episodic", content: "Past event", createdAt: new Date().toISOString() },
        { id: "2", type: "semantic", content: "A fact", createdAt: new Date().toISOString() },
      ];
      const wm = updateWorkingMemory(createWorkingMemory(), { retrieved: entries });
      const result = formatWorkingMemoryForContext(wm);
      expect(result).toContain("## Retrieved from memory");
      expect(result).toContain("- [episodic] Past event");
      expect(result).toContain("- [semantic] A fact");
    });

    it("formats lastThought section", () => {
      const wm = updateWorkingMemory(createWorkingMemory(), {
        lastThought: "Consider using caching",
      });
      const result = formatWorkingMemoryForContext(wm);
      expect(result).toContain("## Latest thought");
      expect(result).toContain("Consider using caching");
    });

    it("combines all sections with double newlines", () => {
      const entries: MemoryEntry[] = [
        { id: "1", type: "procedural", content: "Step 1", createdAt: new Date().toISOString() },
      ];
      const wm = updateWorkingMemory(createWorkingMemory(), {
        activeGoal: "Build feature",
        retrieved: entries,
        lastThought: "Almost done",
      });
      const result = formatWorkingMemoryForContext(wm);
      expect(result).toContain("## Active goal");
      expect(result).toContain("## Retrieved from memory");
      expect(result).toContain("## Latest thought");
      // Sections separated by double newlines
      const sections = result.split("\n\n");
      expect(sections.length).toBeGreaterThanOrEqual(3);
    });
  });
});
