/**
 * Goal Planner — bridges todos.md → board items → agent work.
 *
 * Event-driven, no timers. Activates on:
 *   1. Boot (seed board from existing todos)
 *   2. todos.md file change (fs.watch — human edited the source of truth)
 *   3. Board item completion (activity listener — sync done items back to todos.md)
 *
 * The board items create tension via logActivity → pressure system → pulse → agents.
 * This module only bridges the file ↔ board gap. The river moves; the net holds still.
 */

import { join } from "node:path";
import { watch, type FSWatcher } from "node:fs";
import { readBrainFile, writeBrainFile } from "../lib/brain-io.js";
import { logActivity, onActivity } from "../activity/log.js";
import { resolveEnv } from "../instance.js";
import { createLogger } from "../utils/logger.js";
import { BRAIN_DIR } from "../lib/paths.js";
import type { QueueStore } from "../queue/store.js";

const log = createLogger("goal-planner");

// ─── Config ────────────────────────────────────────────────────────────────

const MAX_PER_CYCLE = parseInt(resolveEnv("GOAL_PLANNER_MAX_PER_CYCLE") ?? "", 10) || 10;
const DEDUP_THRESHOLD = 0.7;
/** Debounce window for file changes (fs.watch fires multiple times per save). */
const DEBOUNCE_MS = 2000;

const TODOS_PATH = join(BRAIN_DIR, "operations", "todos.md");

// ─── Types ─────────────────────────────────────────────────────────────────

interface TodoItem {
  text: string;         // Full line text after the checkbox
  title: string;        // First sentence / before first " — " (used for board title)
  priority: number;     // 0-3 from P0-P3 section
  lineIndex: number;    // Line number in the file (0-based)
  checked: boolean;
}

export interface GoalPlannerResult {
  ok: boolean;
  created: number;
  skipped: number;
  synced: number;
  error?: string;
}

// ─── State ─────────────────────────────────────────────────────────────────

let watcher: FSWatcher | null = null;
let activeStore: QueueStore | null = null;
let cycleInProgress = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let activityUnsubscribe: (() => void) | null = null;

// ─── Parsing ───────────────────────────────────────────────────────────────

const SECTION_RE = /^##\s+P(\d)/;
const UNCHECKED_RE = /^- \[ \]\s+(.+)/;
const CHECKED_RE = /^- \[x\]\s+(.+)/i;

/** Extract a short title from a todo line (before " — " or first 120 chars). */
function extractTitle(text: string): string {
  let t = text.replace(/^\*\*/, "").replace(/\*\*\s*[-—]?\s*/, " — ");
  const dashIdx = t.indexOf(" — ");
  if (dashIdx > 10) t = t.slice(0, dashIdx);
  return t.slice(0, 120).trim();
}

/** Parse todos.md into structured items. */
export function parseTodos(content: string): TodoItem[] {
  const lines = content.split("\n");
  const items: TodoItem[] = [];
  let currentPriority = 3;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const sectionMatch = line.match(SECTION_RE);
    if (sectionMatch) {
      currentPriority = Math.min(parseInt(sectionMatch[1], 10), 3);
      continue;
    }

    const uncheckedMatch = line.match(UNCHECKED_RE);
    if (uncheckedMatch) {
      items.push({
        text: uncheckedMatch[1],
        title: extractTitle(uncheckedMatch[1]),
        priority: currentPriority,
        lineIndex: i,
        checked: false,
      });
      continue;
    }

    const checkedMatch = line.match(CHECKED_RE);
    if (checkedMatch) {
      items.push({
        text: checkedMatch[1],
        title: extractTitle(checkedMatch[1]),
        priority: currentPriority,
        lineIndex: i,
        checked: true,
      });
    }
  }

  return items;
}

// ─── Dedup ─────────────────────────────────────────────────────────────────

function dice(a: string, b: string): number {
  const al = a.toLowerCase(), bl = b.toLowerCase();
  if (al === bl) return 1;
  if (al.length < 2 || bl.length < 2) return 0;

  const bigrams = (s: string): Set<string> => {
    const set = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };

  const ba = bigrams(al), bb = bigrams(bl);
  let overlap = 0;
  for (const bg of ba) {
    if (bb.has(bg)) overlap++;
  }
  return ba.size + bb.size === 0 ? 0 : (2 * overlap) / (ba.size + bb.size);
}

// ─── Core cycle ────────────────────────────────────────────────────────────

