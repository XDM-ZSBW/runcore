import { describe, it, expect } from "vitest";
import {
  assembleSections,
  sectionsToMessages,
  estimateTokens,
} from "../../../src/context/assembler.js";
import type { ContextAssemblerConfig } from "../../../src/context/assembler.js";
import { createWorkingMemory, updateWorkingMemory } from "../../../src/memory/working.js";
import type { ContextMessage, MemoryEntry } from "../../../src/types.js";

// ═══════════════════════════════════════════════════════════════════════
// estimateTokens
// ═══════════════════════════════════════════════════════════════════════

describe("estimateTokens", () => {
  it("estimates tokens as chars / 4 (rounded up)", () => {
    expect(estimateTokens("abcd")).toBe(1); // 4/4 = 1
    expect(estimateTokens("abcde")).toBe(2); // ceil(5/4) = 2
    expect(estimateTokens("a")).toBe(1); // ceil(1/4) = 1
  });

  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("handles null/undefined gracefully", () => {
    // The function has a fallback: (text || "")
    expect(estimateTokens(undefined as unknown as string)).toBe(0);
    expect(estimateTokens(null as unknown as string)).toBe(0);
  });

  it("estimates longer text reasonably", () => {
    const text = "a".repeat(100);
    expect(estimateTokens(text)).toBe(25); // 100/4
  });
});

// ═══════════════════════════════════════════════════════════════════════
// assembleSections
// ═══════════════════════════════════════════════════════════════════════

