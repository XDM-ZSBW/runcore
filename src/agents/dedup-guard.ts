/**
 * Dedup Guard — prevents the autonomous planner from spawning agents
 * that duplicate work already in progress or recently completed.
 *
 * Three checks, cheapest first:
 *   1. Active agent with same label (~0ms, in-memory)
 *   2. Recent task with same label (~5ms, reads task JSON files)
 *   3. Recent git commits touching related files (~50ms, shell out to git)
 */

import { activeProcesses } from "./spawn.js";
import { listTasks } from "./store.js";
import { createLogger } from "../utils/logger.js";
import { gitAvailable } from "../utils/git.js";

const log = createLogger("dedup-guard");

// ─── Constants ──────────────────────────────────────────────────────────────

const DEDUP_RECENT_WINDOW_MS = 2 * 60 * 60 * 1000;  // 2 hours
/** Shorter window for failed tasks — blocks immediate re-planning while
 *  cooldown manager handles longer-term backoff (DASH-143). */
const DEDUP_FAILED_WINDOW_MS = 5 * 60 * 1000;  // 5 minutes
const GIT_LOOKBACK_MINUTES = 30;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DedupResult {
  blocked: boolean;
  reason?: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Normalize a label for fuzzy matching: lowercase, trim whitespace. */
function normalize(label: string): string {
  return label.toLowerCase().trim();
}

/** Fuzzy match: either label contains the other (after normalization). */
function fuzzyMatch(a: string, b: string): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  return na.includes(nb) || nb.includes(na);
}

/** Extract file paths from a prompt string. */
function extractFilePaths(prompt: string): string[] {
  const regex = /(?:src\/|brain\/|public\/)[^\s"'`,)}\]]+(?:\.ts|\.js|\.md|\.json|\.yaml|\.yml)?/g;
  const matches = prompt.match(regex) ?? [];
  // Deduplicate
  return [...new Set(matches)];
}

// ─── Main ───────────────────────────────────────────────────────────────────

export async function checkDedup(label: string, prompt: string): Promise<DedupResult> {
  // Check 1: Active agent with same label (~0ms)
  for (const [, proc] of activeProcesses) {
    // activeProcesses is Map<taskId, ChildProcess> — we need labels from tasks
    // Skip this map-based check; we'll rely on the task list check below
    void proc;
  }
  // Better: check running tasks via store (covers both pool and direct spawns)
  try {
    const tasks = await listTasks();
    for (const t of tasks) {
      if (t.status === "running" && fuzzyMatch(t.label, label)) {
        return {
          blocked: true,
          reason: `Active agent already running: "${t.label}"`,
        };
      }
    }
  } catch (err) {
    log.debug(`Check 1 (active agents) failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Check 2: Recent task with same label (~5ms)
  try {
    const tasks = await listTasks();
    const cutoff = Date.now() - DEDUP_RECENT_WINDOW_MS;
    const failedCutoff = Date.now() - DEDUP_FAILED_WINDOW_MS;
    for (const t of tasks) {
      const ts = t.finishedAt || t.createdAt;
      if (!ts) continue;
      const taskTime = new Date(ts).getTime();

      if (t.status === "running" || t.status === "completed") {
        if (taskTime < cutoff) continue;
        if (fuzzyMatch(t.label, label)) {
          return {
            blocked: true,
            reason: `Recent task (${t.status}) with same label: "${t.label}"`,
          };
        }
      } else if (t.status === "failed") {
        // DASH-143: Block re-spawning recently-failed tasks — prevents
        // rapid retry loops before cooldown manager kicks in.
        if (taskTime < failedCutoff) continue;
        if (fuzzyMatch(t.label, label)) {
          return {
            blocked: true,
            reason: `Recently failed task (cooldown active): "${t.label}"`,
          };
        }
      }
    }
  } catch (err) {
    log.debug(`Check 2 (recent tasks) failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Check 3: Recent agent git commits touching related files (~50ms)
  // Only blocks on commits made by autonomous agents (contains "Auto-committed"
  // in the git log). Human/manual commits should not prevent agents from working.
  // Git is an optional signal source — skip silently if unavailable.
  if (gitAvailable()) try {
    const { execSync } = await import("node:child_process");
    const paths = extractFilePaths(prompt);
    if (paths.length > 0) {
      const pathArgs = paths.map((p) => `"${p}"`).join(" ");
      const cmd = `git log --oneline --since="${GIT_LOOKBACK_MINUTES} minutes ago" --grep="Auto-committed" -- ${pathArgs}`;
      const result = execSync(cmd, {
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();

      if (result.length > 0) {
        const commitCount = result.split("\n").length;
        const firstCommit = result.split("\n")[0];
        return {
          blocked: true,
          reason: `${commitCount} recent agent commit(s) touching related files: ${firstCommit}`,
        };
      }
    }
  } catch {
    // Git command failed — fail open (don't block)
    log.debug("Check 3 (git commits) failed or no git — skipping");
  }

  return { blocked: false };
}
