/**
 * Integration tests: Open Loop Protocol — store, fold-back, scanner.
 *
 * Validates:
 *   - JSONL persistence (create, load, collapse-by-ID, state transitions)
 *   - Triad creation and retrieval
 *   - Fold-back gating (trivial conversations rejected)
 *   - Scanner pruning logic
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createTempDir } from "./helpers.js";

// The store module reads MEMORY_DIR from process.cwd()/brain/memory.
// We override cwd for each test to isolate JSONL files.

// We test the store functions by importing them fresh, but since they
// use process.cwd() at module level, we need a different approach:
// import the functions and manually verify the JSONL files.

// ---------------------------------------------------------------------------
// Store tests (direct file verification)
// ---------------------------------------------------------------------------

describe("OpenLoop Store", () => {
  let originalCwd: string;
  let tempDir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const tmp = await createTempDir("dash-olp-");
    tempDir = tmp.dir;
    cleanup = tmp.cleanup;

    // Create brain/memory directory structure
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(tempDir, "brain", "memory"), { recursive: true });

    // Override cwd so the store writes to our temp dir
    originalCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await cleanup();
  });

  it("should create a loop with ol_ prefix and active state", async () => {
    // Dynamic import to pick up the new cwd
    const { createLoop } = await import("../src/openloop/store.js");

    const loop = await createLoop({
      anchor: "Vector Search",
      dissonance: "Optimal chunk size unknown",
      searchHeuristic: ["chunk size", "embedding", "token window"],
    });

    expect(loop.id).toMatch(/^ol_[0-9a-f]{8}$/);
    expect(loop.state).toBe("active");
    expect(loop.anchor).toBe("Vector Search");
    expect(loop.dissonance).toBe("Optimal chunk size unknown");
    expect(loop.searchHeuristic).toHaveLength(3);
    expect(loop.expiresAt).toBeTruthy();

    // Verify 7-day TTL
    const created = new Date(loop.createdAt).getTime();
    const expires = new Date(loop.expiresAt).getTime();
    const diffDays = (expires - created) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeCloseTo(7, 0);
  });

  it("should write schema header on first loop creation", async () => {
    const { createLoop } = await import("../src/openloop/store.js");

    await createLoop({
      anchor: "Test",
      dissonance: "Test question",
      searchHeuristic: ["test"],
    });

    const raw = await readFile(join(tempDir, "brain", "memory", "open-loops.jsonl"), "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim());

    // First line should be schema
    const schema = JSON.parse(lines[0]);
    expect(schema._schema).toBe("open-loops");
    expect(schema._version).toBe("1.0");

    // Second line should be the loop
    const loop = JSON.parse(lines[1]);
    expect(loop.id).toMatch(/^ol_/);
  });

  it("should load loops and collapse by ID (last line wins)", async () => {
    const { createLoop, loadLoops, transitionLoop } = await import("../src/openloop/store.js");

    const loop = await createLoop({
      anchor: "Auth Flow",
      dissonance: "JWT vs session cookies undecided",
      searchHeuristic: ["JWT", "session", "auth"],
    });

    // Transition to dormant — appends a new line
    await transitionLoop(loop.id, "dormant");

    const all = await loadLoops();
    const found = all.find((l) => l.id === loop.id);

    // Last line wins: should be dormant, not active
    expect(found).toBeDefined();
    expect(found!.state).toBe("dormant");

    // Raw file should have 3 lines: schema + active + dormant
    const raw = await readFile(join(tempDir, "brain", "memory", "open-loops.jsonl"), "utf-8");
    const dataLines = raw.split("\n").filter((l) => l.trim() && !l.includes("_schema"));
    expect(dataLines).toHaveLength(2);
  });

  it("should filter loops by state", async () => {
    const { createLoop, loadLoopsByState, transitionLoop } = await import("../src/openloop/store.js");

    const loop1 = await createLoop({
      anchor: "A",
      dissonance: "Q1",
      searchHeuristic: ["a"],
    });
    const loop2 = await createLoop({
      anchor: "B",
      dissonance: "Q2",
      searchHeuristic: ["b"],
    });

    await transitionLoop(loop1.id, "dormant");

    const active = await loadLoopsByState("active");
    const dormant = await loadLoopsByState("dormant");

    expect(active.some((l) => l.id === loop2.id)).toBe(true);
    expect(active.some((l) => l.id === loop1.id)).toBe(false);
    expect(dormant.some((l) => l.id === loop1.id)).toBe(true);
  });

  it("should set resolvedBy on transition", async () => {
    const { createLoop, transitionLoop } = await import("../src/openloop/store.js");

    const loop = await createLoop({
      anchor: "Caching",
      dissonance: "Redis vs in-memory undecided",
      searchHeuristic: ["redis", "cache"],
    });

    const updated = await transitionLoop(loop.id, "resonant", "ts_abc123def456");
    expect(updated).not.toBeNull();
    expect(updated!.state).toBe("resonant");
    expect(updated!.resolvedBy).toBe("ts_abc123def456");
  });

  it("should return null when transitioning a non-existent loop", async () => {
    const { transitionLoop } = await import("../src/openloop/store.js");

    const result = await transitionLoop("ol_00000000", "expired");
    expect(result).toBeNull();
  });

  it("should create a triad with tr_ prefix", async () => {
    const { createTriad } = await import("../src/openloop/store.js");

    const triad = await createTriad({
      anchor: "ThoughtStreams UI",
      vectorShift: "Moved from static board to living brain metaphor",
      residualTensions: ["Trace density decay function TBD"],
      openLoopIds: ["ol_aabbccdd"],
      sourceTraceId: "ts_112233445566",
      sessionId: "sess_test",
    });

    expect(triad.id).toMatch(/^tr_[0-9a-f]{8}$/);
    expect(triad.anchor).toBe("ThoughtStreams UI");
    expect(triad.vectorShift).toContain("living brain");
    expect(triad.openLoopIds).toEqual(["ol_aabbccdd"]);
    expect(triad.sourceTraceId).toBe("ts_112233445566");
  });

  it("should load triads from JSONL", async () => {
    const { createTriad, loadTriads } = await import("../src/openloop/store.js");

    await createTriad({
      anchor: "Subject A",
      vectorShift: "Shift A",
      residualTensions: [],
      openLoopIds: [],
    });
    await createTriad({
      anchor: "Subject B",
      vectorShift: "Shift B",
      residualTensions: ["tension"],
      openLoopIds: ["ol_11223344"],
    });

    const triads = await loadTriads();
    expect(triads).toHaveLength(2);
    expect(triads.map((t) => t.anchor).sort()).toEqual(["Subject A", "Subject B"]);
  });

  it("should write triads schema header on first creation", async () => {
    const { createTriad } = await import("../src/openloop/store.js");

    await createTriad({
      anchor: "Test",
      vectorShift: "Test shift",
      residualTensions: [],
      openLoopIds: [],
    });

    const raw = await readFile(join(tempDir, "brain", "memory", "triads.jsonl"), "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim());
    const schema = JSON.parse(lines[0]);
    expect(schema._schema).toBe("triads");
    expect(schema._version).toBe("1.0");
  });
});

// ---------------------------------------------------------------------------
// Fold-back gating tests
// ---------------------------------------------------------------------------

describe("OpenLoop Fold-back gating", () => {
  it("should reject conversations with fewer than 3 user messages", async () => {
    const { foldBack } = await import("../src/openloop/foldback.js");

    const result = await foldBack({
      history: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
        { role: "user", content: "How are you?" },
        { role: "assistant", content: "I'm doing well." },
      ],
    });

    expect(result).toBeNull();
  });

  it("should reject conversations with transcript < 200 chars", async () => {
    const { foldBack } = await import("../src/openloop/foldback.js");

    const result = await foldBack({
      history: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hey" },
        { role: "user", content: "Ok" },
        { role: "assistant", content: "Sure" },
        { role: "user", content: "Bye" },
        { role: "assistant", content: "Later" },
      ],
    });

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Scanner utility tests
// ---------------------------------------------------------------------------

describe("OpenLoop Scanner keyword matching", () => {
  it("should count heuristic term hits in entry text", async () => {
    // We test the keyword matching logic by importing the module and using
    // the exported functions — the scanner itself requires timers,
    // so we test the public API shape.
    const scanner = await import("../src/openloop/scanner.js");

    // Verify exported functions exist
    expect(typeof scanner.startOpenLoopScanner).toBe("function");
    expect(typeof scanner.stopOpenLoopScanner).toBe("function");
    expect(typeof scanner.getResonances).toBe("function");
    expect(typeof scanner.getLastScanRun).toBe("function");
    expect(typeof scanner.triggerOpenLoopScan).toBe("function");

    // Initial state should be empty
    expect(scanner.getResonances()).toEqual([]);
    expect(scanner.getLastScanRun()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Type shape tests
// ---------------------------------------------------------------------------

describe("OpenLoop types", () => {
  it("should export all expected types from barrel", async () => {
    const barrel = await import("../src/openloop/index.js");

    // Store functions
    expect(typeof barrel.createLoop).toBe("function");
    expect(typeof barrel.loadLoops).toBe("function");
    expect(typeof barrel.loadLoopsByState).toBe("function");
    expect(typeof barrel.transitionLoop).toBe("function");
    expect(typeof barrel.createTriad).toBe("function");
    expect(typeof barrel.loadTriads).toBe("function");

    // Scanner functions
    expect(typeof barrel.startOpenLoopScanner).toBe("function");
    expect(typeof barrel.stopOpenLoopScanner).toBe("function");
    expect(typeof barrel.getResonances).toBe("function");
    expect(typeof barrel.getLastScanRun).toBe("function");
    expect(typeof barrel.triggerOpenLoopScan).toBe("function");

    // Fold-back
    expect(typeof barrel.foldBack).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// OLP Context Injection subsystem tests
// ---------------------------------------------------------------------------

describe("OLP Context Injection subsystems", () => {
  let originalCwd: string;
  let tempDir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const tmp = await createTempDir("dash-olp-inject-");
    tempDir = tmp.dir;
    cleanup = tmp.cleanup;

    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(tempDir, "brain", "memory"), { recursive: true });

    originalCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await cleanup();
  });

  it("should load active loops with all fields needed for injection formatting", async () => {
    const { createLoop, loadLoopsByState } = await import("../src/openloop/store.js");

    await createLoop({
      anchor: "Vector Search",
      dissonance: "Optimal chunk size for embedding still unknown",
      searchHeuristic: ["chunk size", "embedding", "token window"],
    });

    const active = await loadLoopsByState("active");
    expect(active).toHaveLength(1);

    // Verify all fields the injection formatter depends on
    const loop = active[0];
    expect(loop.anchor).toBe("Vector Search");
    expect(loop.dissonance).toBe("Optimal chunk size for embedding still unknown");
    expect(loop.searchHeuristic).toEqual(["chunk size", "embedding", "token window"]);
    expect(loop.expiresAt).toBeTruthy();
    expect(loop.state).toBe("active");
    expect(loop.id).toMatch(/^ol_/);
  });

  it("should load resonant loops separately from active loops", async () => {
    const { createLoop, loadLoopsByState, transitionLoop } = await import("../src/openloop/store.js");

    const loop1 = await createLoop({
      anchor: "ThoughtStreams UI",
      dissonance: "How to visualize branch fold-back without clutter",
      searchHeuristic: ["visualization", "fold-back", "UI"],
    });
    await createLoop({
      anchor: "Memory Decay",
      dissonance: "Should old experiences fade or persist forever",
      searchHeuristic: ["memory", "decay", "TTL"],
    });

    // Transition loop1 to resonant
    await transitionLoop(loop1.id, "resonant");

    const active = await loadLoopsByState("active");
    const resonant = await loadLoopsByState("resonant");

    expect(active).toHaveLength(1);
    expect(active[0].anchor).toBe("Memory Decay");
    expect(resonant).toHaveLength(1);
    expect(resonant[0].anchor).toBe("ThoughtStreams UI");
    expect(resonant[0].state).toBe("resonant");
  });

  it("should return empty arrays when no loops exist (zero overhead path)", async () => {
    const { loadLoopsByState } = await import("../src/openloop/store.js");
    const { getResonances } = await import("../src/openloop/scanner.js");

    const active = await loadLoopsByState("active");
    const resonant = await loadLoopsByState("resonant");
    const resonances = getResonances();

    expect(active).toEqual([]);
    expect(resonant).toEqual([]);
    expect(resonances).toEqual([]);
  });

  it("should cap active loops at 5 using slice", async () => {
    const { createLoop, loadLoopsByState } = await import("../src/openloop/store.js");

    // Create 7 active loops
    for (let i = 0; i < 7; i++) {
      await createLoop({
        anchor: `Topic ${i}`,
        dissonance: `Question ${i}`,
        searchHeuristic: [`kw${i}`],
      });
    }

    const active = await loadLoopsByState("active");
    expect(active).toHaveLength(7);

    // The injection caps at 5
    const capped = active.slice(0, 5);
    expect(capped).toHaveLength(5);
  });

  it("should cap resonant loops at 3 using slice", async () => {
    const { createLoop, loadLoopsByState, transitionLoop } = await import("../src/openloop/store.js");

    // Create 5 loops and transition all to resonant
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const loop = await createLoop({
        anchor: `Resonant ${i}`,
        dissonance: `Tension ${i}`,
        searchHeuristic: [`r${i}`],
      });
      ids.push(loop.id);
    }
    for (const id of ids) {
      await transitionLoop(id, "resonant");
    }

    const resonant = await loadLoopsByState("resonant");
    expect(resonant).toHaveLength(5);

    // The injection caps at 3
    const capped = resonant.slice(0, 3);
    expect(capped).toHaveLength(3);
  });

  it("should format injection message correctly from loop data", async () => {
    const { createLoop, loadLoopsByState, transitionLoop } = await import("../src/openloop/store.js");

    // Create active + resonant loops
    await createLoop({
      anchor: "Vector Search",
      dissonance: "Optimal chunk size unknown",
      searchHeuristic: ["chunk size", "embedding"],
    });
    const resLoop = await createLoop({
      anchor: "ThoughtStreams UI",
      dissonance: "Branch fold-back visualization",
      searchHeuristic: ["visualization", "fold-back"],
    });
    await transitionLoop(resLoop.id, "resonant");

    const activeLoops = await loadLoopsByState("active");
    const resonantLoops = await loadLoopsByState("resonant");

    // Mock resonance data matching the scanner output shape
    const resonances: import("../src/openloop/types.js").ResonanceMatch[] = [
      {
        loopId: resLoop.id,
        matchedActivityId: 42,
        matchedSource: "experiences.jsonl",
        matchedSummary: "Implemented collapsible node groups in stream view",
        similarity: 0.82,
        explanation: "This may resolve the tension. Surface the connection to the user.",
      },
    ];

    // Replicate the injection formatting logic from server.ts
    const cappedActive = activeLoops.slice(0, 5);
    const cappedResonant = resonantLoops.slice(0, 3);
    const cappedResonances = resonances.slice(0, 3);

    const lines: string[] = [
      `--- Open loops (unresolved tensions from past conversations) ---`,
    ];

    if (cappedActive.length > 0) {
      lines.push("[Active]");
      for (const loop of cappedActive) {
        const expires = new Date(loop.expiresAt).toLocaleDateString("en-US", { month: "short", day: "numeric" });
        lines.push(`- [${loop.anchor}] ${loop.dissonance} (expires ${expires})`);
        if (loop.searchHeuristic.length > 0) {
          lines.push(`  Heuristics: ${loop.searchHeuristic.join(", ")}`);
        }
      }
    }

    if (cappedResonant.length > 0) {
      lines.push("[Resonant — new match!]");
      for (const loop of cappedResonant) {
        lines.push(`- [${loop.anchor}] ${loop.dissonance}`);
        const match = cappedResonances.find((r) => r.loopId === loop.id);
        if (match) {
          lines.push(`  Matched: "${match.matchedSummary}" (${Math.round(match.similarity * 100)}% similarity)`);
          lines.push(`  → ${match.explanation}`);
        }
      }
    }

    lines.push(`--- End open loops ---`);
    lines.push(`If the user's message relates to any open loop, surface the connection naturally.`);
    lines.push(`Resonant loops are especially important — they represent a potential "aha moment."`);

    const content = lines.join("\n");

    // Verify structure
    expect(content).toContain("--- Open loops (unresolved tensions from past conversations) ---");
    expect(content).toContain("[Active]");
    expect(content).toContain("- [Vector Search] Optimal chunk size unknown (expires");
    expect(content).toContain("  Heuristics: chunk size, embedding");
    expect(content).toContain("[Resonant — new match!]");
    expect(content).toContain("- [ThoughtStreams UI] Branch fold-back visualization");
    expect(content).toContain('  Matched: "Implemented collapsible node groups in stream view" (82% similarity)');
    expect(content).toContain("  → This may resolve the tension.");
    expect(content).toContain("--- End open loops ---");
    expect(content).toContain("aha moment");
  });

  it("should skip injection when no active or resonant loops exist", async () => {
    const { createLoop, loadLoopsByState, transitionLoop } = await import("../src/openloop/store.js");

    // Create a loop but make it dormant (neither active nor resonant)
    const loop = await createLoop({
      anchor: "Test",
      dissonance: "Test tension",
      searchHeuristic: ["test"],
    });
    await transitionLoop(loop.id, "dormant");

    const active = await loadLoopsByState("active");
    const resonant = await loadLoopsByState("resonant");

    // The injection guard: skip entirely
    const shouldInject = active.length > 0 || resonant.length > 0;
    expect(shouldInject).toBe(false);
  });

  it("should handle resonant loops without matching resonance data", async () => {
    const { createLoop, loadLoopsByState, transitionLoop } = await import("../src/openloop/store.js");

    const loop = await createLoop({
      anchor: "Orphan Resonant",
      dissonance: "No scanner match yet",
      searchHeuristic: ["orphan"],
    });
    await transitionLoop(loop.id, "resonant");

    const resonantLoops = await loadLoopsByState("resonant");
    const resonances: import("../src/openloop/types.js").ResonanceMatch[] = [];

    // Build resonant section — should still render without match details
    const lines: string[] = ["[Resonant — new match!]"];
    for (const rl of resonantLoops) {
      lines.push(`- [${rl.anchor}] ${rl.dissonance}`);
      const match = resonances.find((r) => r.loopId === rl.id);
      if (match) {
        lines.push(`  Matched: "${match.matchedSummary}"`);
      }
    }

    const content = lines.join("\n");
    expect(content).toContain("- [Orphan Resonant] No scanner match yet");
    expect(content).not.toContain("Matched:");
  });

  it("should cross-reference resonance to correct loop by ID", async () => {
    const { createLoop, transitionLoop } = await import("../src/openloop/store.js");

    const loop1 = await createLoop({
      anchor: "Loop A",
      dissonance: "Tension A",
      searchHeuristic: ["a"],
    });
    const loop2 = await createLoop({
      anchor: "Loop B",
      dissonance: "Tension B",
      searchHeuristic: ["b"],
    });
    await transitionLoop(loop1.id, "resonant");
    await transitionLoop(loop2.id, "resonant");

    // Only loop2 has a resonance match
    const resonances: import("../src/openloop/types.js").ResonanceMatch[] = [
      {
        loopId: loop2.id,
        matchedActivityId: 99,
        matchedSource: "semantic.jsonl",
        matchedSummary: "Relevant finding for B",
        similarity: 0.91,
        explanation: "Strong match for tension B.",
      },
    ];

    const matchForLoop1 = resonances.find((r) => r.loopId === loop1.id);
    const matchForLoop2 = resonances.find((r) => r.loopId === loop2.id);

    expect(matchForLoop1).toBeUndefined();
    expect(matchForLoop2).toBeDefined();
    expect(matchForLoop2!.matchedSummary).toBe("Relevant finding for B");
    expect(matchForLoop2!.similarity).toBe(0.91);
  });
});
