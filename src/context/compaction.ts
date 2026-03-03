/**
 * Conversation history compaction.
 * Summarizes older turns into a compact paragraph to reduce token usage,
 * keeping recent turns verbatim for coherent conversation flow.
 */

import type { ContextMessage } from "../types.js";
import type { ProviderName } from "../llm/providers/types.js";
import { completeChat } from "../llm/complete.js";

/** Number of messages that triggers compaction. */
export const COMPACT_THRESHOLD = 20;

/** Number of recent messages to always keep verbatim (3 turns). */
export const KEEP_RECENT = 6;

export interface CompactionResult {
  /** New combined summary (existing + newly compacted). */
  summary: string;
  /** Messages to keep verbatim (the recent ones). */
  trimmedHistory: ContextMessage[];
  /** True if compaction actually ran. */
  compacted: boolean;
}

/**
 * Format messages into a readable transcript for the summarizer.
 */
export function formatMessagesForSummary(messages: ContextMessage[]): string {
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => {
      const role = m.role === "user" ? "Human" : "Assistant";
      const text = typeof m.content === "string"
        ? m.content
        : (m.content as Array<{ type: string; text?: string }>)
            .filter((b) => b.type === "text" && typeof b.text === "string")
            .map((b) => b.text)
            .join(" ") || "[image]";
      return `${role}: ${text}`;
    })
    .join("\n\n");
}

/**
 * Compact conversation history by summarizing older messages.
 *
 * When history exceeds COMPACT_THRESHOLD, all messages except the most recent
 * KEEP_RECENT are summarized into a paragraph via the utility model. The summary
 * is appended to any existing summary (incremental — never re-summarizes).
 *
 * Never throws — returns compacted: false on any failure.
 */
export async function compactHistory(
  history: ContextMessage[],
  existingSummary: string,
  provider: ProviderName,
  model?: string,
): Promise<CompactionResult> {
  // Not enough messages to compact
  if (history.length < COMPACT_THRESHOLD) {
    return { summary: existingSummary, trimmedHistory: history, compacted: false };
  }

  const toSummarize = history.slice(0, -KEEP_RECENT);
  const toKeep = history.slice(-KEEP_RECENT);
  const transcript = formatMessagesForSummary(toSummarize);

  if (!transcript.trim()) {
    return { summary: existingSummary, trimmedHistory: history, compacted: false };
  }

  try {
    const prompt = [
      `You are a conversation summarizer. Produce a concise paragraph (3-6 sentences) capturing:`,
      `- Key topics discussed`,
      `- Decisions made`,
      `- Important facts or preferences shared`,
      `- The user's current intent or mood`,
      ``,
      `Do NOT use verbatim quotes. Do NOT include filler. Be factual and dense.`,
      ...(existingSummary
        ? [``, `Previous summary of even earlier conversation:`, existingSummary, ``]
        : []),
      ``,
      `Conversation to summarize:`,
      transcript,
    ].join("\n");

    const summary = await completeChat({
      messages: [
        { role: "system", content: "You summarize conversations concisely. Output only the summary paragraph, nothing else." },
        { role: "user", content: prompt },
      ],
      provider,
      model,
    });

    return {
      summary: summary.trim(),
      trimmedHistory: toKeep,
      compacted: true,
    };
  } catch {
    // On any failure, skip compaction — full history is sent as fallback
    return { summary: existingSummary, trimmedHistory: history, compacted: false };
  }
}
