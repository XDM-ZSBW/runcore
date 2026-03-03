/**
 * Agent batch continuation — when a batch of agents finishes, review results
 * and spawn the next round of work automatically.
 *
 * Uses completeChat (non-streaming) to ask the LLM what to do next,
 * parses AGENT_REQUEST blocks from the response, and spawns more agents.
 * Caps at MAX_ROUNDS to prevent infinite loops.
 */

import type { ContextMessage } from "../types.js";
import { completeChat } from "../llm/complete.js";
import { submitTask } from "./index.js";
import { logActivity } from "../activity/log.js";
import { createLogger } from "../utils/logger.js";
import { resolveProvider, resolveChatModel } from "../settings.js";
import { getInstanceName, getInstanceNameLower } from "../instance.js";
import { getBoardProvider } from "../board/provider.js";
import type { QueueBoardProvider } from "../queue/provider.js";

const log = createLogger("agent-continue");

const MAX_ROUNDS = 5; // Max auto-continue rounds per session trigger
const roundCounts = new Map<string, number>(); // sessionId → rounds used

/** Reset round counter for a session (call when user sends a new message). */
export function resetContinuationRounds(sessionId: string): void {
  roundCounts.delete(sessionId);
}

/**
 * After a batch of agents completes, ask the LLM what's next and spawn more.
 * Returns number of agents spawned (0 = nothing more to do).
 */
export async function continueAfterBatch(
  sessionId: string,
  boardContext: string,
  agentResults: Array<{ label: string; status: string }>,
  humanName: string,
): Promise<number> {
  // Check round limit
  const rounds = roundCounts.get(sessionId) ?? 0;
  log.info(`Auto-continue round ${rounds + 1}/${MAX_ROUNDS}`, { sessionId, agentCount: agentResults.length });
  if (rounds >= MAX_ROUNDS) {
    log.warn("Auto-continue round limit reached", { sessionId, maxRounds: MAX_ROUNDS });
    logActivity({ source: "agent", summary: `Auto-continue: hit ${MAX_ROUNDS}-round limit, pausing` });
    roundCounts.delete(sessionId);
    return 0;
  }

  const resultSummary = agentResults
    .map((r) => `- ${r.label}: ${r.status}`)
    .join("\n");

  const messages: ContextMessage[] = [
    {
      role: "system",
      content: [
        `You are ${getInstanceName()}, an AI agent working through a backlog for ${humanName}.`,
        `A batch of ${agentResults.length} agent(s) just finished. Review the results and the current board state.`,
        `Your job is to KEEP WORKING through the backlog until all actionable items are done.`,
        ``,
        `Rules:`,
        `- If there are items in "Backlog" or "Todo" state with clear deliverables, spawn agents for them.`,
        `- Items with descriptions mentioning specific files, modules, or acceptance criteria ARE actionable — spawn agents.`,
        `- Items titled "Spec: ..." are spec-writing tasks — spawn an agent to write the spec doc.`,
        `- Items that are truly vague (no description, no files, no criteria) should be skipped.`,
        `- KEEP GOING until no actionable items remain. Do NOT stop early.`,
        ``,
        `To spawn agents, output [AGENT_REQUEST] blocks with valid JSON:`,
        `[AGENT_REQUEST]`,
        `{"label": "task name", "taskId": "internal-id", "prompt": "Specific instructions with file paths..."}`,
        `[/AGENT_REQUEST]`,
        ``,
        `Include "taskId" from the board state to lock the task. Agent prompts MUST reference real files (src/, brain/, public/) and describe concrete changes.`,
        `You can spawn up to 5 agents at once.`,
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `--- Agent batch results (${agentResults.length} agents) ---`,
        resultSummary,
        ``,
        `--- Current board state (unassigned, not done/cancelled) ---`,
        boardContext || "(no remaining items)",
        ``,
        `Spawn agents for the next batch of actionable items. If nothing actionable remains, say "All done."`,
      ].join("\n"),
    },
  ];

  try {
    logActivity({
      source: "agent",
      summary: `Auto-continue: round ${rounds + 1}/${MAX_ROUNDS}, asking LLM for next batch`,
      detail: `Board context (${boardContext.length} chars): ${boardContext.slice(0, 500)}`,
    });

    const response = await completeChat({
      messages,
      model: resolveChatModel() ?? undefined,
      provider: resolveProvider(),
    });

    logActivity({
      source: "agent",
      summary: `Auto-continue: LLM responded (${response.length} chars)`,
      detail: response.slice(0, 500),
    });

    // Parse AGENT_REQUEST blocks from response
    const blocks = [...response.matchAll(/\[AGENT_REQUEST\]\s*([\s\S]*?)\s*\[\/AGENT_REQUEST\]/g)];
    if (blocks.length === 0) {
      logActivity({ source: "agent", summary: `Auto-continue: LLM found nothing more to do (no AGENT_REQUEST blocks in response)` });
      roundCounts.delete(sessionId);
      return 0;
    }

    // Try to get the queue store for assignee locking
    const board = getBoardProvider();
    const queueStore = (board as QueueBoardProvider | null)?.getStore?.();

    let spawned = 0;
    for (const block of blocks) {
      const raw = block[1].trim();
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) continue;

      try {
        const req = JSON.parse(jsonMatch[0]);
        if (!req.prompt) continue;

        // Same vague-prompt check as server.ts
        const hasFilePath = /(?:src\/|brain\/|public\/|\.ts|\.js|\.md|\.json|\.yaml|\.yml)/.test(req.prompt);
        const isVague = /\b(?:comprehensive|robust|production-ready|enterprise|scalable)\b/i.test(req.prompt) && !hasFilePath;
        const isWishList = (req.prompt.match(/^\d+\.\s/gm) || []).length >= 5 && !hasFilePath;

        let finalPrompt = req.prompt;
        if (isVague || isWishList) {
          finalPrompt = [
            `IMPORTANT: The original request below is vague. Do NOT try to build everything listed.`,
            `Instead: 1) Read the existing codebase (start with src/ and package.json).`,
            `2) Pick ONE small, concrete piece that connects to existing code.`,
            `3) Build that one thing well.`,
            `4) If nothing concrete can be built, create a spec at brain/knowledge/notes/ and exit.`,
            ``,
            `Original request:`,
            finalPrompt,
          ].join("\n");
        }

        const label = req.label || req.prompt.slice(0, 60);

        // Mark the task as assigned before spawning (prevents duplicate pickup)
        if (queueStore && req.taskId) {
          await queueStore.update(req.taskId, { assignee: `${getInstanceNameLower()}-agent` });
        }

        await submitTask({ label, prompt: finalPrompt, origin: "ai", sessionId });
        spawned++;
        logActivity({ source: "agent", summary: `Auto-continue spawned: ${label}` });
      } catch {
        // Skip unparseable blocks
      }
    }

    if (spawned > 0) {
      roundCounts.set(sessionId, rounds + 1);
      logActivity({ source: "agent", summary: `Auto-continue: round ${rounds + 1}/${MAX_ROUNDS}, spawned ${spawned} agent(s)` });
    } else {
      roundCounts.delete(sessionId);
    }

    return spawned;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logActivity({ source: "agent", summary: `Auto-continue error: ${msg}` });
    return 0;
  }
}
