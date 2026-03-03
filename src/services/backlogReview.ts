/**
 * Weekly backlog review — runs every Friday to audit backlog health.
 * Follows src/queue/timer.ts pattern: module-level state, idempotent start/stop.
 *
 * Reviews:
 * - Stale items (>30 days without update)
 * - Unspec'd items (vague descriptions, no acceptance criteria)
 * - Completed work still in non-done states
 * - Priority adjustments (urgent items languishing, low-priority items that aged in)
 *
 * DASH-59
 */

import { QueueStore } from "../queue/store.js";
import type { QueueTask } from "../queue/types.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("backlog-review");
import { logActivity } from "../activity/log.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const CHECK_INTERVAL_MS = 60 * 60 * 1000;     // check every hour
const STALE_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000;  // 30 days
const REVIEW_DAY = 5;                          // Friday (0=Sun, 5=Fri)

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BacklogReviewReport {
  reviewedAt: string;
  totalBacklogItems: number;
  staleItems: StaleItem[];
  unspecdItems: UnspecdItem[];
  completedNotMarked: CompletedNotMarked[];
  prioritySuggestions: PrioritySuggestion[];
}

export interface StaleItem {
  identifier: string;
  title: string;
  state: string;
  daysSinceUpdate: number;
}

export interface UnspecdItem {
  identifier: string;
  title: string;
  reason: string;
}

export interface CompletedNotMarked {
  identifier: string;
  title: string;
  state: string;
  evidence: string;
}

export interface PrioritySuggestion {
  identifier: string;
  title: string;
  currentPriority: number;
  suggestedPriority: number;
  reason: string;
}

// ─── State ────────────────────────────────────────────────────────────────────

let timer: ReturnType<typeof setInterval> | null = null;
let activeStore: QueueStore | null = null;
let lastReviewWeek: string | null = null;     // "2026-W09" format to avoid double-runs
let lastReport: BacklogReviewReport | null = null;

// ─── Review logic ─────────────────────────────────────────────────────────────

/** Priority labels for log output. */
const PRIORITY_LABELS: Record<number, string> = {
  0: "none",
  1: "urgent",
  2: "high",
  3: "medium",
  4: "low",
};

function priorityLabel(p: number): string {
  return PRIORITY_LABELS[p] ?? `${p}`;
}

/** Get ISO week string (e.g. "2026-W09") for deduplication. */
function getISOWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

/**
 * Find stale backlog/todo items — not updated in >30 days.
 */
function findStaleItems(tasks: QueueTask[], now: number): StaleItem[] {
  return tasks
    .filter((t) => {
      if (t.state !== "backlog" && t.state !== "todo" && t.state !== "triage") return false;
      const updated = new Date(t.updatedAt).getTime();
      return (now - updated) > STALE_THRESHOLD_MS;
    })
    .map((t) => ({
      identifier: t.identifier,
      title: t.title,
      state: t.state,
      daysSinceUpdate: Math.floor((now - new Date(t.updatedAt).getTime()) / (24 * 60 * 60 * 1000)),
    }))
    .sort((a, b) => b.daysSinceUpdate - a.daysSinceUpdate);
}

/**
 * Find items with vague or missing specs.
 * Criteria: short description (<80 chars), no file paths, no acceptance criteria keywords.
 */
function findUnspecdItems(tasks: QueueTask[]): UnspecdItem[] {
  return tasks
    .filter((t) => t.state === "backlog" || t.state === "todo" || t.state === "triage")
    .reduce<UnspecdItem[]>((acc, t) => {
      const desc = t.description || "";
      const reasons: string[] = [];

      if (desc.length === 0) {
        reasons.push("no description");
      } else if (desc.length < 80) {
        const hasFilePaths = /(?:src\/|brain\/|public\/|\.ts|\.js|\.md)/.test(desc);
        const hasAcceptanceCriteria = /(?:acceptance|criteria|deliverable|must|should|when|given|then)/i.test(desc);
        if (!hasFilePaths && !hasAcceptanceCriteria) {
          reasons.push("description too brief and lacks specs");
        }
      }

      if (reasons.length > 0) {
        acc.push({ identifier: t.identifier, title: t.title, reason: reasons.join("; ") });
      }
      return acc;
    }, []);
}

