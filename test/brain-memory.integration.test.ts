/**
 * Integration tests: Brain + Memory + Context Assembly pipeline.
 *
 * Validates the complete workflow:
 *   learn → store in LTM → retrieve → assemble context → produce LLM-ready messages
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Brain } from "../src/brain.js";
import { InMemoryLongTermMemory } from "../src/memory/long-term.js";
import { FileSystemLongTermMemory } from "../src/memory/file-backed.js";
import { createWorkingMemory, updateWorkingMemory, formatWorkingMemoryForContext } from "../src/memory/working.js";
import { assembleSections, sectionsToMessages, estimateTokens } from "../src/context/assembler.js";
import { createTempDir, writeJsonlFile } from "./helpers.js";
import { join } from "node:path";
import { readFile, mkdir } from "node:fs/promises";

// ---------------------------------------------------------------------------
// Brain + InMemoryLTM integration
// ---------------------------------------------------------------------------

describe("Brain + InMemoryLTM full pipeline", () => {
  let brain: Brain;
  let ltm: InMemoryLongTermMemory;

  beforeEach(() => {
    ltm = new InMemoryLongTermMemory();
    brain = new Brain(
      {
        systemPrompt: "You are Dash, a personal AI agent.",
        defaultInstructions: "Be helpful and concise.",
        defaultCues: "Respond in plain text.",
        maxRetrieved: 5,
      },
      ltm,
    );
  });

  it("should learn, retrieve, and assemble context in one pipeline", async () => {
    // 1. Learn facts
    const entry1 = await brain.learn({ type: "semantic", content: "User prefers TypeScript over Python" });
    const entry2 = await brain.learn({ type: "episodic", content: "Had a great meeting about Dash architecture" });
    const entry3 = await brain.learn({ type: "procedural", content: "Always run npm build before deploying" });

    expect(entry1.id).toBeTruthy();
    expect(entry2.type).toBe("episodic");
    expect(entry3.type).toBe("procedural");

    // 2. Retrieve matching entries
    const results = await brain.retrieve("TypeScript");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.content.includes("TypeScript"))).toBe(true);

    // 3. Working memory should now contain retrieved items
    const wm = brain.getWorkingMemory();
    expect(wm.retrieved.length).toBeGreaterThanOrEqual(1);

    // 4. Assemble context for a turn
    const ctx = await brain.getContextForTurn({
      userInput: "What language should I use?",
      maxRetrieved: 5,
    });

    expect(ctx.messages.length).toBeGreaterThanOrEqual(2); // system + user
    expect(ctx.messages[0].role).toBe("system");
    expect(ctx.messages.at(-1)!.role).toBe("user");
    expect(ctx.messages.at(-1)!.content).toBe("What language should I use?");
    expect(ctx.sections.primaryContent).toBe("What language should I use?");
    expect(ctx.sections.instructions).toContain("Dash");
  });

  it("should include conversation history in assembled messages", async () => {
    await brain.learn({ type: "semantic", content: "Prefers dark mode" });

    const history = [
      { role: "user" as const, content: "Hello Dash" },
      { role: "assistant" as const, content: "Hello! How can I help?" },
    ];

    const ctx = await brain.getContextForTurn({
      userInput: "What were we talking about?",
      conversationHistory: history,
    });

    // system + history(2) + user = 4+
    expect(ctx.messages.length).toBeGreaterThanOrEqual(4);
    expect(ctx.messages[1].content).toBe("Hello Dash");
    expect(ctx.messages[2].content).toBe("Hello! How can I help?");
  });

  it("should clear working memory between tasks", async () => {
    await brain.learn({ type: "semantic", content: "Important fact" });
    await brain.retrieve("Important");

    expect(brain.getWorkingMemory().retrieved.length).toBeGreaterThan(0);

    brain.clearWorkingMemory();
    expect(brain.getWorkingMemory().retrieved).toEqual([]);
    expect(brain.getWorkingMemory().lastThought).toBeUndefined();
  });

  it("should respect maxRetrieved limit", async () => {
    // Add 10 entries all containing "test"
    for (let i = 0; i < 10; i++) {
      await brain.learn({ type: "semantic", content: `Test fact number ${i}` });
    }

    const results = await brain.retrieve("test", { max: 3 });
    expect(results.length).toBe(3);
  });

  it("should track lastThought in working memory", () => {
    brain.setLastThought("I should look up TypeScript docs");
    const wm = brain.getWorkingMemory();
    expect(wm.lastThought).toBe("I should look up TypeScript docs");
  });

  it("should expose LTM for direct access", async () => {
    await brain.learn({ type: "semantic", content: "Direct access test" });
    const all = await brain.getLongTermMemory().list();
    expect(all.length).toBe(1);
    expect(all[0].content).toBe("Direct access test");
  });
});

// ---------------------------------------------------------------------------
// FileSystemLongTermMemory integration
// ---------------------------------------------------------------------------

describe("FileSystemLongTermMemory", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let ltm: FileSystemLongTermMemory;

  beforeEach(async () => {
    const tmp = await createTempDir("dash-ltm-");
    dir = tmp.dir;
    cleanup = tmp.cleanup;
    await mkdir(dir, { recursive: true });
    ltm = new FileSystemLongTermMemory(dir);
  });

  afterEach(async () => {
    await cleanup();
  });

  it("should persist entries to JSONL files on disk", async () => {
    const entry = await ltm.add({ type: "semantic", content: "Persistent fact" });
    expect(entry.id).toBeTruthy();
    expect(entry.createdAt).toBeTruthy();

    // Read the file directly
    const raw = await readFile(join(dir, "semantic.jsonl"), "utf-8");
    expect(raw).toContain("Persistent fact");
  });

  it("should map memory types to correct files", async () => {
    await ltm.add({ type: "episodic", content: "An experience" });
    await ltm.add({ type: "semantic", content: "A fact" });
    await ltm.add({ type: "procedural", content: "A procedure" });

    const episodicRaw = await readFile(join(dir, "experiences.jsonl"), "utf-8");
    const semanticRaw = await readFile(join(dir, "semantic.jsonl"), "utf-8");
    const proceduralRaw = await readFile(join(dir, "procedural.jsonl"), "utf-8");

    expect(episodicRaw).toContain("An experience");
    expect(semanticRaw).toContain("A fact");
    expect(proceduralRaw).toContain("A procedure");
  });

  it("should search by content substring", async () => {
    await ltm.add({ type: "semantic", content: "TypeScript is great for type safety" });
    await ltm.add({ type: "semantic", content: "Python is great for data science" });
    await ltm.add({ type: "semantic", content: "Rust is great for performance" });

    const results = await ltm.search({ contentSubstring: "TypeScript" });
    expect(results.length).toBe(1);
    expect(results[0].content).toContain("TypeScript");
  });

  it("should search by type filter", async () => {
    await ltm.add({ type: "episodic", content: "Event happened" });
    await ltm.add({ type: "semantic", content: "Fact learned" });

    const episodic = await ltm.search({ type: "episodic" });
    expect(episodic.length).toBe(1);
    expect(episodic[0].type).toBe("episodic");
  });

  it("should search by metadata filter", async () => {
    await ltm.add({ type: "semantic", content: "Topic A", meta: { topic: "coding" } });
    await ltm.add({ type: "semantic", content: "Topic B", meta: { topic: "cooking" } });

    const results = await ltm.search({ meta: { topic: "coding" } });
    expect(results.length).toBe(1);
    expect(results[0].content).toBe("Topic A");
  });

  it("should list entries sorted by creation date (newest first)", async () => {
    await ltm.add({ type: "semantic", content: "First" });
    // Small delays to ensure distinct timestamps
    await new Promise((r) => setTimeout(r, 5));
    await ltm.add({ type: "semantic", content: "Second" });
    await new Promise((r) => setTimeout(r, 5));
    await ltm.add({ type: "semantic", content: "Third" });

    const all = await ltm.list("semantic");
    expect(all.length).toBe(3);
    expect(all[0].content).toBe("Third");
    expect(all[2].content).toBe("First");
  });

  it("should handle get by id", async () => {
    const entry = await ltm.add({ type: "semantic", content: "Findable" });
    const found = await ltm.get(entry.id);
    expect(found).not.toBeNull();
    expect(found!.content).toBe("Findable");

    const notFound = await ltm.get("nonexistent_id");
    expect(notFound).toBeNull();
  });

  it("should load pre-existing JSONL data", async () => {
    // Write a JSONL file directly
    await writeJsonlFile(join(dir, "semantic.jsonl"), "semantic", [
      { id: "pre_1", type: "semantic", content: "Pre-existing fact", createdAt: "2025-01-01T00:00:00Z" },
    ]);

    // Create a fresh LTM instance that reads from disk
    const freshLtm = new FileSystemLongTermMemory(dir);
    const results = await freshLtm.list("semantic");
    expect(results.length).toBe(1);
    expect(results[0].content).toBe("Pre-existing fact");
  });
});

// ---------------------------------------------------------------------------
// Brain + FileSystemLTM end-to-end
// ---------------------------------------------------------------------------

describe("Brain + FileSystemLTM end-to-end", () => {
  let dir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const tmp = await createTempDir("dash-brain-fs-");
    dir = tmp.dir;
    cleanup = tmp.cleanup;
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    await cleanup();
  });

  it("should persist knowledge across Brain instances", async () => {
    // Brain 1: learn
    const brain1 = new Brain(
      { systemPrompt: "Test agent" },
      new FileSystemLongTermMemory(dir),
    );
    await brain1.learn({ type: "semantic", content: "The sky is blue" });
    await brain1.learn({ type: "episodic", content: "Walked in the park today" });

    // Brain 2: retrieve (fresh instance, same directory)
    const brain2 = new Brain(
      { systemPrompt: "Test agent" },
      new FileSystemLongTermMemory(dir),
    );
    const ctx = await brain2.getContextForTurn({ userInput: "Tell me about the sky" });

    expect(ctx.workingMemory.retrieved.length).toBeGreaterThanOrEqual(1);
    expect(ctx.workingMemory.retrieved.some((r) => r.content.includes("sky"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Working Memory unit integration
// ---------------------------------------------------------------------------

describe("Working Memory lifecycle", () => {
  it("should create → update → format → clear", () => {
    let wm = createWorkingMemory();
    expect(wm.retrieved).toEqual([]);
    expect(wm.scratch).toEqual({});

    wm = updateWorkingMemory(wm, {
      perceptualInput: "Hello",
      activeGoal: "Greet the user",
      scratch: { attempt: 1 },
    });

    expect(wm.perceptualInput).toBe("Hello");
    expect(wm.activeGoal).toBe("Greet the user");
    expect(wm.scratch.attempt).toBe(1);

    // Format for context
    const formatted = formatWorkingMemoryForContext(wm);
    expect(formatted).toContain("Active goal");
    expect(formatted).toContain("Greet the user");

    // Merge scratch (not overwrite)
    wm = updateWorkingMemory(wm, { scratch: { extra: "data" } });
    expect(wm.scratch.attempt).toBe(1);
    expect(wm.scratch.extra).toBe("data");
  });

  it("should format retrieved items for context", () => {
    const wm = updateWorkingMemory(createWorkingMemory(), {
      retrieved: [
        { id: "1", type: "semantic", content: "Fact A", createdAt: "2025-01-01T00:00:00Z" },
        { id: "2", type: "episodic", content: "Event B", createdAt: "2025-01-01T00:00:00Z" },
      ],
    });

    const text = formatWorkingMemoryForContext(wm);
    expect(text).toContain("[semantic] Fact A");
    expect(text).toContain("[episodic] Event B");
  });
});

// ---------------------------------------------------------------------------
// Context assembler integration
// ---------------------------------------------------------------------------

describe("Context assembler", () => {
  it("should produce valid LLM message array", () => {
    const wm = updateWorkingMemory(createWorkingMemory(), {
      retrieved: [
        { id: "1", type: "semantic", content: "User likes cats", createdAt: "2025-01-01T00:00:00Z" },
      ],
      activeGoal: "Answer question about pets",
    });

    const sections = assembleSections(wm, { userInput: "Do I like cats?" }, {
      systemPrompt: "You are a helpful assistant.",
      defaultInstructions: "Be concise.",
      defaultCues: "Respond in JSON.",
    });

    expect(sections.primaryContent).toBe("Do I like cats?");
    expect(sections.instructions).toContain("Be concise");
    expect(sections.supportingContent).toContain("User likes cats");
    expect(sections.cues).toBe("Respond in JSON.");

    const messages = sectionsToMessages(sections, [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello!" },
    ]);

    expect(messages[0].role).toBe("system");
    expect((messages[0].content as string)).toContain("helpful assistant");
    expect((messages[0].content as string)).toContain("User likes cats");
    expect(messages[1]).toEqual({ role: "user", content: "Hi" });
    expect(messages[2]).toEqual({ role: "assistant", content: "Hello!" });
    expect(messages.at(-1)!.content).toBe("Do I like cats?");
  });

  it("should estimate tokens roughly", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("word")).toBe(1); // 4 chars / 4
    expect(estimateTokens("a".repeat(100))).toBe(25);
  });
});
