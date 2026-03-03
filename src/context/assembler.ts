/**
 * Context assembly — dynamically build the prompt context (Context Engineering).
 * Assembles: supporting content, instructions, examples, cues, primary content.
 */

import type { ContextMessage, ContextSections, GetContextOptions, WorkingMemory } from "../types.js";
import { formatWorkingMemoryForContext } from "../memory/working.js";

export interface ContextAssemblerConfig {
  systemPrompt: string;
  defaultInstructions?: string;
  defaultCues?: string;
  maxSupportingTokens?: number;
}

/**
 * Build context sections from working memory, options, and config.
 * Does not perform retrieval; caller injects already-retrieved working memory.
 */
export function assembleSections(
  workingMemory: WorkingMemory,
  options: GetContextOptions,
  config: ContextAssemblerConfig
): ContextSections {
  const memoryBlock = formatWorkingMemoryForContext(workingMemory);
  let supportingContent = memoryBlock
    ? `${memoryBlock}\n`
    : "";

  // Enforce token budget on supporting content
  if (config.maxSupportingTokens && supportingContent) {
    const tokens = estimateTokens(supportingContent);
    if (tokens > config.maxSupportingTokens) {
      const maxChars = config.maxSupportingTokens * 4;
      supportingContent = supportingContent.slice(0, maxChars) + "\n...(truncated to fit token budget)";
    }
  }

  const instructions = [config.defaultInstructions, config.systemPrompt].filter(Boolean).join("\n\n");
  const cues = config.defaultCues ?? "";
  const primaryContent = options.userInput;

  return {
    supportingContent: supportingContent.trim(),
    instructions,
    examples: "",
    cues,
    primaryContent,
  };
}

/**
 * Turn context sections into a single system message (one common pattern).
 * Order: instructions first, then supporting content, then cues, then primary as user message.
 */
export function sectionsToMessages(sections: ContextSections, includeHistory: ContextMessage[] = []): ContextMessage[] {
  const systemParts: string[] = [];
  if (sections.instructions) systemParts.push(sections.instructions);
  if (sections.supportingContent) systemParts.push("\n---\nContext / memory\n---\n" + sections.supportingContent);
  if (sections.examples) systemParts.push("\n---\nExamples\n---\n" + sections.examples);
  if (sections.cues) systemParts.push("\n---\nOutput format\n---\n" + sections.cues);

  const messages: ContextMessage[] = [];
  if (systemParts.length > 0) {
    messages.push({ role: "system", content: systemParts.join("\n") });
  }

  // History: typically [assistant, user, assistant, user, ...] — add in order
  for (const msg of includeHistory) {
    messages.push(msg);
  }

  messages.push({ role: "user", content: sections.primaryContent });
  return messages;
}

/**
 * Rough token estimate (chars / 4). Use a real tokenizer if you need accuracy.
 */
export function estimateTokens(text: string): number {
  return Math.ceil((text || "").length / 4);
}