/**
 * Find items that appear completed but aren't marked done.
 * Checks exchanges for completion signals.
 */
function findCompletedNotMarked(tasks: QueueTask[]): CompletedNotMarked[] {
  const completionPatterns = [
    /(?:completed|finished|done|shipped|deployed|merged|landed)/i,
    /(?:PR merged|pull request merged)/i,
    /(?:✅|✔️)/,
  ];

  return tasks
    .filter((t) => t.state !== "done" && t.state !== "cancelled")
    .reduce<CompletedNotMarked[]>((acc, t) => {
      // Check recent exchanges for completion signals
      const recentExchanges = t.exchanges.slice(-5);
      for (const ex of recentExchanges) {
        for (const pattern of completionPatterns) {
          if (pattern.test(ex.body)) {
            acc.push({
              identifier: t.identifier,
              title: t.title,
              state: t.state,
              evidence: `Exchange by ${ex.author}: "${ex.body.slice(0, 80)}..."`,
            });
            return acc; // one match per task is enough
          }
        }
      }
      return acc;
    }, []);
}

/**
 * Suggest priority adjustments based on age and state.
 * - Urgent/high items in backlog for >14 days → suggest downgrade
 * - Old items (>60 days) with no priority → suggest low or cancel
 */
function suggestPriorityAdjustments(tasks: QueueTask[], now: number): PrioritySuggestion[] {
  const suggestions: PrioritySuggestion[] = [];
  const FOURTEEN_DAYS = 14 * 24 * 60 * 60 * 1000;
  const SIXTY_DAYS = 60 * 24 * 60 * 60 * 1000;

  for (const t of tasks) {
    if (t.state === "done" || t.state === "cancelled") continue;

    const age = now - new Date(t.createdAt).getTime();

    // Urgent/high items sitting in backlog for >14 days — probably not actually urgent
    if ((t.priority === 1 || t.priority === 2) && t.state === "backlog" && age > FOURTEEN_DAYS) {
      suggestions.push({
        identifier: t.identifier,
        title: t.title,
        currentPriority: t.priority,
        suggestedPriority: 3, // medium
        reason: `${priorityLabel(t.priority)} priority but sitting in backlog for ${Math.floor(age / (24 * 60 * 60 * 1000))} days`,
      });
    }

    // Very old items with no priority → suggest low priority to surface them
    if (t.priority === 0 && (t.state === "backlog" || t.state === "triage") && age > SIXTY_DAYS) {
      suggestions.push({
        identifier: t.identifier,
        title: t.title,
        currentPriority: 0,
        suggestedPriority: 4, // low
        reason: `no priority set, ${Math.floor(age / (24 * 60 * 60 * 1000))} days old — consider prioritizing or cancelling`,
      });
    }
  }

  return suggestions;
}

/**
 * Run the full weekly backlog review. Returns a structured report.
 */
