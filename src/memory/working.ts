/**
 * Working memory — scratchpad for the current turn (COALA working memory).
 * Holds perceptual input, active goal, retrieved LTM items, and scratch.
 */

import type { MemoryEntry, WorkingMemory } from "../types.js";

export function createWorkingMemory(): WorkingMemory {
  return {
    retrieved: [],
    scratch: {},
  };
}

export function updateWorkingMemory(
  current: WorkingMemory,
  updates: Partial<Pick<WorkingMemory, "perceptualInput" | "activeGoal" | "retrieved" | "lastThought">> & { scratch?: Record<string, unknown> }
): WorkingMemory {
  const next: WorkingMemory = {
    ...current,
    ...updates,
    scratch: updates.scratch !== undefined ? { ...current.scratch, ...updates.scratch } : current.scratch,
  };
  return next;
}

/** Format working memory for inclusion in context (supporting content or instructions). */
export function formatWorkingMemoryForContext(wm: WorkingMemory): string {
  const parts: string[] = [];
  if (wm.activeGoal) parts.push(`## Active goal\n${wm.activeGoal}`);
  if (wm.retrieved.length > 0) {
    parts.push(
      "## Retrieved from memory\n" +
        wm.retrieved
          .map((e) => `- [${e.type}] ${e.content}`)
          .join("\n")
    );
  }
  if (wm.lastThought) parts.push(`## Latest thought\n${wm.lastThought}`);
  return parts.length > 0 ? parts.join("\n\n") : "";
}
