/**
 * Unit tests for working memory (src/memory/working.ts).
 * Covers creation, updates, scratch merging, and context formatting.
 */

import { describe, it, expect } from "vitest";
import {
  createWorkingMemory,
  updateWorkingMemory,
  formatWorkingMemoryForContext,
} from "../src/memory/working.js";
import type { MemoryEntry } from "../src/types.js";

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: "mem_test",
    type: "episodic",
    content: "Test content",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("createWorkingMemory", () => {
  it("returns empty working memory", () => {
    const wm = createWorkingMemory();

    expect(wm.retrieved).toEqual([]);
    expect(wm.scratch).toEqual({});
    expect(wm.perceptualInput).toBeUndefined();
    expect(wm.activeGoal).toBeUndefined();
    expect(wm.lastThought).toBeUndefined();
  });
});

describe("updateWorkingMemory", () => {
  it("sets perceptualInput", () => {
    const wm = createWorkingMemory();
    const updated = updateWorkingMemory(wm, { perceptualInput: "Hello" });

    expect(updated.perceptualInput).toBe("Hello");
    // Original unchanged
    expect(wm.perceptualInput).toBeUndefined();
  });

  it("sets activeGoal", () => {
    const wm = createWorkingMemory();
    const updated = updateWorkingMemory(wm, { activeGoal: "Write tests" });

    expect(updated.activeGoal).toBe("Write tests");
  });

  it("replaces retrieved entries", () => {
    const wm = createWorkingMemory();
    const entries = [makeEntry({ id: "a" }), makeEntry({ id: "b" })];
    const updated = updateWorkingMemory(wm, { retrieved: entries });

    expect(updated.retrieved).toHaveLength(2);
    expect(updated.retrieved[0].id).toBe("a");
  });

  it("sets lastThought", () => {
    const wm = createWorkingMemory();
    const updated = updateWorkingMemory(wm, { lastThought: "I should search memory" });

    expect(updated.lastThought).toBe("I should search memory");
  });

  it("deep merges scratch (does not overwrite existing keys)", () => {
    const wm = updateWorkingMemory(createWorkingMemory(), {
      scratch: { count: 1, tag: "initial" },
    });
    const updated = updateWorkingMemory(wm, {
      scratch: { count: 2, extra: true },
    });

    expect(updated.scratch).toEqual({ count: 2, tag: "initial", extra: true });
  });

  it("preserves scratch when not provided in updates", () => {
    const wm = updateWorkingMemory(createWorkingMemory(), {
      scratch: { key: "value" },
    });
    const updated = updateWorkingMemory(wm, { activeGoal: "New goal" });

    expect(updated.scratch).toEqual({ key: "value" });
  });
});

describe("formatWorkingMemoryForContext", () => {
  it("returns empty string for empty working memory", () => {
    const wm = createWorkingMemory();
    expect(formatWorkingMemoryForContext(wm)).toBe("");
  });

  it("includes active goal section", () => {
    const wm = updateWorkingMemory(createWorkingMemory(), {
      activeGoal: "Deploy to production",
    });
    const formatted = formatWorkingMemoryForContext(wm);

    expect(formatted).toContain("## Active goal");
    expect(formatted).toContain("Deploy to production");
  });

  it("includes retrieved memories section", () => {
    const wm = updateWorkingMemory(createWorkingMemory(), {
      retrieved: [
        makeEntry({ type: "episodic", content: "Met with team yesterday" }),
        makeEntry({ type: "semantic", content: "Vitest supports ESM" }),
      ],
    });
    const formatted = formatWorkingMemoryForContext(wm);

    expect(formatted).toContain("## Retrieved from memory");
    expect(formatted).toContain("[episodic] Met with team yesterday");
    expect(formatted).toContain("[semantic] Vitest supports ESM");
  });

  it("includes latest thought section", () => {
    const wm = updateWorkingMemory(createWorkingMemory(), {
      lastThought: "User wants a progress update",
    });
    const formatted = formatWorkingMemoryForContext(wm);

    expect(formatted).toContain("## Latest thought");
    expect(formatted).toContain("User wants a progress update");
  });

  it("combines all sections when present", () => {
    const wm = updateWorkingMemory(createWorkingMemory(), {
      activeGoal: "Ship feature",
      retrieved: [makeEntry({ content: "Previous work on feature" })],
      lastThought: "Almost done",
    });
    const formatted = formatWorkingMemoryForContext(wm);

    expect(formatted).toContain("## Active goal");
    expect(formatted).toContain("## Retrieved from memory");
    expect(formatted).toContain("## Latest thought");
  });
});
