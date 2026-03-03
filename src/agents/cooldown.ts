/**
 * Task Cooldown Manager — prevents repeatedly-failing tasks from being
 * retried too aggressively, reducing GC pressure from excessive agent spawns.
 *
 * Tracks failure counts per board task ID with exponential backoff cooldowns.
 * Persists state to disk so cooldowns survive process restarts.
 *
 * Usage:
 *   const cooldown = TaskCooldownManager.getInstance();
 *   await cooldown.init();
 *   cooldown.recordFailure("task-123", "Build feature X", "TypeError: ...");
 *   if (cooldown.isOnCooldown("task-123")) { skip task }
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { createLogger } from "../utils/logger.js";
import { logActivity } from "../activity/log.js";
import { recordCooldownActivation, recordCooldownSkip } from "../metrics/firewall-metrics.js";

const log = createLogger("cooldown");

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CooldownConfig {
  /** Base cooldown period in ms. Default: 30 min. */
  baseCooldownMs: number;
  /** Maximum cooldown period in ms. Default: 4 hours. */
  maxCooldownMs: number;
  /** Backoff multiplier (base × multiplier^(failures-1)). Default: 2. */
  backoffMultiplier: number;
  /** Path to persist cooldown state. Default: brain/agents/cooldowns.json. */
  persistPath: string;
  /** Max entries to retain (prune oldest when exceeded). Default: 200. */
  maxEntries: number;
  /**
   * Hard failure cap — after this many total failures (across all cooldown
   * cycles), permanently block the task. Only manual clearCooldown() resets.
   * Default: 6 (covers ~2 full cooldown escalation cycles: 1+2+3 = 6).
   */
  maxTotalFailures: number;
}

const DEFAULT_CONFIG: CooldownConfig = {
  baseCooldownMs: 30 * 60 * 1000,       // 30 min
  maxCooldownMs: 4 * 60 * 60 * 1000,    // 4 hours
  backoffMultiplier: 2,
  persistPath: join(process.cwd(), "brain", "agents", "cooldowns.json"),
  maxEntries: 200,
  maxTotalFailures: 6,
};

export interface CooldownEntry {
  taskId: string;
  lastFailedAt: string;       // ISO timestamp
  failureCount: number;
  lastError?: string;
  label?: string;
}

export interface CooldownStatus {
  taskId: string;
  label?: string;
  failureCount: number;
  cooldownMs: number;
  remainingMs: number;
  expiresAt: string;
  lastFailedAt: string;
  lastError?: string;
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let instance: TaskCooldownManager | null = null;

// ─── Manager ────────────────────────────────────────────────────────────────

export class TaskCooldownManager {
  readonly config: CooldownConfig;
  private entries = new Map<string, CooldownEntry>();
  private dirty = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config?: Partial<CooldownConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Get or create the singleton instance. */
  static getInstance(config?: Partial<CooldownConfig>): TaskCooldownManager {
    if (!instance) {
      instance = new TaskCooldownManager(config);
    }
    return instance;
  }

