/**
 * Unit tests for context assembler (src/context/assembler.ts).
 * Covers section assembly, message conversion, and token estimation.
 */

import { describe, it, expect } from "vitest";
import { assembleSections, sectionsToMessages, estimateTokens } from "../src/context/assembler.js";
import type { WorkingMemory, ContextMessage, MemoryEntry } from "../src/types.js";

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: "mem_test",
    type: "episodic",
    content: "Test memory content",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function emptyWorkingMemory(): WorkingMemory {
  return { retrieved: [], scratch: {} };
}

describe("assembleSections", () => {
  it("produces sections from minimal input", () => {
    const wm = emptyWorkingMemory();
    const sections = assembleSections(
      wm,
      { userInput: "Hello" },
      { systemPrompt: "You are Dash." }
    );

    expect(sections.primaryContent).toBe("Hello");
    expect(sections.instructions).toContain("You are Dash.");
    expect(sections.examples).toBe("");
    expect(sections.supportingContent).toBe("");
  });

  it("includes working memory with active goal in supporting content", () => {
    const wm: WorkingMemory = {
      activeGoal: "Write a blog post",
      retrieved: [],
      scratch: {},
    };
    const sections = assembleSections(
      wm,
      { userInput: "Start writing" },
      { systemPrompt: "You are Dash." }
    );

    expect(sections.supportingContent).toContain("Active goal");
    expect(sections.supportingContent).toContain("Write a blog post");
  });

  it("includes retrieved memories in supporting content", () => {
    const wm: WorkingMemory = {
      retrieved: [
        makeEntry({ content: "Previous discussion about testing" }),
        makeEntry({ type: "semantic", content: "Vitest is a test runner" }),
      ],
      scratch: {},
    };
    const sections = assembleSections(
      wm,
      { userInput: "Tell me about testing" },
      { systemPrompt: "You are Dash." }
    );

    expect(sections.supportingContent).toContain("Previous discussion about testing");
    expect(sections.supportingContent).toContain("Vitest is a test runner");
  });

  it("combines defaultInstructions with systemPrompt", () => {
    const sections = assembleSections(
      emptyWorkingMemory(),
      { userInput: "Go" },
      {
        systemPrompt: "You are Dash.",
        defaultInstructions: "Be concise.",
      }
    );

    expect(sections.instructions).toContain("Be concise.");
    expect(sections.instructions).toContain("You are Dash.");
  });

  it("includes defaultCues", () => {
    const sections = assembleSections(
      emptyWorkingMemory(),
      { userInput: "Go" },
      {
        systemPrompt: "You are Dash.",
        defaultCues: "Respond in JSON.",
      }
    );

    expect(sections.cues).toBe("Respond in JSON.");
  });
});

describe("sectionsToMessages", () => {
  it("produces system + user messages from minimal sections", () => {
    const messages = sectionsToMessages({
      supportingContent: "",
      instructions: "You are Dash.",
      examples: "",
      cues: "",
      primaryContent: "Hello",
    });

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("You are Dash.");
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toBe("Hello");
  });

  it("includes supporting content in system message", () => {
    const messages = sectionsToMessages({
      supportingContent: "Some context here",
      instructions: "Be helpful.",
      examples: "",
      cues: "",
      primaryContent: "Question?",
    });

    const system = messages[0].content as string;
    expect(system).toContain("Context / memory");
    expect(system).toContain("Some context here");
  });

  it("includes examples section", () => {
    const messages = sectionsToMessages({
      supportingContent: "",
      instructions: "You are Dash.",
      examples: "Q: What is 2+2? A: 4",
      cues: "",
      primaryContent: "What is 3+3?",
    });

    const system = messages[0].content as string;
    expect(system).toContain("Examples");
    expect(system).toContain("Q: What is 2+2? A: 4");
  });

  it("includes output format cues", () => {
    const messages = sectionsToMessages({
      supportingContent: "",
      instructions: "You are Dash.",
      examples: "",
      cues: "Respond in JSON.",
      primaryContent: "Data?",
    });

    const system = messages[0].content as string;
    expect(system).toContain("Output format");
    expect(system).toContain("Respond in JSON.");
  });

  it("inserts conversation history between system and user", () => {
    const history: ContextMessage[] = [
      { role: "user", content: "Previous question" },
      { role: "assistant", content: "Previous answer" },
    ];

    const messages = sectionsToMessages(
      {
        supportingContent: "",
        instructions: "You are Dash.",
        examples: "",
        cues: "",
        primaryContent: "Follow-up",
      },
      history
    );

    expect(messages).toHaveLength(4); // system + 2 history + user
    expect(messages[0].role).toBe("system");
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toBe("Previous question");
    expect(messages[2].role).toBe("assistant");
    expect(messages[3].role).toBe("user");
    expect(messages[3].content).toBe("Follow-up");
  });

  it("omits system message when no sections have content", () => {
    const messages = sectionsToMessages({
      supportingContent: "",
      instructions: "",
      examples: "",
      cues: "",
      primaryContent: "Just the user message",
    });

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
  });
});

describe("estimateTokens", () => {
  it("estimates ~1 token per 4 chars", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("12345678")).toBe(2);
  });

  it("rounds up partial tokens", () => {
    expect(estimateTokens("abc")).toBe(1); // 3/4 = 0.75 → ceil = 1
    expect(estimateTokens("abcde")).toBe(2); // 5/4 = 1.25 → ceil = 2
  });

  it("handles empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("handles undefined-like input", () => {
    // The function guards with (text || "")
    expect(estimateTokens(undefined as unknown as string)).toBe(0);
  });
});