export async function runBacklogReview(store: QueueStore): Promise<BacklogReviewReport> {
  const tasks = await store.list();
  const now = Date.now();

  const report: BacklogReviewReport = {
    reviewedAt: new Date().toISOString(),
    totalBacklogItems: tasks.filter((t) => t.state === "backlog").length,
    staleItems: findStaleItems(tasks, now),
    unspecdItems: findUnspecdItems(tasks),
    completedNotMarked: findCompletedNotMarked(tasks),
    prioritySuggestions: suggestPriorityAdjustments(tasks, now),
  };

  // Log summary
  const parts: string[] = [];
  parts.push(`${report.totalBacklogItems} backlog items reviewed`);

  if (report.staleItems.length > 0) {
    parts.push(`${report.staleItems.length} stale (${report.staleItems.map((i) => i.identifier).join(", ")})`);
  }
  if (report.unspecdItems.length > 0) {
    parts.push(`${report.unspecdItems.length} need specs (${report.unspecdItems.map((i) => i.identifier).join(", ")})`);
  }
  if (report.completedNotMarked.length > 0) {
    parts.push(`${report.completedNotMarked.length} may be done (${report.completedNotMarked.map((i) => i.identifier).join(", ")})`);
  }
  if (report.prioritySuggestions.length > 0) {
    parts.push(`${report.prioritySuggestions.length} priority suggestions`);
  }

  // Build detail text for the log
  const detailLines: string[] = [];
  if (report.staleItems.length > 0) {
    detailLines.push("Stale items:");
    for (const item of report.staleItems) {
      detailLines.push(`  ${item.identifier}: "${item.title}" — ${item.daysSinceUpdate} days since update (${item.state})`);
    }
  }
  if (report.unspecdItems.length > 0) {
    detailLines.push("Needs specs:");
    for (const item of report.unspecdItems) {
      detailLines.push(`  ${item.identifier}: "${item.title}" — ${item.reason}`);
    }
  }
  if (report.completedNotMarked.length > 0) {
    detailLines.push("Possibly completed:");
    for (const item of report.completedNotMarked) {
      detailLines.push(`  ${item.identifier}: "${item.title}" (still ${item.state}) — ${item.evidence}`);
    }
  }
  if (report.prioritySuggestions.length > 0) {
    detailLines.push("Priority suggestions:");
    for (const item of report.prioritySuggestions) {
      detailLines.push(`  ${item.identifier}: "${item.title}" — ${priorityLabel(item.currentPriority)} → ${priorityLabel(item.suggestedPriority)}: ${item.reason}`);
    }
  }

  logActivity({
    source: "board",
    summary: `Weekly backlog review: ${parts.join("; ")}`,
    detail: detailLines.length > 0 ? detailLines.join("\n") : undefined,
  });

  lastReport = report;
  return report;
}

// ─── Timer ────────────────────────────────────────────────────────────────────

/**
 * Hourly check: if it's Friday and we haven't reviewed this week, run the review.
 */
async function checkAndRun(): Promise<void> {
  if (!activeStore) return;

  const now = new Date();
  if (now.getDay() !== REVIEW_DAY) return;

  const currentWeek = getISOWeek(now);
  if (lastReviewWeek === currentWeek) return;

  // It's Friday and we haven't reviewed this week — run it
  lastReviewWeek = currentWeek;
  try {
    await runBacklogReview(activeStore);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logActivity({ source: "board", summary: `Backlog review error: ${msg}` });
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Start the weekly backlog review timer. Idempotent.
 * Checks hourly whether it's Friday; runs once per week.
 */
export function startBacklogReviewTimer(store: QueueStore, intervalMs?: number): void {
  if (timer) return;

  activeStore = store;
  const interval = intervalMs ?? CHECK_INTERVAL_MS;

  // Check immediately on start (catches Friday restarts)
  checkAndRun();

  timer = setInterval(checkAndRun, interval);
  log.info(`Backlog review: weekly on Fridays (checking every ${Math.round(interval / 60_000)} min)`);
}

/** Stop the backlog review timer. */
export function stopBacklogReviewTimer(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  activeStore = null;
}

/** Check if the backlog review timer is running. */
export function isBacklogReviewRunning(): boolean {
  return timer !== null;
}

/** Get the last review report, if any. */
export function getLastBacklogReview(): BacklogReviewReport | null {
  return lastReport;
}

/**
 * Force an immediate backlog review (e.g. from an API endpoint or chat command).
 * Ignores the Friday/weekly check.
 */
export async function triggerBacklogReview(): Promise<BacklogReviewReport | null> {
  if (!activeStore) return null;
  const report = await runBacklogReview(activeStore);
  lastReviewWeek = getISOWeek(new Date());
  return report;
}