describe("assembleSections", () => {
  const baseConfig: ContextAssemblerConfig = {
    systemPrompt: "You are Dash, a helpful AI agent.",
  };

  it("builds sections with minimal config", () => {
    const wm = createWorkingMemory();
    const sections = assembleSections(wm, { userInput: "Hello" }, baseConfig);

    expect(sections.primaryContent).toBe("Hello");
    expect(sections.instructions).toContain("You are Dash");
    expect(sections.examples).toBe("");
    expect(sections.cues).toBe("");
  });

  it("includes defaultInstructions before systemPrompt", () => {
    const config: ContextAssemblerConfig = {
      systemPrompt: "You are Dash.",
      defaultInstructions: "Always be concise.",
    };
    const sections = assembleSections(createWorkingMemory(), { userInput: "Hi" }, config);
    expect(sections.instructions).toContain("Always be concise.");
    expect(sections.instructions).toContain("You are Dash.");
    // defaultInstructions comes first
    const instructionIdx = sections.instructions.indexOf("Always be concise.");
    const promptIdx = sections.instructions.indexOf("You are Dash.");
    expect(instructionIdx).toBeLessThan(promptIdx);
  });

  it("includes defaultCues in cues section", () => {
    const config: ContextAssemblerConfig = {
      systemPrompt: "Agent",
      defaultCues: "Respond in JSON format.",
    };
    const sections = assembleSections(createWorkingMemory(), { userInput: "test" }, config);
    expect(sections.cues).toBe("Respond in JSON format.");
  });

  it("includes working memory in supportingContent", () => {
    const entries: MemoryEntry[] = [
      { id: "1", type: "episodic", content: "Past event", createdAt: new Date().toISOString() },
    ];
    const wm = updateWorkingMemory(createWorkingMemory(), {
      activeGoal: "Answer question",
      retrieved: entries,
    });
    const sections = assembleSections(wm, { userInput: "What happened?" }, baseConfig);

    expect(sections.supportingContent).toContain("Active goal");
    expect(sections.supportingContent).toContain("Answer question");
    expect(sections.supportingContent).toContain("[episodic] Past event");
  });

  it("has empty supportingContent when working memory is empty", () => {
    const sections = assembleSections(createWorkingMemory(), { userInput: "Hi" }, baseConfig);
    expect(sections.supportingContent).toBe("");
  });

  it("uses userInput as primaryContent", () => {
    const sections = assembleSections(
      createWorkingMemory(),
      { userInput: "Write a blog post about TypeScript" },
      baseConfig
    );
    expect(sections.primaryContent).toBe("Write a blog post about TypeScript");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// sectionsToMessages
// ═══════════════════════════════════════════════════════════════════════

describe("sectionsToMessages", () => {
  it("creates system + user messages from sections", () => {
    const sections = {
      supportingContent: "",
      instructions: "You are a helpful assistant.",
      examples: "",
      cues: "",
      primaryContent: "Hello!",
    };
    const messages = sectionsToMessages(sections);

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("You are a helpful assistant.");
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toBe("Hello!");
  });

  it("includes supporting content in system message with separator", () => {
    const sections = {
      supportingContent: "Retrieved: some context data",
      instructions: "System prompt here.",
      examples: "",
      cues: "",
      primaryContent: "Question?",
    };
    const messages = sectionsToMessages(sections);
    const systemContent = messages[0].content as string;
    expect(systemContent).toContain("Context / memory");
    expect(systemContent).toContain("Retrieved: some context data");
  });

  it("includes examples in system message with separator", () => {
    const sections = {
      supportingContent: "",
      instructions: "Prompt",
      examples: "Example: input → output",
      cues: "",
      primaryContent: "Do it",
    };
    const messages = sectionsToMessages(sections);
    const systemContent = messages[0].content as string;
    expect(systemContent).toContain("Examples");
    expect(systemContent).toContain("Example: input → output");
  });

  it("includes cues in system message with separator", () => {
    const sections = {
      supportingContent: "",
      instructions: "Prompt",
      examples: "",
      cues: "Respond in JSON",
      primaryContent: "Query",
    };
    const messages = sectionsToMessages(sections);
    const systemContent = messages[0].content as string;
    expect(systemContent).toContain("Output format");
    expect(systemContent).toContain("Respond in JSON");
  });

  it("inserts conversation history between system and user messages", () => {
    const sections = {
      supportingContent: "",
      instructions: "System",
      examples: "",
      cues: "",
      primaryContent: "Current question",
    };
    const history: ContextMessage[] = [
      { role: "user", content: "Previous question" },
      { role: "assistant", content: "Previous answer" },
    ];
    const messages = sectionsToMessages(sections, history);

    expect(messages).toHaveLength(4); // system + 2 history + user
    expect(messages[0].role).toBe("system");
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toBe("Previous question");
    expect(messages[2].role).toBe("assistant");
    expect(messages[2].content).toBe("Previous answer");
    expect(messages[3].role).toBe("user");
    expect(messages[3].content).toBe("Current question");
  });

  it("handles empty history", () => {
    const sections = {
      supportingContent: "",
      instructions: "Sys",
      examples: "",
      cues: "",
      primaryContent: "Q",
    };
    const messages = sectionsToMessages(sections, []);
    expect(messages).toHaveLength(2);
  });

  it("omits system message when all sections are empty", () => {
    const sections = {
      supportingContent: "",
      instructions: "",
      examples: "",
      cues: "",
      primaryContent: "Just a user message",
    };
    const messages = sectionsToMessages(sections);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
  });

  // ── End-to-end: assembleSections → sectionsToMessages ──────────────

  it("full pipeline produces valid LLM messages", () => {
    const config: ContextAssemblerConfig = {
      systemPrompt: "You are Dash.",
      defaultInstructions: "Be concise.",
      defaultCues: "Use markdown.",
    };
    const entries: MemoryEntry[] = [
      { id: "m1", type: "semantic", content: "TypeScript is a typed superset of JS", createdAt: new Date().toISOString() },
    ];
    const wm = updateWorkingMemory(createWorkingMemory(), {
      activeGoal: "Explain TypeScript",
      retrieved: entries,
      lastThought: "Focus on types",
    });
    const history: ContextMessage[] = [
      { role: "user", content: "What is TypeScript?" },
      { role: "assistant", content: "TypeScript is..." },
    ];

    const sections = assembleSections(wm, { userInput: "Tell me more", conversationHistory: history }, config);
    const messages = sectionsToMessages(sections, history);

    // system + 2 history + user
    expect(messages).toHaveLength(4);
    expect(messages[0].role).toBe("system");
    expect(messages[3].role).toBe("user");
    expect(messages[3].content).toBe("Tell me more");

    // System message has all parts
    const sys = messages[0].content as string;
    expect(sys).toContain("Be concise.");
    expect(sys).toContain("You are Dash.");
    expect(sys).toContain("Active goal");
    expect(sys).toContain("Explain TypeScript");
    expect(sys).toContain("[semantic] TypeScript is a typed superset of JS");
    expect(sys).toContain("Use markdown.");
  });
});
