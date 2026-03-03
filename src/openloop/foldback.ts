/**
 * Open Loop Protocol — branch fold-back.
 * Compresses a conversation into a Triad + OpenLoopPackets.
 * Called once per session when a conversation reaches sufficient depth.
 */

import { completeChat } from "../llm/complete.js";
import { resolveProvider, resolveUtilityModel } from "../settings.js";
import { logActivity } from "../activity/log.js";
import { createLogger } from "../utils/logger.js";
import type { ContextMessage } from "../types.js";
import { createLoop, createTriad } from "./store.js";
import type { OpenLoopPacket, Triad } from "./types.js";
import { getInstanceName } from "../instance.js";

const log = createLogger("open-loop-foldback");

const FOLDBACK_SYSTEM_PROMPT = `You are a semantic compressor for ${getInstanceName()}'s Open Loop Protocol.
You receive a conversation transcript and must extract:

1. **anchor** — The core subject/entity discussed (who/what). Short noun phrase.
2. **vectorShift** — How understanding changed during the conversation. Not what was said — what moved. One sentence.
3. **residualTensions** — Array of unresolved questions/contradictions. Each has:
   - **dissonance**: The specific question or tension (1 sentence)
   - **searchHeuristic**: Array of 2-5 keyword/phrase "magnets" for ambient scanning

Only include genuine residual tensions — things that were raised but NOT resolved.
If the conversation fully resolved everything, return an empty residualTensions array.

Respond with ONLY a JSON object:
{
  "anchor": "string",
  "vectorShift": "string",
  "residualTensions": [
    { "dissonance": "string", "searchHeuristic": ["keyword1", "keyword2"] }
  ]
}`;

export interface FoldBackInput {
  history: ContextMessage[];
  historySummary?: string;
  sourceTraceId?: string;
  sessionId?: string;
}

export interface FoldBackResult {
  triad: Triad;
  openLoops: OpenLoopPacket[];
}

/**
 * Fold a conversation back into the vertical stream.
 * Creates a Triad + OpenLoopPackets for each residual tension.
 * Returns null for trivial conversations (< 3 user messages or < 200 chars).
 */
export async function foldBack(input: FoldBackInput): Promise<FoldBackResult | null> {
  const { history, historySummary, sourceTraceId, sessionId } = input;

  // Gate: skip trivial conversations
  const userMessages = history.filter((m) => m.role === "user");
  if (userMessages.length < 3) {
    log.info("Skipping fold-back: fewer than 3 user messages");
    return null;
  }

  const transcriptText = history
    .map((m) => {
      const content = typeof m.content === "string" ? m.content : m.content.map((b) => b.type === "text" ? b.text : "[image]").join(" ");
      return `${m.role}: ${content}`;
    })
    .join("\n");

  if (transcriptText.length < 200) {
    log.info("Skipping fold-back: transcript < 200 chars");
    return null;
  }

  // Build the prompt — include summary if available for context
  const userContent = historySummary
    ? `## Conversation summary\n${historySummary}\n\n## Full transcript\n${transcriptText}`
    : transcriptText;

  try {
    const provider = resolveProvider();
    const model = resolveUtilityModel();

    const response = await completeChat({
      messages: [
        { role: "system", content: FOLDBACK_SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
      model,
      provider,
      noCache: true,
    });

    // Parse JSON from response
    let jsonStr = response.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) jsonStr = fenceMatch[1].trim();
    const objMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (!objMatch) {
      log.warn("Failed to extract JSON from fold-back response");
      return null;
    }

    const parsed = JSON.parse(objMatch[0]) as {
      anchor: string;
      vectorShift: string;
      residualTensions: Array<{
        dissonance: string;
        searchHeuristic: string[];
      }>;
    };

    if (!parsed.anchor || !parsed.vectorShift) {
      log.warn("Invalid fold-back response: missing anchor or vectorShift");
      return null;
    }

    // Create open loops for each residual tension (7-day TTL)
    const openLoops: OpenLoopPacket[] = [];
    const tensions = parsed.residualTensions ?? [];

    // Create a placeholder triad ID so loops can reference it
    // (we'll create the triad after the loops to get their IDs)
    for (const tension of tensions) {
      if (!tension.dissonance || !tension.searchHeuristic?.length) continue;
      const loop = await createLoop({
        anchor: parsed.anchor,
        dissonance: tension.dissonance,
        searchHeuristic: tension.searchHeuristic,
      });
      openLoops.push(loop);
    }

    // Create the triad
    const triad = await createTriad({
      anchor: parsed.anchor,
      vectorShift: parsed.vectorShift,
      residualTensions: tensions.map((t) => t.dissonance),
      openLoopIds: openLoops.map((l) => l.id),
      sourceTraceId,
      sessionId,
    });

    // Update loop triadIds (append updated state lines)
    // Note: we skip this to avoid extra JSONL lines — the triad already references the loop IDs

    // Log activity
    logActivity({
      source: "open-loop" as any,
      summary: `Branch fold-back: "${parsed.anchor}" — ${openLoops.length} open loop(s), shift: "${parsed.vectorShift}"`,
    });

    log.info(`Fold-back complete: triad=${triad.id}, loops=${openLoops.length}`);
    return { triad, openLoops };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Fold-back failed: ${msg}`);
    return null;
  }
}
