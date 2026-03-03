/**
 * Unit tests for context assembler (src/context/assembler.ts).
 *
 * Complements test/context-assembler.test.ts with edge cases,
 * integration-style multi-step assembly, and token estimation.
 */

import { describe, it, expect } from "vitest";
import {
  assembleSections,
  sectionsToMessages,
  estimateTokens,
} from "../../src/context/assembler.js";
import type { WorkingMemory, ContextMessage, MemoryEntry } from "../../src/types.js";

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: "mem_test",
    type: "episodic",
    content: "Test memory content",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function emptyWM(): WorkingMemory {
  return { retrieved: [], scratch: {} };
}

// ---------------------------------------------------------------------------
// assembleSections — edge cases
// ---------------------------------------------------------------------------

describe("assembleSections — edge cases", () => {
  it("handles working memory with all fields populated", () => {
    const wm: WorkingMemory = {
      perceptualInput: "User said hello",
      activeGoal: "Greet the user",
      retrieved: [
        makeEntry({ type: "episodic", content: "Previous greeting was warm" }),
        makeEntry({ type: "procedural", content: "Always be friendly" }),
      ],
      lastThought: "I should say hi back",
      scratch: { turnCount: 3 },
    };

    const sections = assembleSections(
      wm,
      { userInput: "Hey there!" },
      { systemPrompt: "You are Dash." },
    );

    expect(sections.primaryContent).toBe("Hey there!");
    expect(sections.supportingContent).toContain("Active goal");
    expect(sections.supportingContent).toContain("Greet the user");
    expect(sections.supportingContent).toContain("Retrieved from memory");
    expect(sections.supportingContent).toContain("Latest thought");
  });

  it("strips trailing whitespace from supporting content", () => {
    const wm: WorkingMemory = {
      activeGoal: "  padded goal  ",
      retrieved: [],
      scratch: {},
    };
    const sections = assembleSections(
      wm,
      { userInput: "go" },
      { systemPrompt: "Prompt" },
    );
    // supportingContent should be trimmed
    expect(sections.supportingContent).not.toMatch(/^\s/);
    expect(sections.supportingContent).not.toMatch(/\s$/);
  });

  it("uses empty cues when defaultCues not provided", () => {
    const sections = assembleSections(
      emptyWM(),
      { userInput: "go" },
      { systemPrompt: "Prompt" },
    );
    expect(sections.cues).toBe("");
  });

  it("preserves userInput verbatim as primaryContent", () => {
    const input = "Multi\nline\n\tinput with special chars: <>&\"'";
    const sections = assembleSections(
      emptyWM(),
      { userInput: input },
      { systemPrompt: "Prompt" },
    );
    expect(sections.primaryContent).toBe(input);
  });
});

// ---------------------------------------------------------------------------
// sectionsToMessages — edge cases
// ---------------------------------------------------------------------------

describe("sectionsToMessages — edge cases", () => {
  it("produces only a user message when all sections empty", () => {
    const msgs = sectionsToMessages({
      supportingContent: "",
      instructions: "",
      examples: "",
      cues: "",
      primaryContent: "Just this",
    });

    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({ role: "user", content: "Just this" });
  });

  it("correctly orders: system → history → user", () => {
    const history: ContextMessage[] = [
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2" },
      { role: "assistant", content: "a2" },
    ];

    const msgs = sectionsToMessages(
      {
        supportingContent: "",
        instructions: "System prompt",
        examples: "",
        cues: "",
        primaryContent: "q3",
      },
      history,
    );

    expect(msgs).toHaveLength(6); // 1 system + 4 history + 1 user
    expect(msgs[0].role).toBe("system");
    expect(msgs[1].content).toBe("q1");
    expect(msgs[4].content).toBe("a2");
    expect(msgs[5]).toEqual({ role: "user", content: "q3" });
  });

  it("builds system message with all non-empty sections", () => {
    const msgs = sectionsToMessages({
      supportingContent: "Background info",
      instructions: "Be helpful",
      examples: "Example 1",
      cues: "JSON output",
      primaryContent: "Go",
    });

    const sys = msgs[0].content as string;
    expect(sys).toContain("Be helpful");
    expect(sys).toContain("Context / memory");
    expect(sys).toContain("Background info");
    expect(sys).toContain("Examples");
    expect(sys).toContain("Example 1");
    expect(sys).toContain("Output format");
    expect(sys).toContain("JSON output");
  });

  it("handles empty history array same as omitted", () => {
    const withEmpty = sectionsToMessages(
      { supportingContent: "", instructions: "X", examples: "", cues: "", primaryContent: "Y" },
      [],
    );
    const withoutHistory = sectionsToMessages(
      { supportingContent: "", instructions: "X", examples: "", cues: "", primaryContent: "Y" },
    );
    expect(withEmpty).toEqual(withoutHistory);
  });
});

// ---------------------------------------------------------------------------
// estimateTokens
// ---------------------------------------------------------------------------

describe("estimateTokens", () => {
  it("estimates longer text proportionally", () => {
    const text = "a".repeat(400);
    expect(estimateTokens(text)).toBe(100);
  });

  it("handles single character", () => {
    expect(estimateTokens("x")).toBe(1);
  });

  it("handles unicode text", () => {
    // Unicode chars are still counted by .length (char codes)
    const emoji = "Hello 🌍";
    expect(estimateTokens(emoji)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Integration: assembleSections → sectionsToMessages round-trip
// ---------------------------------------------------------------------------

describe("assembly round-trip", () => {
  it("produces valid LLM message array from working memory", () => {
    const wm: WorkingMemory = {
      activeGoal: "Answer user question",
      retrieved: [
        makeEntry({ type: "semantic", content: "ESM is the standard module system" }),
      ],
      scratch: {},
    };

    const sections = assembleSections(
      wm,
      { userInput: "How do modules work?" },
      {
        systemPrompt: "You are a helpful assistant.",
        defaultInstructions: "Be concise.",
        defaultCues: "Respond in markdown.",
      },
    );

    const messages = sectionsToMessages(sections);

    // Should have system + user
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[1].role).toBe("user");

    const sys = messages[0].content as string;
    expect(sys).toContain("Be concise.");
    expect(sys).toContain("You are a helpful assistant.");
    expect(sys).toContain("ESM is the standard module system");
    expect(sys).toContain("Respond in markdown.");
    expect(messages[1].content).toBe("How do modules work?");
  });

  it("round-trips with conversation history", () => {
    const history: ContextMessage[] = [
      { role: "user", content: "What is Dash?" },
      { role: "assistant", content: "Dash is a personal AI operating system." },
    ];

    const sections = assembleSections(
      emptyWM(),
      { userInput: "Tell me more" },
      { systemPrompt: "You are Dash." },
    );

    const messages = sectionsToMessages(sections, history);

    expect(messages).toHaveLength(4);
    expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(messages[3].content).toBe("Tell me more");
  });
});
