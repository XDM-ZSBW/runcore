/**
 * Brain — orchestrator for Core: memory + context assembly + retrieval.
 * Implements the "brain" layer: internal actions (retrieve, learn) and context assembly.
 */

import type { BrainConfig, GetContextOptions, GetContextResult, LearnInput, MemoryEntry, WorkingMemory } from "./types.js";
import type { LongTermMemoryStore } from "./memory/long-term.js";
import { InMemoryLongTermMemory } from "./memory/long-term.js";
import { createWorkingMemory, updateWorkingMemory } from "./memory/working.js";
import { assembleSections, sectionsToMessages } from "./context/assembler.js";

export class Brain {
  private readonly config: BrainConfig;
  private readonly ltm: LongTermMemoryStore;
  private workingMemory: WorkingMemory;

  constructor(config: BrainConfig, ltm?: LongTermMemoryStore) {
    this.config = {
      maxRetrieved: 10,
      ...config,
    };
    this.ltm = ltm ?? new InMemoryLongTermMemory();
    this.workingMemory = createWorkingMemory();
  }

  /**
   * Internal action: retrieve from LTM into working memory.
   * Called automatically in getContextForTurn; can also be called explicitly.
   */
  async retrieve(query: string, options?: { max?: number; type?: "episodic" | "semantic" | "procedural" }): Promise<MemoryEntry[]> {
    const max = options?.max ?? this.config.maxRetrieved ?? 10;
    const entries = await this.ltm.search({
      contentSubstring: query,
      type: options?.type,
    });
    const selected = entries.slice(0, max);
    this.workingMemory = updateWorkingMemory(this.workingMemory, {
      retrieved: selected,
    });
    return selected;
  }

  /**
   * Assemble full context for this turn: retrieve, build sections, return messages + working memory.
   */
  async getContextForTurn(options: GetContextOptions): Promise<GetContextResult> {
    const retrievalQuery = options.retrievalQuery ?? options.userInput;
    const maxRetrieved = options.maxRetrieved ?? this.config.maxRetrieved ?? 10;

    // Internal action: retrieve into working memory
    await this.retrieve(retrievalQuery, { max: maxRetrieved });

    this.workingMemory = updateWorkingMemory(this.workingMemory, {
      perceptualInput: options.userInput,
      activeGoal: options.userInput,
    });

    const sections = assembleSections(this.workingMemory, options, {
      systemPrompt: this.config.systemPrompt,
      defaultInstructions: this.config.defaultInstructions,
      defaultCues: this.config.defaultCues,
      maxSupportingTokens: this.config.maxSupportingTokens,
    });

    const messages = sectionsToMessages(sections, options.conversationHistory ?? []);

    return {
      messages,
      sections,
      workingMemory: this.workingMemory,
    };
  }

  /**
   * Internal action: learn — write to long-term memory.
   */
  async learn(input: LearnInput): Promise<MemoryEntry> {
    const entry = await this.ltm.add({
      type: input.type,
      content: input.content,
      meta: input.meta,
    });
    return entry;
  }

  /**
   * Update working memory with the latest thought (e.g. after LLM reasoning).
   * Call this after the model returns a "thought" or reasoning block if you use ReAct-style loops.
   */
  setLastThought(thought: string): void {
    this.workingMemory = updateWorkingMemory(this.workingMemory, { lastThought: thought });
  }

  /**
   * Clear working memory retrieved items and optional scratch (e.g. for a new task or turn).
   */
  clearWorkingMemory(clearScratch = false): void {
    this.workingMemory = updateWorkingMemory(this.workingMemory, {
      retrieved: [],
      lastThought: undefined,
      scratch: clearScratch ? {} : this.workingMemory.scratch,
    });
  }

  /** Access current working memory (read-only). */
  getWorkingMemory(): Readonly<WorkingMemory> {
    return this.workingMemory;
  }

  /** Access LTM for advanced use (e.g. list, delete). */
  getLongTermMemory(): LongTermMemoryStore {
    return this.ltm;
  }
}