async function runPlannerCycle(store: QueueStore): Promise<GoalPlannerResult> {
  let content: string;
  try {
    content = await readBrainFile(TODOS_PATH);
  } catch {
    return { ok: true, created: 0, skipped: 0, synced: 0 };
  }

  if (!content.trim()) {
    return { ok: true, created: 0, skipped: 0, synced: 0 };
  }

  const todos = parseTodos(content);
  const unchecked = todos.filter((t) => !t.checked);
  if (unchecked.length === 0) {
    return { ok: true, created: 0, skipped: 0, synced: 0 };
  }

  const boardItems = await store.list();
  const boardTitles = boardItems.map((t) => ({ id: t.id, title: t.title, state: t.state }));

  let created = 0;
  let skipped = 0;
  let synced = 0;
  const linesToCheck: number[] = [];

  for (const todo of unchecked) {
    let bestMatch: { id: string; title: string; state: string } | null = null;
    let bestScore = 0;
    for (const bt of boardTitles) {
      const score = dice(todo.title, bt.title);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = bt;
      }
    }

    if (bestScore >= DEDUP_THRESHOLD && bestMatch) {
      if (bestMatch.state === "done" || bestMatch.state === "cancelled") {
        linesToCheck.push(todo.lineIndex);
        synced++;
      } else {
        skipped++;
      }
      continue;
    }

    if (created >= MAX_PER_CYCLE) {
      skipped++;
      continue;
    }

    const state = todo.priority <= 1 ? "triage" : "backlog";
    try {
      const task = await store.create({
        title: todo.title,
        description: todo.text,
        state: state as any,
        priority: todo.priority,
        origin: "autonomous",
      });
      log.info(`Created ${task.identifier}: ${todo.title} [P${todo.priority} → ${state}]`);
      created++;
    } catch (err) {
      log.warn(`Failed to create board item: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Sync-back: check off completed todos
  if (linesToCheck.length > 0) {
    try {
      const freshContent = await readBrainFile(TODOS_PATH);
      const lines = freshContent.split("\n");
      let dirty = false;
      for (const idx of linesToCheck) {
        if (idx < lines.length && lines[idx].startsWith("- [ ]")) {
          lines[idx] = lines[idx].replace("- [ ]", "- [x]");
          dirty = true;
        }
      }
      if (dirty) {
        await writeBrainFile(TODOS_PATH, lines.join("\n"));
        log.info(`Checked off ${linesToCheck.length} completed todo(s) in todos.md`);
      }
    } catch (err) {
      log.warn(`Failed to sync todos.md: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (created > 0 || synced > 0) {
    logActivity({
      source: "goal-loop",
      summary: `Goal planner: created ${created} board item(s), synced ${synced} completion(s)`,
      actionLabel: "AUTONOMOUS",
      reason: synced > 0 ? "board completion synced to todos.md" : "todos.md change detected",
    });
  }

  return { ok: true, created, skipped, synced };
}

// ─── Guarded execution ─────────────────────────────────────────────────────

async function runCycleGuarded(): Promise<void> {
  if (cycleInProgress || !activeStore) return;
  cycleInProgress = true;
  try {
    await runPlannerCycle(activeStore);
  } catch (err) {
    log.error(`Goal planner cycle error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    cycleInProgress = false;
  }
}

/** Debounced trigger — coalesces rapid file change events into one cycle. */
function triggerDebounced(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    runCycleGuarded();
  }, DEBOUNCE_MS);
}

// ─── Event-driven lifecycle ────────────────────────────────────────────────

/**
 * Initialize the goal planner. Runs once at boot, then reacts to:
 *   - File changes on todos.md (fs.watch)
 *   - Board item completions (activity listener for "done"/"cancelled" state changes)
 */
export function startGoalPlanner(store: QueueStore): void {
  if (watcher) return; // idempotent
  activeStore = store;

  // 1. Boot seed — run once immediately
  runCycleGuarded();

  // 2. Watch todos.md for changes
  try {
    watcher = watch(TODOS_PATH, { persistent: false }, (eventType) => {
      if (eventType === "change") {
        log.debug("todos.md changed — triggering goal planner");
        triggerDebounced();
      }
    });
    watcher.on("error", () => {
      // File may not exist yet — that's fine
      log.debug("todos.md watcher error (file may not exist)");
    });
  } catch {
    log.debug("Could not watch todos.md (file may not exist)");
  }

  // 3. Listen for board completions — sync back to todos.md
  activityUnsubscribe = onActivity((entry) => {
    // React to board items moving to done/cancelled
    if (entry.source === "agent" && /\b(?:completed|done)\b/i.test(entry.summary)) {
      triggerDebounced();
    }
    // React to grooming state changes
    if (entry.source === "board" && /moved.*→\s*(?:done|cancelled)/i.test(entry.summary)) {
      triggerDebounced();
    }
  });

  log.info("Goal planner: watching todos.md + listening for board completions (no timers)");
}

/** Stop the goal planner. */
export function stopGoalPlanner(): void {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (activityUnsubscribe) {
    activityUnsubscribe();
    activityUnsubscribe = null;
  }
  activeStore = null;
}

/** Trigger an immediate cycle (for API/manual use). */
export async function triggerGoalPlanner(): Promise<GoalPlannerResult> {
  if (!activeStore) return { ok: false, created: 0, skipped: 0, synced: 0, error: "Store not initialized" };
  return runPlannerCycle(activeStore);
}
