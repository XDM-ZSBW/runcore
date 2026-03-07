/**
 * Periodic local backlog grooming — finds vague items, stale tasks,
 * auto-promotes ready backlog items to todo, and nudges the user
 * when attention is needed.
 *
 * Extracted from the former sync timer; runs on a simple interval
 * with no external API dependencies.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { QueueStore } from "./store.js";
import type { QueueTask } from "./types.js";
import { logActivity } from "../activity/log.js";
import { pushNotification } from "../goals/notifications.js";
import { createLogger } from "../utils/logger.js";
import { onGroomingComplete } from "../services/training.js";
import { resolveEnv } from "../instance.js";
import { BRAIN_DIR } from "../lib/paths.js";

const log = createLogger("queue");

const DEFAULT_GROOM_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const COMPACT_THRESHOLD = 200;
/** Max backlog items to promote per grooming cycle (prevents flood). */
const MAX_PROMOTIONS_PER_CYCLE = 3;

const GROOM_STATE_FILE = join(
  BRAIN_DIR,
  "operations",
  ".grooming-last-nudge",
);

let timer: ReturnType<typeof setInterval> | null = null;
let activeStore: QueueStore | null = null;

// Dedup: only log/nudge when the set of findings changes
let lastLoggedFindings = "";
let lastNudgedItems = "";

function loadGroomState(): void {
  try {
    const raw = readFileSync(GROOM_STATE_FILE, "utf-8").trim();
    if (raw) {
      lastNudgedItems = raw;
      lastLoggedFindings = raw;
    }
  } catch { /* first run */ }
}

function persistGroomState(key: string): void {
  try {
    writeFileSync(GROOM_STATE_FILE, key, "utf-8");
  } catch { /* best-effort */ }
}

// ─── Readiness evaluation ──────────────────────────────────────────────────

/** Why a backlog item was considered ready for promotion. */
interface PromotionReason {
  task: QueueTask;
  reasons: string[];
}

/**
 * Check if a backlog item is ready to be promoted to todo.
 * Returns null if not ready, or the reasons it qualifies.
 *
 * Ready means:
 * - Has a clear, actionable description (file paths, action verbs, sufficient length)
 *   OR has been groomed via exchanges (comments/specs added)
 * - Not blocked on human decisions (no NEEDS_HUMAN markers)
 * - Not using ambiguous placeholder language
 */
function evaluateReadiness(task: QueueTask): PromotionReason | null {
  if (task.state !== "backlog") return null;

  const desc = task.description || "";
  const titleAndDesc = `${task.title} ${desc}`;
  const reasons: string[] = [];

  // Disqualifiers — these prevent promotion regardless of other signals
  const exchanges = task.exchanges ?? [];
  const blockedOnHuman = exchanges.some((ex) =>
    ex.body.includes("[NEEDS_HUMAN]") ||
    (ex.body.includes("Blocked") && ex.body.includes("needs human input"))
  );
  if (blockedOnHuman) return null;

  // Ambiguous language that signals the item isn't specced yet
  const ambiguousPatterns = /\b(?:TBD|TBC|figure out|decide later|maybe|somehow|not sure|need to discuss)\b/i;
  if (ambiguousPatterns.test(titleAndDesc)) return null;

  // Positive signals — accumulate reasons
  const hasFilePaths = /(?:src\/|brain\/|public\/|\.ts|\.js|\.md|\.json|\.yaml|\.yml)/.test(titleAndDesc);
  if (hasFilePaths) reasons.push("references specific files");

  const hasActionVerbs = /\b(?:implement|add|create|fix|update|remove|refactor|extract|replace|move|rename|wire|connect|integrate)\b/i.test(titleAndDesc);
  if (hasActionVerbs) reasons.push("has action verbs");

  const hasAcceptanceCriteria = /\b(?:acceptance|criteria|deliverable|must|should|when .+ then|endpoint|route|component|function|class|module)\b/i.test(desc);
  if (hasAcceptanceCriteria) reasons.push("has acceptance criteria");

  const hasExchanges = exchanges.length > 0;
  if (hasExchanges) reasons.push("has spec comments");

  const hasSubstantialDesc = desc.length >= 80;
  if (hasSubstantialDesc) reasons.push("detailed description");

  // Decision: need at least 2 positive signals to promote
  if (reasons.length >= 2) {
    return { task, reasons };
  }

  return null;
}

