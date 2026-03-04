/**
 * Agent Heartbeat Monitor — CORE-9
 *
 * Action-based heartbeat: every agent action IS the ping.
 * No polling, no timer-based pings. The append-only log is the tracking.
 *
 * Monitors:
 * 1. **Silence detection** — agent produces no output for too long → terminate
 * 2. **Drift detection** — agent's actions diverge from the assigned task → warn/terminate
 * 3. **Heartbeat logging** — append-only JSONL trail of agent pulses
 *
 * Designed to work with the existing activity log system. Each agent gets
 * a HeartbeatTracker that watches for signs of life and task adherence.
 */

import { join, resolve } from "node:path";
import { statSync } from "node:fs";
import { createLogger } from "../utils/logger.js";
import { logActivity, generateTraceId } from "../activity/log.js";
import {
  appendBrainLineSync,
  ensureBrainFileSync,
} from "../lib/brain-io.js";

const log = createLogger("heartbeat");

const OPS_DIR = resolve(process.cwd(), "brain", "ops");
const HEARTBEAT_FILE = join(OPS_DIR, "heartbeats.jsonl");
const SCHEMA_LINE = JSON.stringify({ _schema: "heartbeat", _version: "1.0" });

// Ensure the file exists on module load
try {
  ensureBrainFileSync(HEARTBEAT_FILE, SCHEMA_LINE);
} catch {
  // Non-fatal — will retry on first write
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single heartbeat pulse from an agent. */
export interface HeartbeatPulse {
  timestamp: string;
  taskId: string;
  instanceId: string;
  type: "spawn" | "action" | "output" | "checkpoint" | "complete" | "terminate" | "silence-warning";
  detail?: string;
  /** Semantic summary of what the agent is doing (for drift detection). */
  actionSummary?: string;
}

/** Configuration for a heartbeat tracker. */
export interface HeartbeatConfig {
  /** Max silence before warning (ms). Default: 120_000 (2 min). */
  silenceWarningMs: number;
  /** Max silence before termination (ms). Default: 300_000 (5 min). */
  silenceTerminateMs: number;
  /** Check interval (ms). Default: 15_000 (15s). */
  checkIntervalMs: number;
  /** Task description for drift detection. */
  taskDescription: string;
  /** Keywords from the task for simple drift heuristic. */
  taskKeywords: string[];
  /** Max consecutive drift warnings before termination. Default: 3. */
  maxDriftWarnings: number;
}

/** Status of a tracked agent's heartbeat. */
export interface HeartbeatStatus {
  taskId: string;
  instanceId: string;
  alive: boolean;
  lastPulseAt: string | null;
  silenceMs: number;
  driftWarnings: number;
  totalPulses: number;
  state: "healthy" | "warning" | "critical" | "terminated";
}

/** Callback when an agent needs to be terminated. */
export type TerminateCallback = (
  instanceId: string,
  reason: string,
) => Promise<void>;

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: HeartbeatConfig = {
  silenceWarningMs: 120_000,     // 2 minutes
  silenceTerminateMs: 300_000,   // 5 minutes
  checkIntervalMs: 15_000,       // 15 seconds
  taskDescription: "",
  taskKeywords: [],
  maxDriftWarnings: 3,
};

// ---------------------------------------------------------------------------
// Heartbeat persistence
// ---------------------------------------------------------------------------

function persistPulse(pulse: HeartbeatPulse): void {
  try {
    ensureBrainFileSync(HEARTBEAT_FILE, SCHEMA_LINE);
    appendBrainLineSync(HEARTBEAT_FILE, JSON.stringify(pulse));
  } catch (err) {
    log.warn("Failed to persist heartbeat pulse", {
      taskId: pulse.taskId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Keyword extraction for drift detection
// ---------------------------------------------------------------------------

/** Extract meaningful keywords from a task description. */
export function extractTaskKeywords(description: string): string[] {
  // Remove common stop words and short words, keep meaningful terms
  const stopWords = new Set([
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
    "of", "with", "by", "from", "is", "are", "was", "were", "be", "been",
    "being", "have", "has", "had", "do", "does", "did", "will", "would",
    "could", "should", "may", "might", "shall", "can", "this", "that",
    "these", "those", "it", "its", "not", "no", "all", "any", "each",
    "every", "if", "then", "else", "when", "where", "how", "what", "which",
    "who", "whom", "why", "so", "as", "up", "out", "about", "into", "over",
    "after", "before", "between", "under", "above", "below", "just", "also",
    "very", "too", "only", "own", "same", "than", "other", "such", "more",
    "most", "some", "make", "use", "get", "set", "add", "run", "file",
  ]);

  return description
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w))
    .slice(0, 20); // Cap at 20 keywords
}

// ---------------------------------------------------------------------------
// Simple drift heuristic
// ---------------------------------------------------------------------------

/**
 * Score how relevant an action summary is to the original task.
 * Returns 0.0 (no overlap) to 1.0 (perfect overlap).
 * Uses simple keyword overlap — not semantic, but fast and transparent.
 */
function driftScore(actionSummary: string, taskKeywords: string[]): number {
  if (taskKeywords.length === 0) return 1.0; // No keywords = no drift detection
  const actionWords = new Set(
    actionSummary
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
  let matches = 0;
  for (const kw of taskKeywords) {
    if (actionWords.has(kw)) matches++;
  }
  return matches / taskKeywords.length;
}

// ---------------------------------------------------------------------------
// HeartbeatTracker — per-agent instance
// ---------------------------------------------------------------------------

export class HeartbeatTracker {
  readonly taskId: string;
  readonly instanceId: string;
  private config: HeartbeatConfig;
  private onTerminate: TerminateCallback;

  private lastPulseAt: number;
  private driftWarnings = 0;
  private totalPulses = 0;
  private checkTimer: ReturnType<typeof setInterval> | null = null;
  private terminated = false;
  private traceId: string;

  constructor(
    taskId: string,
    instanceId: string,
    config: Partial<HeartbeatConfig>,
    onTerminate: TerminateCallback,
  ) {
    this.taskId = taskId;
    this.instanceId = instanceId;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.onTerminate = onTerminate;
    this.lastPulseAt = Date.now();
    this.traceId = generateTraceId();

    // If task description provided but no keywords, extract them
    if (this.config.taskDescription && this.config.taskKeywords.length === 0) {
      this.config.taskKeywords = extractTaskKeywords(this.config.taskDescription);
    }
  }

  /** Start monitoring the agent's heartbeat. */
  start(): void {
    if (this.checkTimer) return;

    this.recordPulse("spawn", "Agent spawned, heartbeat tracking started");

    this.checkTimer = setInterval(() => {
      this.check();
    }, this.config.checkIntervalMs);

    log.info("Heartbeat tracking started", {
      taskId: this.taskId,
      instanceId: this.instanceId,
      keywords: this.config.taskKeywords.slice(0, 5),
    });
  }

  /** Stop monitoring (call on agent completion). */
  stop(reason: "complete" | "terminate" = "complete"): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
    this.recordPulse(reason, `Heartbeat tracking stopped: ${reason}`);
    log.info("Heartbeat tracking stopped", {
      taskId: this.taskId,
      instanceId: this.instanceId,
      reason,
      totalPulses: this.totalPulses,
      driftWarnings: this.driftWarnings,
    });
  }

  /**
   * Record a heartbeat pulse. Call this whenever the agent produces
   * observable output (file write, stdout, checkpoint).
   */
  recordPulse(
    type: HeartbeatPulse["type"],
    detail?: string,
    actionSummary?: string,
  ): void {
    if (this.terminated) return;

    this.lastPulseAt = Date.now();
    this.totalPulses++;

    const pulse: HeartbeatPulse = {
      timestamp: new Date().toISOString(),
      taskId: this.taskId,
      instanceId: this.instanceId,
      type,
      detail,
      actionSummary,
    };

    persistPulse(pulse);

    // Drift detection on action pulses
    if (type === "action" && actionSummary && this.config.taskKeywords.length > 0) {
      const score = driftScore(actionSummary, this.config.taskKeywords);
      if (score < 0.1) {
        this.driftWarnings++;
        log.warn("Drift detected", {
          taskId: this.taskId,
          instanceId: this.instanceId,
          score,
          actionSummary: actionSummary.slice(0, 100),
          driftWarnings: this.driftWarnings,
          maxDriftWarnings: this.config.maxDriftWarnings,
        });

        logActivity({
          source: "agent",
          summary: `Drift warning (${this.driftWarnings}/${this.config.maxDriftWarnings}): ${this.taskId}`,
          detail: `Score: ${score.toFixed(2)}, action: ${actionSummary.slice(0, 200)}`,
          traceId: this.traceId,
          actionLabel: "AUTONOMOUS",
          reason: "heartbeat-drift",
        });

        if (this.driftWarnings >= this.config.maxDriftWarnings) {
          this.terminateAgent(`Drift limit exceeded (${this.driftWarnings} warnings)`);
        }
      } else if (score > 0.3) {
        // Good signal — reset drift counter on clearly relevant actions
        this.driftWarnings = Math.max(0, this.driftWarnings - 1);
      }
    }
  }

  /** Get the current heartbeat status. */
  getStatus(): HeartbeatStatus {
    const silenceMs = Date.now() - this.lastPulseAt;
    let state: HeartbeatStatus["state"] = "healthy";

    if (this.terminated) {
      state = "terminated";
    } else if (silenceMs > this.config.silenceTerminateMs) {
      state = "critical";
    } else if (
      silenceMs > this.config.silenceWarningMs ||
      this.driftWarnings >= this.config.maxDriftWarnings - 1
    ) {
      state = "warning";
    }

    return {
      taskId: this.taskId,
      instanceId: this.instanceId,
      alive: !this.terminated,
      lastPulseAt: this.lastPulseAt ? new Date(this.lastPulseAt).toISOString() : null,
      silenceMs,
      driftWarnings: this.driftWarnings,
      totalPulses: this.totalPulses,
      state,
    };
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private check(): void {
    if (this.terminated) return;

    const silenceMs = Date.now() - this.lastPulseAt;

    if (silenceMs > this.config.silenceTerminateMs) {
      this.terminateAgent(
        `Silence timeout: no activity for ${Math.round(silenceMs / 1000)}s ` +
        `(limit: ${Math.round(this.config.silenceTerminateMs / 1000)}s)`,
      );
      return;
    }

    if (silenceMs > this.config.silenceWarningMs) {
      this.recordPulse(
        "silence-warning",
        `No activity for ${Math.round(silenceMs / 1000)}s`,
      );

      logActivity({
        source: "agent",
        summary: `Silence warning: ${this.taskId}`,
        detail: `No activity for ${Math.round(silenceMs / 1000)}s`,
        traceId: this.traceId,
        actionLabel: "AUTONOMOUS",
        reason: "heartbeat-silence",
      });
    }
  }

  private terminateAgent(reason: string): void {
    if (this.terminated) return;
    this.terminated = true;

    log.warn("Terminating agent via heartbeat", {
      taskId: this.taskId,
      instanceId: this.instanceId,
      reason,
    });

    this.recordPulse("terminate", reason);

    logActivity({
      source: "agent",
      summary: `Heartbeat termination: ${this.taskId}`,
      detail: reason,
      traceId: this.traceId,
      actionLabel: "AUTONOMOUS",
      reason: "heartbeat-terminate",
    });

    this.stop("terminate");

    // Fire-and-forget termination callback
    this.onTerminate(this.instanceId, reason).catch((err) => {
      log.error("Failed to terminate agent", {
        instanceId: this.instanceId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Tracker registry — manage all active heartbeat trackers
// ---------------------------------------------------------------------------

const activeTrackers = new Map<string, HeartbeatTracker>();

/** Create and register a heartbeat tracker for an agent instance. */
export function createHeartbeatTracker(
  taskId: string,
  instanceId: string,
  config: Partial<HeartbeatConfig>,
  onTerminate: TerminateCallback,
): HeartbeatTracker {
  // Clean up any existing tracker for this instance
  const existing = activeTrackers.get(instanceId);
  if (existing) {
    existing.stop("terminate");
  }

  const tracker = new HeartbeatTracker(taskId, instanceId, config, onTerminate);
  activeTrackers.set(instanceId, tracker);
  return tracker;
}

/** Get a tracker by instance ID. */
export function getHeartbeatTracker(instanceId: string): HeartbeatTracker | undefined {
  return activeTrackers.get(instanceId);
}

/** Remove a tracker (call on agent completion). */
export function removeHeartbeatTracker(instanceId: string): void {
  const tracker = activeTrackers.get(instanceId);
  if (tracker) {
    tracker.stop();
    activeTrackers.delete(instanceId);
  }
}

/** Get status of all tracked agents. */
export function getAllHeartbeatStatuses(): HeartbeatStatus[] {
  return Array.from(activeTrackers.values()).map((t) => t.getStatus());
}

/** Stop all trackers (call on shutdown). */
export function shutdownHeartbeats(): void {
  for (const [id, tracker] of activeTrackers) {
    tracker.stop("terminate");
    activeTrackers.delete(id);
  }
}
