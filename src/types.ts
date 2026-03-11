/**
 * Shared types for Core Brain — context engineering & cognitive architecture.
 */

/** Long-term memory kind (COALA-style). */
export type LongTermMemoryType = "episodic" | "semantic" | "procedural";

/** One stored item in long-term memory. */
export interface MemoryEntry {
  id: string;
  type: LongTermMemoryType;
  content: string;
  /** Optional metadata for filtering/recall (e.g. topic, time). */
  meta?: Record<string, string | number | boolean>;
  createdAt: string; // ISO
}

/** Working memory: scratchpad for the current turn. */
export interface WorkingMemory {
  /** Current user/task input. */
  perceptualInput?: string;
  /** Active goal or task description. */
  activeGoal?: string;
  /** Items retrieved from LTM for this turn. */
  retrieved: MemoryEntry[];
  /** Latest reasoning or thought (e.g. from last LLM call). */
  lastThought?: string;
  /** Optional key-value scratch for the current session. */
  scratch: Record<string, unknown>;
}

/** Multimodal content block for vision-capable messages. */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/** One message in a conversation (for context assembly). */
export interface ContextMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentBlock[] | null;
  /** For role "tool" — the ID of the tool call this result corresponds to. */
  tool_call_id?: string;
  /** For role "assistant" — tool calls the model is requesting. */
  tool_calls?: Array<{
    id: string;
    type?: "function";
    function: { name: string; arguments: string };
  }>;
  /** Persisted summary of tools used during this response (for history rendering). */
  toolsUsed?: Array<{ name: string; isError?: boolean }>;
  /** Persisted summary of agents spawned during this response (for history rendering). */
  agentsUsed?: Array<{
    label: string;
    taskId?: string;
    status: "completed" | "failed" | "cancelled" | "running";
    elapsed?: string;
    resultSummary?: string;
  }>;
}

/** Building blocks of prompt context (Agent32 / context engineering). */
export interface ContextSections {
  /** Supporting content / background (e.g. retrieved docs, facts). */
  supportingContent: string;
  /** Core instructions for the model. */
  instructions: string;
  /** Few-shot examples (optional). */
  examples: string;
  /** Cues / output format hints (e.g. JSON schema, structure). */
  cues: string;
  /** Primary content — the actual user input or task. */
  primaryContent: string;
}

/** Options when assembling context for a turn. */
export interface GetContextOptions {
  /** Current user input or task. */
  userInput: string;
  /** Prior conversation messages (recent first or chronological). */
  conversationHistory?: ContextMessage[];
  /** Max tokens to target for the assembled context (soft limit). */
  maxTokens?: number;
  /** Optional retrieval query (defaults to userInput). */
  retrievalQuery?: string;
  /** Max LTM entries to retrieve into working memory. */
  maxRetrieved?: number;
}

/** Result of getContextForTurn. */
export interface GetContextResult {
  /** Messages ready to send to the LLM (system + context + history + user). */
  messages: ContextMessage[];
  /** Assembled sections (if you need to inspect or log). */
  sections: ContextSections;
  /** Current working memory after retrieval. */
  workingMemory: WorkingMemory;
}

/** Payload for learning (writing to LTM). */
export interface LearnInput {
  type: LongTermMemoryType;
  content: string;
  meta?: Record<string, string | number | boolean>;
}

/** Brain configuration. */
export interface BrainConfig {
  /** System prompt / role definition. */
  systemPrompt: string;
  /** Optional instructions appended every turn. */
  defaultInstructions?: string;
  /** Optional output format cues (e.g. "Respond in JSON."). */
  defaultCues?: string;
  /** Max LTM entries to retrieve per turn. */
  maxRetrieved?: number;
  /** Optional token budget for supporting content (to avoid lost-in-the-middle). */
  maxSupportingTokens?: number;
}
