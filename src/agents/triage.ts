/**
 * Agent output triage — parse [NEEDS_HUMAN] blocks from agent output,
 * record questions on the backlog item, and surface as notifications.
 *
 * Called after every agent exit (success or failure).
 */

import { getBoardProvider } from "../board/provider.js";
import { pushNotification } from "../goals/notifications.js";
import { logActivity } from "../activity/log.js";
import { createLogger } from "../utils/logger.js";
import type { AgentTask } from "./types.js";

const log = createLogger("agent-triage");

const NEEDS_HUMAN_RE = /\[NEEDS_HUMAN\]\s*([\s\S]*?)\s*\[\/NEEDS_HUMAN\]/g;

export interface HumanQuestion {
  taskLabel: string;
  questions: string[];
}

/**
 * Parse [NEEDS_HUMAN] blocks from agent output.
 * Returns extracted questions or null if none found.
 */
export function parseNeedsHuman(output: string): string[] | null {
  const blocks = [...output.matchAll(NEEDS_HUMAN_RE)];
  if (blocks.length === 0) return null;

  const questions: string[] = [];
  for (const block of blocks) {
    const lines = block[1]
      .split("\n")
      .map((l) => l.replace(/^[-*•]\s*/, "").trim())
      .filter((l) => l.length > 0);
    questions.push(...lines);
  }

  return questions.length > 0 ? questions : null;
}

/**
 * Process agent output for human questions.
 * If found: record on board item as exchange, push notification, log activity.
 * Returns true if questions were found and recorded.
 */
export async function triageAgentOutput(
  task: AgentTask,
  output: string,
): Promise<boolean> {
  const questions = parseNeedsHuman(output);
  if (!questions) {
    log.debug(`No human questions found in output`, { taskId: task.id, label: task.label });
    return false;
  }

  log.info(`Agent needs human input: ${task.label}`, { taskId: task.id, questionCount: questions.length });

  const questionText = questions.map((q) => `- ${q}`).join("\n");

  logActivity({
    source: "agent",
    summary: `Agent "${task.label}" needs human input (${questions.length} question(s))`,
    detail: questionText,
  });

  // Try to record questions on the board item as an exchange
  const board = getBoardProvider();
  if (board?.isAvailable()) {
    const store = (board as any).getStore?.();
    if (store) {
      // Try to find the board item this agent was working on
      // Look through all active tasks for a matching label or title
      const allTasks = await store.list();
      const matchingTask = allTasks.find((t: any) =>
        task.label.includes(t.identifier) ||
        task.label.toLowerCase().includes(t.title?.toLowerCase()?.slice(0, 30)) ||
        task.prompt.includes(t.id)
      );

      if (matchingTask) {
        await store.addExchange(matchingTask.id, {
          author: "Agent",
          body: `Blocked — needs human input:\n${questionText}`,
          source: "chat" as const,
        });
        logActivity({
          source: "agent",
          summary: `Recorded questions on ${matchingTask.identifier}: ${matchingTask.title}`,
        });
      }
    }
  }

  // Surface to human via notification
  pushNotification({
    timestamp: new Date().toISOString(),
    source: "agent",
    message: `Agent "${task.label}" needs your input:\n${questionText}`,
  });

  return true;
}