  /** Reset singleton (for testing). */
  static resetInstance(): void {
    if (instance) {
      instance.shutdown();
      instance = null;
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /** Load persisted cooldown state from disk. */
  async init(): Promise<void> {
    try {
      const raw = await readFile(this.config.persistPath, "utf-8");
      const data = JSON.parse(raw) as CooldownEntry[];
      for (const entry of data) {
        this.entries.set(entry.taskId, entry);
      }
      // Prune expired entries on load
      this.pruneExpired();
      log.info(`Loaded ${this.entries.size} cooldown entries from disk`);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        log.info("No cooldown state on disk, starting fresh");
      } else {
        log.warn(`Failed to load cooldown state: ${(err as Error).message}`);
      }
    }
  }

  /** Flush pending changes and stop the persist timer. */
  shutdown(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (this.dirty) {
      this.persistSync();
    }
  }

  // ── Core API ──────────────────────────────────────────────────────────────

  /**
   * Record a task failure. Increments the failure count and resets the
   * cooldown timer. Schedules a debounced persist to disk.
   */
  recordFailure(taskId: string, label?: string, error?: string): void {
    const existing = this.entries.get(taskId);

    // DASH-143: Dedup burst — if the same task was recorded within 30s,
    // skip to prevent double-counting from multiple recording paths
    // (immediate failure handler + batch completion handler).
    if (existing) {
      const sinceLast = Date.now() - new Date(existing.lastFailedAt).getTime();
      if (sinceLast < 30_000) {
        log.debug(`Skipping duplicate failure record for ${taskId} (${sinceLast}ms since last)`);
        return;
      }
    }

    const failureCount = (existing?.failureCount ?? 0) + 1;
    const entry: CooldownEntry = {
      taskId,
      lastFailedAt: new Date().toISOString(),
      failureCount,
      lastError: error?.slice(0, 300),
      label: label ?? existing?.label,
    };

    this.entries.set(taskId, entry);
    this.dirty = true;
    this.schedulePersist();
    recordCooldownActivation();

    // Check if task is now permanently blocked
    if (failureCount >= this.config.maxTotalFailures) {
      log.warn(`Task ${taskId} BLOCKED after ${failureCount} failures — needs manual clearCooldown()`, {
        taskId,
        failureCount,
        label,
      });

      logActivity({
        source: "agent",
        summary: `BLOCKED: ${label ?? taskId} permanently blocked after ${failureCount} failures — needs human intervention`,
        detail: error?.slice(0, 200),
        actionLabel: "AUTONOMOUS",
        reason: "task permanently blocked (DASH-143 hard cap)",
      });
    } else {
      const cooldownMs = this.calculateCooldown(failureCount);
      const cooldownMin = Math.round(cooldownMs / 60_000);

      log.info(`Task ${taskId} failed ${failureCount} time(s), cooldown ${cooldownMin}min`, {
        taskId,
        failureCount,
        cooldownMin,
        label,
      });

      logActivity({
        source: "agent",
        summary: `Cooldown: ${label ?? taskId} failed ${failureCount}x, backing off ${cooldownMin}min`,
        detail: error?.slice(0, 200),
        actionLabel: "AUTONOMOUS",
        reason: "task cooldown escalation",
      });
    }
  }

  /**
   * Check if a task is currently on cooldown (or permanently blocked).
   *
   * DASH-143 fix: cooldown expiration no longer deletes the entry. Failure
   * history is preserved so the hard cap (maxTotalFailures) works across
   * cooldown cycles. Only clearCooldown() resets failure history.
   */
  isOnCooldown(taskId: string): boolean {
    const entry = this.entries.get(taskId);
    if (!entry) return false;

    // Hard cap: permanently blocked until manual clearCooldown()
    if (entry.failureCount >= this.config.maxTotalFailures) return true;

    const cooldownMs = this.calculateCooldown(entry.failureCount);
    const elapsed = Date.now() - new Date(entry.lastFailedAt).getTime();

    // Cooldown expired — task is retryable, but keep the entry so
    // failureCount accumulates across cycles (DASH-143)
    if (elapsed >= cooldownMs) return false;

    return true;
  }

  /**
   * Check if a task has been permanently blocked (exceeded maxTotalFailures).
   * These tasks will never be retried until manually cleared.
   */
  isBlocked(taskId: string): boolean {
    const entry = this.entries.get(taskId);
    return entry != null && entry.failureCount >= this.config.maxTotalFailures;
  }

  /**
   * Check cooldown and log a skip message if the task is on cooldown.
   * Returns true if the task should be skipped.
   */
  shouldSkip(taskId: string): boolean {
    if (!this.isOnCooldown(taskId)) return false;
    recordCooldownSkip();

    if (this.isBlocked(taskId)) {
      const entry = this.entries.get(taskId);
      log.info(`Skipping task ${taskId} — permanently blocked after ${entry?.failureCount} failures (needs manual clear)`, {
        taskId,
        failureCount: entry?.failureCount,
        label: entry?.label,
      });
    } else {
      const status = this.getStatus(taskId);
      if (status) {
        const remainMin = Math.round(status.remainingMs / 60_000);
        log.info(`Skipping task ${taskId} — on cooldown for ${remainMin} more min (${status.failureCount} failures)`, {
          taskId,
          remainingMin: remainMin,
          failureCount: status.failureCount,
          label: status.label,
        });
      }
    }
    return true;
  }

  /** Get detailed status for a single task's cooldown. */
  getStatus(taskId: string): CooldownStatus | null {
    const entry = this.entries.get(taskId);
    if (!entry) return null;

    // Blocked tasks: report as permanently on cooldown
    if (entry.failureCount >= this.config.maxTotalFailures) {
      return {
        taskId,
        label: entry.label,
        failureCount: entry.failureCount,
        cooldownMs: Infinity,
        remainingMs: Infinity,
        expiresAt: "blocked",
        lastFailedAt: entry.lastFailedAt,
        lastError: entry.lastError,
      };
    }

    const cooldownMs = this.calculateCooldown(entry.failureCount);
    const elapsed = Date.now() - new Date(entry.lastFailedAt).getTime();
    const remainingMs = Math.max(0, cooldownMs - elapsed);

    if (remainingMs === 0) return null;

    return {
      taskId,
      label: entry.label,
      failureCount: entry.failureCount,
      cooldownMs,
      remainingMs,
      expiresAt: new Date(new Date(entry.lastFailedAt).getTime() + cooldownMs).toISOString(),
      lastFailedAt: entry.lastFailedAt,
      lastError: entry.lastError,
    };
  }

  /** Clear cooldown for a specific task (e.g., after manual intervention). */
  clearCooldown(taskId: string): void {
    if (this.entries.delete(taskId)) {
      this.dirty = true;
      this.schedulePersist();
      log.info(`Cooldown cleared for task ${taskId}`);
    }
  }

  /** Clear all cooldowns. */
  clearAll(): void {
    if (this.entries.size > 0) {
      this.entries.clear();
      this.dirty = true;
      this.schedulePersist();
      log.info("All cooldowns cleared");
    }
  }

  /**
   * Remove expired cooldown entries that are safe to prune.
   * Entries at or above the hard failure cap are NEVER pruned — they
   * represent permanently blocked tasks that need manual clearCooldown().
   * Entries with failure history but expired cooldowns are pruned after
   * 24 hours of inactivity (enough time that if the task succeeds on
   * the next retry, the entry is no longer needed).
   */
  pruneExpired(): number {
    const now = Date.now();
    const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours
    let pruned = 0;

    for (const [taskId, entry] of this.entries) {
      // Never prune permanently blocked entries
      if (entry.failureCount >= this.config.maxTotalFailures) continue;

      const cooldownMs = this.calculateCooldown(entry.failureCount);
      const elapsed = now - new Date(entry.lastFailedAt).getTime();
      // Only prune if cooldown expired AND entry is stale (24h inactive)
      if (elapsed >= cooldownMs + STALE_THRESHOLD_MS) {
        this.entries.delete(taskId);
        pruned++;
      }
    }

    if (pruned > 0) {
      this.dirty = true;
      this.schedulePersist();
      log.info(`Pruned ${pruned} stale cooldown entries`);
    }

    return pruned;
  }

  /** List all active cooldowns and blocked tasks with status details. */
  listActiveCooldowns(): CooldownStatus[] {
    this.pruneExpired();
    const results: CooldownStatus[] = [];

    for (const [taskId] of this.entries) {
      const status = this.getStatus(taskId);
      if (status) results.push(status);
    }

    // Blocked tasks (Infinity) sort last, then by remaining time
    results.sort((a, b) => {
      if (a.remainingMs === Infinity && b.remainingMs === Infinity) return 0;
      if (a.remainingMs === Infinity) return 1;
      if (b.remainingMs === Infinity) return -1;
      return a.remainingMs - b.remainingMs;
    });
    return results;
  }

  /** Get summary for planner context (what tasks are on cooldown or blocked). */
  getCooldownContext(): string | null {
    const active = this.listActiveCooldowns();
    if (active.length === 0) return null;

    const lines = active.map((s) => {
      if (s.expiresAt === "blocked") {
        return `- ${s.label ?? s.taskId}: BLOCKED (${s.failureCount} failures, needs human intervention)`;
      }
      const remainMin = Math.round(s.remainingMs / 60_000);
      return `- ${s.label ?? s.taskId}: failed ${s.failureCount}x, ${remainMin}min remaining`;
    });

    return lines.join("\n");
  }

  /** Get the failure count for a task (0 if not tracked). */
  getFailureCount(taskId: string): number {
    return this.entries.get(taskId)?.failureCount ?? 0;
  }

  /** Get total number of tracked entries (active + expired pending prune). */
  get size(): number {
    return this.entries.size;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * Calculate exponential backoff cooldown.
   * Formula: base × multiplier^(failureCount - 1), capped at max.
   *
   *   Failures → Cooldown (with defaults):
   *     1 → 30min
   *     2 → 60min
   *     3 → 120min
   *     4 → 240min (capped at 4hr)
   *     5+ → 240min (capped at 4hr)
   */
  calculateCooldown(failureCount: number): number {
    const { baseCooldownMs, maxCooldownMs, backoffMultiplier } = this.config;
    return Math.min(
      baseCooldownMs * Math.pow(backoffMultiplier, Math.max(0, failureCount - 1)),
      maxCooldownMs,
    );
  }

  /** Debounced persist — waits 5s after last change before writing to disk. */
  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistAsync().catch((err) => {
        log.warn(`Failed to persist cooldowns: ${(err as Error).message}`);
      });
    }, 5_000);
  }

