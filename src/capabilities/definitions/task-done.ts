/**
 * Task-Done meta capability — marks board items as done when the autonomous
 * planner emits [TASK_DONE] blocks after completing work.
 *
 * Meta pattern: all blocks are batched and processed together (not one-by-one).
 * Autonomous-only — not used in chat or email flows.
 */

import { getBoardProvider } from "../../board/provider.js";
import { logActivity } from "../../activity/log.js";
import { createLogger } from "../../utils/logger.js";
import type { MetaCapability, ParsedActionBlock, MetaExecutionResult, ActionContext } from "../types.js";

const log = createLogger("cap:task-done");

export const taskDoneCapability: MetaCapability = {
  id: "task-done",
  pattern: "meta",
  tag: "TASK_DONE",
  keywords: ["task_done", "complete"],

  getPromptInstructions(_ctx) {
    return [
      `## Task Done (via [TASK_DONE] blocks)`,
      `After completing a task from the backlog (e.g., an agent finished work, you performed an action),`,
      `mark the corresponding board item as done by including a [TASK_DONE] block:`,
      ``,
      `[TASK_DONE]`,
      `{"taskId": "the-task-id-from-the-board"}`,
      `[/TASK_DONE]`,
      ``,
      `The task ID is provided in the backlog context (e.g., "DASH-5: Schedule meeting [todo, P4] (id: abc123)").`,
      `Use the 'id' value, not the human-readable identifier.`,
    ].join("\n");
  },

  async processBlocks(blocks: ParsedActionBlock[], ctx: ActionContext): Promise<MetaExecutionResult> {
    const board = getBoardProvider();
    const results: Array<{ ok: boolean; message: string }> = [];

    for (const block of blocks) {
      if (!block.payload) {
        results.push({ ok: false, message: "Invalid JSON in TASK_DONE block" });
        continue;
      }

      const req = block.payload as Record<string, unknown>;
      const taskId = req.taskId as string | undefined;

      if (!taskId) {
        results.push({ ok: false, message: "Missing taskId field" });
        continue;
      }

      if (!board?.isAvailable()) {
        results.push({ ok: false, message: "Board provider not available" });
        continue;
      }

      try {
        const store = (board as any).getStore?.();
        if (!store) {
          results.push({ ok: false, message: "Queue store not available" });
          continue;
        }

        const task = await store.get(taskId);
        if (!task) {
          results.push({ ok: false, message: `Task not found: ${taskId}` });
          continue;
        }

        await store.update(task.id, { state: "done" });
        log.info(`Marked task done: ${task.identifier} — ${task.title}`);
        logActivity({
          source: "autonomous",
          summary: `Completed task ${task.identifier}: ${task.title}`,
          actionLabel: "AUTONOMOUS",
          reason: "planner marked task done after action",
        });
        results.push({ ok: true, message: `Closed ${task.identifier}: ${task.title}` });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn("Failed to process TASK_DONE block", { error: msg });
        results.push({ ok: false, message: msg });
      }
    }

    return {
      capabilityId: "task-done",
      blocksProcessed: blocks.length,
      results,
    };
  },
};