/**
 * Scan backlog items and promote ready ones to todo.
 * Returns the list of promoted tasks with reasons.
 */
async function promoteReadyBacklogItems(
  store: QueueStore,
  tasks: QueueTask[],
): Promise<PromotionReason[]> {
  const backlogItems = tasks.filter((t) => t.state === "backlog");
  const promoted: PromotionReason[] = [];

  for (const task of backlogItems) {
    if (promoted.length >= MAX_PROMOTIONS_PER_CYCLE) break;

    const result = evaluateReadiness(task);
    if (result) {
      await store.update(task.id, { state: "todo" });
      promoted.push(result);
      log.info(`Promoted ${task.identifier} → todo: ${result.reasons.join(", ")}`);
    }
  }

  return promoted;
}

/**
 * Periodic grooming check: find backlog items that lack specs or are stale.
 * Logs a notification so the human or Core chat can act on it.
 */
async function runGroomingCheck(store: QueueStore): Promise<void> {
  const tasks = await store.list();
  const now = Date.now();

  // Find backlog/todo items that are genuinely vague — no meaningful description.
  // Items with exchanges (comments/specs) are considered groomed even if the
  // original description is short, since specs often arrive as comments.
  const vagueItems = tasks.filter((t) => {
    if (t.state !== "backlog" && t.state !== "todo") return false;
    const desc = t.description || "";
    const hasExchanges = (t.exchanges?.length ?? 0) > 0;
    // If someone has commented/specced it, it's been groomed
    if (hasExchanges) return false;
    // Short description with no detail signals = vague
    const hasFilePaths = /(?:src\/|brain\/|public\/|\.ts|\.js|\.md)/.test(desc);
    const hasActionableDetail = /(?:acceptance|criteria|deliverable|must|should|implement|add|create|fix|update|remove|when|endpoint|route|component)/i.test(desc);
    return desc.length < 80 && !hasFilePaths && !hasActionableDetail;
  });

  // Find in_progress items that have been stale for > 24 hours
  const staleInProgress = tasks.filter((t) => {
    if (t.state !== "in_progress") return false;
    const updated = new Date(t.updatedAt).getTime();
    return (now - updated) > 24 * 60 * 60 * 1000;
  });

  // Find items with stale assignees (assigned but not updated in > 2 hours — agent likely crashed)
  const staleAssigned = tasks.filter((t) => {
    if (!t.assignee || t.state === "done" || t.state === "cancelled") return false;
    const updated = new Date(t.updatedAt).getTime();
    return (now - updated) > 2 * 60 * 60 * 1000;
  });

  // Clear stale assignees so tasks can be re-picked
  for (const task of staleAssigned) {
    await store.update(task.id, { assignee: null });
  }

  // Auto-promote ready backlog items → todo
  const promoted = await promoteReadyBacklogItems(store, tasks);

  // Find items with pending human questions (agent left [NEEDS_HUMAN] blocks)
  const needsHumanInput: string[] = [];
  for (const task of tasks) {
    if (task.state === "done" || task.state === "cancelled") continue;
    const exchanges = task.exchanges ?? [];
    const hasQuestion = exchanges.some((ex) =>
      ex.body.includes("Blocked") && ex.body.includes("needs human input")
    );
    if (hasQuestion) needsHumanInput.push(task.identifier);
  }

  // Cap identifier lists at 10 to keep log messages readable
  const cap = (ids: string[], max = 10) =>
    ids.length <= max ? ids.join(", ") : `${ids.slice(0, max).join(", ")} +${ids.length - max} more`;

  const parts: string[] = [];
  if (needsHumanInput.length > 0) {
    parts.push(`${needsHumanInput.length} items blocked on human input (${cap(needsHumanInput)})`);
  }
  if (vagueItems.length > 0) {
    parts.push(`${vagueItems.length} backlog items need specs (${cap(vagueItems.map((t) => t.identifier))})`);
  }
  if (staleInProgress.length > 0) {
    parts.push(`${staleInProgress.length} items stale in In Progress (${cap(staleInProgress.map((t) => t.identifier))})`);
  }
  if (staleAssigned.length > 0) {
    parts.push(`cleared ${staleAssigned.length} stale assignees (${cap(staleAssigned.map((t) => t.identifier))})`);
  }
  if (promoted.length > 0) {
    const promotedSummary = promoted.map((p) => `${p.task.identifier} (${p.reasons.join(", ")})`);
    parts.push(`promoted ${promoted.length} backlog → todo: ${cap(promotedSummary)}`);
  }

  // Only log when findings change — prevents the insight engine from
  // seeing the same grooming entry every 5 minutes and escalating it
  const findingsKey = parts.sort().join("|");
  if (parts.length > 0 && findingsKey !== lastLoggedFindings) {
    lastLoggedFindings = findingsKey;
    logActivity({
      source: "board",
      summary: `Grooming: ${parts.join("; ")}`,
    });
  }

  // Auto-compact if JSONL has too many lines (prevents bloat from append-only writes)
  try {
    const lines = await store.lineCount();
    if (lines > COMPACT_THRESHOLD) {
      const { before, after } = await store.compact();
      logActivity({ source: "board", summary: `Queue compacted: ${lines} lines → ${after} lines` });
    }
  } catch {
    // Compaction failure is non-critical
  }

  // Notify when items are promoted — the autonomous planner can now pick them up
  if (promoted.length > 0) {
    const names = promoted.map((p) => `${p.task.identifier}: ${p.task.title}`).join(", ");
    pushNotification({
      timestamp: new Date().toISOString(),
      source: "board",
      message: `Auto-promoted ${promoted.length} backlog item(s) to todo: ${names}`,
    });
  }

  // Nudge the user in chat if there are items needing grooming
  const nudgeIds = [...needsHumanInput, ...vagueItems.map((t) => t.identifier)];
  const nudgeKey = nudgeIds.sort().join(",");
  if (nudgeIds.length > 0 && nudgeKey !== lastNudgedItems) {
    lastNudgedItems = nudgeKey;
    persistGroomState(nudgeKey);

    const lines: string[] = [];
    if (needsHumanInput.length > 0)
      lines.push(`${needsHumanInput.length} blocked on your input: ${cap(needsHumanInput)}`);
    if (vagueItems.length > 0)
      lines.push(`${vagueItems.length} need specs before I can work on them: ${cap(vagueItems.map((t) => t.identifier))}`);

    pushNotification({
      timestamp: new Date().toISOString(),
      source: "board",
      message: `Backlog grooming needed:\n${lines.join("\n")}\nWant to groom these together?`,
    });
  }

  // Training: observe board craft after grooming (fire-and-forget)
  onGroomingComplete(tasks).catch(() => {});
}

/**
 * Start the periodic grooming timer. Idempotent — calling twice is a no-op.
 */
export function startGroomingTimer(
  store: QueueStore,
  intervalMs: number = DEFAULT_GROOM_INTERVAL_MS,
): void {
  if (timer) return;
  activeStore = store;
  loadGroomState();

  // Run first check after a short delay, then on interval
  setTimeout(async () => {
    try {
      await runGroomingCheck(store);
    } catch (err) {
      log.warn(`Grooming check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, 10_000);

  timer = setInterval(async () => {
    if (!activeStore) return;
    try {
      await runGroomingCheck(activeStore);
    } catch (err) {
      log.warn(`Grooming check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, intervalMs);

  log.info(`Grooming timer started: every ${Math.round(intervalMs / 60_000)} min`);
}

/** Stop the grooming timer. */
export function stopGroomingTimer(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  activeStore = null;
}
