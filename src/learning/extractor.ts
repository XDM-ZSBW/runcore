/**
 * Automatic fact extraction from conversation.
 * After each substantive chat turn, extracts learnable facts and persists them
 * via brain.learn() so they surface in future turns through existing LTM retrieval.
 */

import type { Brain } from "../brain.js";
import type { ContextMessage, LongTermMemoryType } from "../types.js";
import type { ProviderName } from "../llm/providers/types.js";
import { completeChat } from "../llm/complete.js";
import { getInstanceName } from "../instance.js";

export interface ExtractionOptions {
  brain: Brain;
  recentMessages: ContextMessage[];
  userMessage: string;
  provider: ProviderName;
  model?: string;
  lastExtractionTurn: number;
  currentTurn: number;
}

export interface ExtractionResult {
  extracted: number;
  skipped: boolean;
  error?: string;
}

interface ExtractedFact {
  type: LongTermMemoryType;
  content: string;
  tags?: string[];
}

const EXTRACTION_PROMPT = `You are a memory extraction system. Your job is to identify DURABLE facts from a conversation between a user and their AI assistant (${getInstanceName()}).

Extract ONLY facts worth remembering MONTHS from now:
- Personal identity (name, job, location, relationships)
- Stable preferences (tools, languages, workflows, communication style)
- Real projects or goals the user is actively pursuing
- Meaningful life experiences or stories
- Explicit corrections ("actually, I meant..." or "no, I use X not Y")

DO NOT extract — return [] instead:
- Anything the assistant said or did (only extract what the USER reveals)
- Conversation mechanics ("user said try again", "user tested the flow", "user asked about X")
- Short or ambiguous messages — if the user just said 1-3 words, there is NOTHING to extract
- Search queries or questions the user asked (knowing they asked is not a durable fact)
- Anything about the current conversation itself ("this is the start of...", "user is aware of previous...")
- Generic knowledge, news, or facts the assistant looked up
- Greetings, filler, or meta-commentary ("ok", "thanks", "try again", "test")
- Duplicates of existing memories (check the list below)
- Vague "goals" inferred from casual remarks — only extract goals the user explicitly states as their own

Be VERY conservative. Most conversation turns have NOTHING worth extracting. When in doubt, return [].

For each fact, output a JSON object with:
- "type": "semantic" for facts/preferences, "episodic" for significant life experiences only
- "content": A clear, standalone sentence (e.g. "User is building AI agents in TypeScript")
- "tags": 1-3 short tags for categorization

Respond with a JSON array. If there's nothing worth extracting (this is the common case), respond with [].
Do NOT wrap in markdown fences. Output ONLY the JSON array.`;

/**
 * Extract learnable facts from recent conversation and persist them.
 * Designed to be fire-and-forget — never throws.
 */
export async function extractAndLearn(options: ExtractionOptions): Promise<ExtractionResult> {
  try {
    // --- Heuristic gate ---
    if (options.userMessage.length < 20) {
      return { extracted: 0, skipped: true };
    }
    if (options.currentTurn - options.lastExtractionTurn < 2) {
      return { extracted: 0, skipped: true };
    }

    // --- Retrieve existing memories for dedup context ---
    const existing = await options.brain.retrieve(options.userMessage, { max: 5 });
    const existingContext = existing.length > 0
      ? `\n\nExisting memories (do NOT duplicate these):\n${existing.map((e) => `- ${e.content}`).join("\n")}`
      : "";

    // --- Build messages for extraction ---
    const conversationText = options.recentMessages
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n\n");

    const messages: ContextMessage[] = [
      {
        role: "system",
        content: EXTRACTION_PROMPT + existingContext,
      },
      {
        role: "user",
        content: `Extract learnable facts from this conversation:\n\n${conversationText}`,
      },
    ];

    // --- Call LLM ---
    const raw = await completeChat({
      messages,
      model: options.model,
      provider: options.provider,
    });

    // --- Parse response ---
    const facts = parseFacts(raw);
    if (facts.length === 0) {
      return { extracted: 0, skipped: false };
    }

    // --- Persist each fact ---
    let persisted = 0;
    for (const fact of facts) {
      await options.brain.learn({
        type: fact.type,
        content: fact.content,
        meta: {
          source: "auto-extraction",
          ...(fact.tags ? { tags: fact.tags.join(",") } : {}),
        },
      });
      persisted++;
    }

    return { extracted: persisted, skipped: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { extracted: 0, skipped: false, error: message };
  }
}

/**
 * Lenient JSON array parser — strips markdown fences, validates each entry.
 */
function parseFacts(raw: string): ExtractedFact[] {
  // Strip markdown code fences if present
  let cleaned = raw.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  cleaned = cleaned.trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  const valid: ExtractedFact[] = [];
  for (const item of parsed) {
    if (
      typeof item === "object" &&
      item !== null &&
      "type" in item &&
      "content" in item &&
      (item.type === "semantic" || item.type === "episodic") &&
      typeof item.content === "string" &&
      item.content.length > 0
    ) {
      valid.push({
        type: item.type,
        content: item.content,
        tags: Array.isArray(item.tags) ? item.tags.filter((t: unknown) => typeof t === "string") : undefined,
      });
    }
  }

  return valid;
}