  private async persistAsync(): Promise<void> {
    if (!this.dirty) return;

    // Prune before persisting
    this.pruneExpired();

    // Enforce max entries: keep the most recent
    if (this.entries.size > this.config.maxEntries) {
      const sorted = [...this.entries.entries()]
        .sort((a, b) => new Date(b[1].lastFailedAt).getTime() - new Date(a[1].lastFailedAt).getTime());
      this.entries = new Map(sorted.slice(0, this.config.maxEntries));
    }

    const data = [...this.entries.values()];
    try {
      await mkdir(dirname(this.config.persistPath), { recursive: true });
      await writeFile(this.config.persistPath, JSON.stringify(data, null, 2), "utf-8");
      this.dirty = false;
      log.debug(`Persisted ${data.length} cooldown entries to disk`);
    } catch (err) {
      log.warn(`Failed to write cooldown file: ${(err as Error).message}`);
    }
  }

  /** Synchronous persist for shutdown path (best-effort). */
  private persistSync(): void {
    try {
      const { writeFileSync, mkdirSync } = require("node:fs");
      const data = [...this.entries.values()];
      mkdirSync(dirname(this.config.persistPath), { recursive: true });
      writeFileSync(this.config.persistPath, JSON.stringify(data, null, 2), "utf-8");
      this.dirty = false;
    } catch {
      // Best effort on shutdown
    }
  }
}
