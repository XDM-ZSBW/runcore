/**
 * Agent Instance Manager (DASH-6).
 *
 * Higher-level orchestrator on top of RuntimeManager that adds:
 * - Restart (terminate + respawn with same config)
 * - Garbage collection for terminated instances
 * - Load-balanced spawn placement
 * - Isolation / sandboxing enforcement
 * - Instance health scoring and automatic recovery
 * - Lifecycle history tracking per instance
 * - Batch operations (pause/terminate by tag, origin, etc.)
 * - RuntimeBus event integration for metrics
 */

import { unlink } from "node:fs/promises";
import { join } from "node:path";
import type {
  AgentInstance,
  AgentState,
  AgentError,
  SpawnRequest,
  ResourceSnapshot,
  LifecycleEvent,
  AgentMessage,
  ResourceAllocation,
  AgentInstanceConfig,
} from "./runtime/types.js";
import { TERMINAL_STATES } from "./runtime/types.js";
import { RuntimeError, ErrorCodes } from "./runtime/errors.js";
import { RuntimeManager } from "./runtime/manager.js";
import { TASKS_DIR, LOGS_DIR } from "./store.js";
import { logActivity } from "../activity/log.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("agent-instance-mgr");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Timing breakdown for a restart() call. */
interface RestartTiming {
  terminateMs: number;
  spawnPrepMs: number;
  spawnMs: number;
  totalMs: number;
}

/** Configuration for the Instance Manager layer. */
export interface InstanceManagerConfig {
  /** How often to run GC for terminated instances (ms). Default: 30s. */
  gcIntervalMs: number;
  /** TTL for terminated instances before GC removes them (ms). Default: 5min. */
  gcTtlMs: number;
  /** How often to run health assessments (ms). Default: 30s. */
  healthCheckIntervalMs: number;
  /** Consecutive health check failures before auto-recovery. Default: 3. */
  unhealthyThreshold: number;
  /** Maximum lifecycle events to retain per instance. Default: 50. */
  maxHistoryPerInstance: number;
  /** Enable automatic recovery of unhealthy instances. Default: true. */
  autoRecover: boolean;
  /** Maximum auto-restart attempts per instance lineage before giving up. Default: 2. */
  maxAutoRestarts: number;
  /** Sandbox working directory root for isolated instances. */
  sandboxRoot: string;
  /** Max instances to collect per GC cycle to prevent event loop blocking. Default: 100. */
  gcBatchSize: number;
  /** Minimum GC interval when adaptive scheduling triggers faster cycles (ms). Default: 5s. */
  gcMinIntervalMs: number;
}

const DEFAULT_CONFIG: InstanceManagerConfig = {
  gcIntervalMs: 30_000,
  gcTtlMs: 5 * 60_000,
  healthCheckIntervalMs: 30_000,
  unhealthyThreshold: 3,
  maxHistoryPerInstance: 50,
  autoRecover: true,
  maxAutoRestarts: 2,
  sandboxRoot: "brain/agents/sandboxes",
  gcBatchSize: 100,
  gcMinIntervalMs: 5_000,
};

/** A lifecycle event entry in the per-instance history. */
export interface HistoryEntry {
  timestamp: string;
  previousState: AgentState;
  newState: AgentState;
  reason?: string;
}

/** Health assessment for a single instance. */
export interface InstanceHealth {
  instanceId: string;
  label: string;
  state: AgentState;
  healthy: boolean;
  score: number; // 0–100
  uptime: number; // ms since creation or last resume
  restartCount: number;
  consecutiveFailures: number;
  lastChecked: string;
  issues: string[];
}

/** Aggregate health summary across all instances. */
export interface HealthSummary {
  totalInstances: number;
  activeInstances: number;
  healthyInstances: number;
  unhealthyInstances: number;
  averageScore: number;
  resources: ResourceSnapshot;
  instances: InstanceHealth[];
}

/** Filter for batch operations. */
export interface InstanceFilter {
  states?: AgentState[];
  tags?: string[];
  origin?: "user" | "ai" | "system";
  labelPattern?: string;
  olderThanMs?: number;
}

/** Metadata tracked per instance beyond what RuntimeManager stores. */
interface InstanceMeta {
  history: HistoryEntry[];
  restartCount: number;
  consecutiveFailures: number;
  lastHealthCheck?: string;
  lastHealthy?: string;
  originalRequest?: SpawnRequest;
}

/** Per-phase timing breakdown for a single GC cycle. */
export interface GcPhaseTiming {
  scanMs: number;
  metaCleanupMs: number;
  registryRemoveMs: number;
  fileDeleteMs: number;
  pruneMs: number;
  totalMs: number;
}

/** Cumulative GC performance metrics. */
export interface GcMetrics {
  /** Total GC cycles completed. */
  totalCycles: number;
  /** Total instances collected across all cycles. */
  totalCollected: number;
  /** Total time spent in GC (ms). */
  totalTimeMs: number;
  /** Peak instances collected in a single cycle. */
  peakCollected: number;
  /** Peak cycle duration (ms). */
  peakTimeMs: number;
  /** Number of cycles that were batch-capped (couldn't clean everything). */
  cappedCycles: number;
  /** Number of adaptive (accelerated) GC runs triggered. */
  adaptiveRuns: number;
  /** Timestamp of last GC run. */
  lastRunAt?: string;
  /** Per-phase timing of last GC cycle (for diagnosing bottlenecks). */
  lastPhaseTiming?: GcPhaseTiming;
  /** Peak file deletion time across all cycles (ms). */
  peakFileDeleteMs: number;
}

// ---------------------------------------------------------------------------
// Instance Manager
// ---------------------------------------------------------------------------

export class AgentInstanceManager {
  readonly config: InstanceManagerConfig;

  private readonly runtime: RuntimeManager;
  private readonly meta = new Map<string, InstanceMeta>();
  private gcTimer: ReturnType<typeof setTimeout> | null = null;
  private gcAdaptiveTimer: ReturnType<typeof setTimeout> | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;
  private gcRunning = false;
  private readonly gcMetrics: GcMetrics = {
    totalCycles: 0,
    totalCollected: 0,
    totalTimeMs: 0,
    peakCollected: 0,
    peakTimeMs: 0,
    cappedCycles: 0,
    adaptiveRuns: 0,
    peakFileDeleteMs: 0,
  };

  /**
   * Cached terminal states array — avoids spreading the Set every GC cycle.
   * TERMINAL_STATES is a ReadonlySet that never changes at runtime.
   */
  private readonly terminalStatesArray = [...TERMINAL_STATES];

  /**
   * Hard limit on pending terminal instances before forcing synchronous
   * collection outside the normal GC schedule (B-010).
   */
  private static readonly BACKLOG_HARD_LIMIT = 500;

  constructor(runtime: RuntimeManager, config?: Partial<InstanceManagerConfig>) {
    this.runtime = runtime;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // -------------------------------------------------------------------------
  // Initialization & shutdown
  // -------------------------------------------------------------------------

  /** Attach to RuntimeBus events, start GC and health timers. */
  async init(): Promise<void> {
    log.info("Initializing instance manager", { gcIntervalMs: this.config.gcIntervalMs, healthCheckIntervalMs: this.config.healthCheckIntervalMs });
    this.attachBusListeners();
    this.startGc();
    this.startHealthChecks();

    // Metadata is created lazily by ensureMeta() on first access per instance
    // (via bus listeners, health checks, or spawn/restart calls), so there's
    // no need for an eager bootstrap loop over all existing instances.

    logActivity({
      source: "agent",
      summary: "Instance manager initialized",
      detail: `GC every ${this.config.gcIntervalMs}ms, health every ${this.config.healthCheckIntervalMs}ms`,
    });
  }

  /** Stop timers, detach listeners, clear metadata. */
  async shutdown(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;

    this.stopGc();
    this.stopHealthChecks();
    this.meta.clear();

    logActivity({
      source: "agent",
      summary: "Instance manager shut down",
    });
  }

  /** Get cumulative GC performance metrics. */
  getGcMetrics(): Readonly<GcMetrics> {
    return { ...this.gcMetrics };
  }

  /**
   * Force an immediate GC cycle, bypassing the timer schedule.
   * Useful when external code detects a backlog of terminal instances.
   * No-op if a GC cycle is already running.
   */
  async forceGc(): Promise<void> {
    if (this.gcRunning || this.destroyed) return;
    await this.runGc();
  }

  // -------------------------------------------------------------------------
  // Lifecycle operations (delegate + enhance)
  // -------------------------------------------------------------------------

  /** Spawn a new agent instance with load-balanced resource selection. */
  async spawn(request: SpawnRequest): Promise<AgentInstance> {
    // Apply isolation enforcement
    const config = this.enforceIsolation(request);

    // Load-balance: adjust resource allocation based on current utilization
    const resources = this.balanceResources(request.resources);

    const enrichedRequest: SpawnRequest = {
      ...request,
      config,
      resources,
    };

    const instance = await this.runtime.spawn(enrichedRequest);

    // Track the original request for restart capability
    const meta = this.ensureMeta(instance.id);
    meta.originalRequest = request;

    return instance;
  }

  /** Pause a running instance. */
  async pause(instanceId: string, reason?: string): Promise<AgentInstance> {
    return this.runtime.pause(instanceId, reason);
  }

  /** Resume a paused instance. */
  async resume(instanceId: string): Promise<AgentInstance> {
    return this.runtime.resume(instanceId);
  }

  /** Terminate an instance. */
  async terminate(instanceId: string, reason?: string): Promise<AgentInstance> {
    return this.runtime.terminate(instanceId, reason);
  }

  /** Restart timing metrics from last restart call. */
  private lastRestartTiming?: RestartTiming;

  /** Get timing breakdown from the most recent restart(). */
  getLastRestartTiming(): RestartTiming | undefined {
    return this.lastRestartTiming;
  }

  /**
   * Restart an instance: terminate, then respawn with the same configuration.
   * Returns the new instance (new ID, fresh state).
   *
   * Optimized: prepares spawn request concurrently with termination,
   * and uses fast-terminate (skips redundant task store update since the
   * task will be re-used by the new instance).
   */
  async restart(instanceId: string, reason?: string): Promise<AgentInstance> {
    const restartStart = Date.now();
    const timing: RestartTiming = {
      terminateMs: 0,
      spawnPrepMs: 0,
      spawnMs: 0,
      totalMs: 0,
    };

    const instance = this.runtime.getInstance(instanceId);
    if (!instance) {
      throw new RuntimeError(
        ErrorCodes.AGENT_NOT_FOUND,
        `Cannot restart: instance not found: ${instanceId}`,
      );
    }

    const meta = this.ensureMeta(instanceId);
    const originalRequest = meta.originalRequest;

    // Prepare spawn request concurrently with termination — no I/O needed
    const prepStart = Date.now();
    const spawnRequest: SpawnRequest = originalRequest ?? {
      taskId: instance.taskId,
      label: instance.metadata.label,
      prompt: "", // Will be re-read from task store by driver
      origin: instance.metadata.origin,
      parentId: instance.metadata.parentId,
      tags: instance.metadata.tags,
      config: instance.config,
      resources: instance.resources,
    };
    timing.spawnPrepMs = Date.now() - prepStart;

    // Terminate if still active (uses fast terminate — skips task store update
    // since the task will be re-used by the new instance)
    if (!TERMINAL_STATES.has(instance.state)) {
      const termStart = Date.now();
      await this.runtime.terminate(instanceId, reason ?? "Restarting");
      timing.terminateMs = Date.now() - termStart;
    }

    const spawnStart = Date.now();
    const newInstance = await this.runtime.spawn(spawnRequest);
    timing.spawnMs = Date.now() - spawnStart;

    // Transfer metadata to new instance
    const newMeta = this.ensureMeta(newInstance.id);
    newMeta.restartCount = meta.restartCount + 1;
    newMeta.originalRequest = originalRequest;
    newMeta.consecutiveFailures = 0;

    timing.totalMs = Date.now() - restartStart;
    this.lastRestartTiming = timing;

    logActivity({
      source: "agent",
      summary: `Agent restarted: ${instance.metadata.label}`,
      detail: `${instanceId} → ${newInstance.id}, restart #${newMeta.restartCount}, ${timing.totalMs}ms [term:${timing.terminateMs} prep:${timing.spawnPrepMs} spawn:${timing.spawnMs}]`,
    });

    return newInstance;
  }

  // -------------------------------------------------------------------------
  // Batch operations
  // -------------------------------------------------------------------------

  /** Pause all instances matching a filter. Returns count paused. */
  async pauseMatching(filter: InstanceFilter, reason?: string): Promise<number> {
    const targets = this.filterInstances(filter).filter((i) => i.state === "running");
    let count = 0;
    const failed: string[] = [];

    for (const inst of targets) {
      try {
        await this.runtime.pause(inst.id, reason ?? "Batch pause");
        count++;
      } catch (err) {
        failed.push(`${inst.id}:${err instanceof Error ? err.message : String(err)}`);
      }
    }

    logActivity({
      source: "agent",
      summary: `Batch pause: ${count}/${targets.length} agents paused${failed.length > 0 ? `, ${failed.length} failed` : ""}`,
      detail: failed.length > 0 ? `Failed: ${failed.join("; ")}` : undefined,
    });

    return count;
  }

  /** Terminate all instances matching a filter. Returns count terminated. */
  async terminateMatching(filter: InstanceFilter, reason?: string): Promise<number> {
    const targets = this.filterInstances(filter).filter(
      (i) => !TERMINAL_STATES.has(i.state),
    );
    let count = 0;
    const failed: string[] = [];

    for (const inst of targets) {
      try {
        await this.runtime.terminate(inst.id, reason ?? "Batch terminate");
        count++;
      } catch (err) {
        failed.push(`${inst.id}:${err instanceof Error ? err.message : String(err)}`);
      }
    }

    logActivity({
      source: "agent",
      summary: `Batch terminate: ${count}/${targets.length} agents terminated${failed.length > 0 ? `, ${failed.length} failed` : ""}`,
      detail: failed.length > 0 ? `Failed: ${failed.join("; ")}` : `Reason: ${reason ?? "batch operation"}`,
    });

    return count;
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /** Get an instance by ID. */
  getInstance(id: string): AgentInstance | undefined {
    return this.runtime.getInstance(id);
  }

  /** List all instances, optionally filtered. */
  listInstances(filter?: InstanceFilter): AgentInstance[] {
    if (!filter) return this.runtime.listInstances();
    return this.filterInstances(filter);
  }

  /** Get lifecycle history for an instance. */
  getHistory(instanceId: string): HistoryEntry[] {
    return this.meta.get(instanceId)?.history ?? [];
  }

  /** Get the restart count for an instance. */
  getRestartCount(instanceId: string): number {
    return this.meta.get(instanceId)?.restartCount ?? 0;
  }

  /** Get current resource snapshot. */
  getResourceSnapshot(): ResourceSnapshot {
    return this.runtime.getResourceSnapshot();
  }

  /** Get state counts across all instances. */
  getStateCounts(): Record<string, number> {
    return this.runtime.getStateCounts();
  }

  // -------------------------------------------------------------------------
  // Health monitoring
  // -------------------------------------------------------------------------

  /** Assess health of a single instance. */
  assessHealth(instanceId: string): InstanceHealth {
    const instance = this.runtime.getInstance(instanceId);
    if (!instance) {
      return {
        instanceId,
        label: "unknown",
        state: "terminated" as AgentState,
        healthy: false,
        score: 0,
        uptime: 0,
        restartCount: 0,
        consecutiveFailures: 0,
        lastChecked: new Date().toISOString(),
        issues: ["Instance not found"],
      };
    }

    const meta = this.ensureMeta(instanceId);
    const now = Date.now();
    const issues: string[] = [];
    let score = 100;

    // Terminal states aren't unhealthy — they're just done
    if (TERMINAL_STATES.has(instance.state)) {
      const isFailed = instance.state === "failed";
      return {
        instanceId,
        label: instance.metadata.label,
        state: instance.state,
        healthy: !isFailed,
        score: isFailed ? 0 : 100,
        uptime: 0,
        restartCount: meta.restartCount,
        consecutiveFailures: meta.consecutiveFailures,
        lastChecked: new Date().toISOString(),
        issues: isFailed ? [`Failed: ${instance.error?.message ?? "unknown"}`] : [],
      };
    }

    // Uptime calculation
    const createdAt = new Date(instance.createdAt).getTime();
    const uptime = now - createdAt;

    // Time decay: older events count less. Uses exponential decay with 30min half-life.
    // A retry 30min ago contributes half the penalty of a retry just now.
    const DECAY_HALF_LIFE_MS = 30 * 60 * 1000;
    const decay = Math.pow(0.5, uptime / DECAY_HALF_LIFE_MS);

    // Check: high retry count (decayed by instance age)
    if (instance.retryCount > 0) {
      score -= Math.round(instance.retryCount * 15 * decay);
      issues.push(`${instance.retryCount} retries`);
    }

    // Check: many restarts (decayed)
    if (meta.restartCount > 2) {
      score -= Math.round((meta.restartCount - 2) * 10 * decay);
      issues.push(`${meta.restartCount} restarts`);
    }

    // Check: consecutive failures (NOT decayed — recent failures always matter)
    if (meta.consecutiveFailures > 0) {
      score -= meta.consecutiveFailures * 20;
      issues.push(`${meta.consecutiveFailures} consecutive failures`);
    }

    // Check: stuck in initializing for too long (>30s)
    if (instance.state === "initializing" && uptime > 30_000) {
      score -= 25;
      issues.push("Stuck in initializing");
    }

    // Check: paused for a long time (>5min)
    if (instance.state === "paused" && instance.pausedAt) {
      const pausedDuration = now - new Date(instance.pausedAt).getTime();
      if (pausedDuration > 5 * 60_000) {
        score -= 10;
        issues.push(`Paused for ${Math.round(pausedDuration / 60_000)}min`);
      }
    }

    // Check: approaching timeout
    if (instance.state === "running") {
      const timeoutMs = instance.config.timeoutMs;
      const elapsed = now - createdAt;
      if (elapsed > timeoutMs * 0.8) {
        score -= 20;
        issues.push("Approaching timeout");
      }
    }

    score = Math.max(0, Math.min(100, score));
    const healthy = score >= 50 && meta.consecutiveFailures < this.config.unhealthyThreshold;

    const result: InstanceHealth = {
      instanceId,
      label: instance.metadata.label,
      state: instance.state,
      healthy,
      score,
      uptime,
      restartCount: meta.restartCount,
      consecutiveFailures: meta.consecutiveFailures,
      lastChecked: new Date().toISOString(),
      issues,
    };

    // Update meta
    meta.lastHealthCheck = result.lastChecked;
    if (healthy) meta.lastHealthy = result.lastChecked;

    return result;
  }

  /** Get aggregate health summary. */
  getHealthSummary(): HealthSummary {
    const instances = this.runtime.listInstances();
    const assessments = instances
      .filter((i) => !TERMINAL_STATES.has(i.state))
      .map((i) => this.assessHealth(i.id));

    const healthyCount = assessments.filter((a) => a.healthy).length;
    const avgScore =
      assessments.length > 0
        ? assessments.reduce((sum, a) => sum + a.score, 0) / assessments.length
        : 100;

    return {
      totalInstances: instances.length,
      activeInstances: assessments.length,
      healthyInstances: healthyCount,
      unhealthyInstances: assessments.length - healthyCount,
      averageScore: Math.round(avgScore),
      resources: this.runtime.getResourceSnapshot(),
      instances: assessments,
    };
  }

  // -------------------------------------------------------------------------
  // Inter-agent messaging (passthrough)
  // -------------------------------------------------------------------------

  sendMessage(from: string, to: string, type: string, payload: unknown): AgentMessage {
    return this.runtime.sendMessage(from, to, type, payload);
  }

  async requestResponse(
    from: string,
    to: string,
    type: string,
    payload: unknown,
    timeoutMs?: number,
  ): Promise<AgentMessage> {
    return this.runtime.requestResponse(from, to, type, payload, timeoutMs);
  }

  subscribeAgent(agentId: string, handler: (msg: AgentMessage) => void): void {
    this.runtime.subscribeAgent(agentId, handler);
  }

  // -------------------------------------------------------------------------
  // Event subscriptions (passthrough)
  // -------------------------------------------------------------------------

  onLifecycle(handler: (event: LifecycleEvent) => void): void {
    this.runtime.onLifecycle(handler);
  }

  onError(handler: (data: { agentId: string; error: AgentError }) => void): void {
    this.runtime.onError(handler);
  }

  onResourceWarning(handler: (data: { usage: ResourceSnapshot }) => void): void {
    this.runtime.onResourceWarning(handler);
  }

  // -------------------------------------------------------------------------
  // Internal: RuntimeBus event listeners
  // -------------------------------------------------------------------------

  private attachBusListeners(): void {
    // Track lifecycle events in per-instance history
    this.runtime.bus.on("agent:lifecycle", (event: LifecycleEvent) => {
      const meta = this.ensureMeta(event.agentId);

      meta.history.push({
        timestamp: event.timestamp,
        previousState: event.previousState,
        newState: event.newState,
        reason: event.reason,
      });

      // Trim history if over limit
      if (meta.history.length > this.config.maxHistoryPerInstance) {
        meta.history = meta.history.slice(-this.config.maxHistoryPerInstance);
      }

      // Reset consecutive failures on successful transition to running
      if (event.newState === "running") {
        meta.consecutiveFailures = 0;
      }
    });

    // Track failures for auto-recovery decisions
    this.runtime.bus.on("agent:failed", (data: { agentId: string; error: AgentError }) => {
      const meta = this.ensureMeta(data.agentId);
      meta.consecutiveFailures++;
    });
  }

  // -------------------------------------------------------------------------
  // Internal: load balancing
  // -------------------------------------------------------------------------

  /**
   * Adjust resource allocation based on current system load.
   * When utilization is high, reduce per-instance allocation to fit more agents.
   * When low, let them use default or requested amounts.
   */
  private balanceResources(
    requested?: Partial<ResourceAllocation>,
  ): Partial<ResourceAllocation> | undefined {
    if (!requested) return undefined;

    const snapshot = this.runtime.getResourceSnapshot();
    const memoryUtilization = snapshot.totalMemoryMB / snapshot.maxMemoryMB;
    const agentUtilization = snapshot.activeAgents / snapshot.maxAgents;

    // If utilization is under 60%, use requested values as-is
    if (memoryUtilization < 0.6 && agentUtilization < 0.6) {
      return requested;
    }

    // Under pressure: scale down memory to fit
    const memoryLimit = requested.memoryLimitMB;
    if (memoryLimit && memoryUtilization > 0.8) {
      const available = snapshot.maxMemoryMB - snapshot.totalMemoryMB;
      const scaled = Math.min(memoryLimit, Math.max(128, available * 0.8));
      return { ...requested, memoryLimitMB: Math.round(scaled) };
    }

    return requested;
  }

  // -------------------------------------------------------------------------
  // Internal: isolation enforcement
  // -------------------------------------------------------------------------

  /**
   * Enforce isolation settings on spawn requests.
   * For sandboxed instances, assign a unique working directory and
   * strip environment variables that could leak across agents.
   */
  private enforceIsolation(
    request: SpawnRequest,
  ): Partial<AgentInstanceConfig> | undefined {
    const isolation = request.config?.isolation;
    if (isolation !== "sandboxed") return request.config;

    const sanitizedEnv: Record<string, string> = {};
    const allowedPrefixes = ["CORE_", "DASH_", "NODE_", "PATH"];

    if (request.config?.env) {
      for (const [key, value] of Object.entries(request.config.env)) {
        if (allowedPrefixes.some((p) => key.startsWith(p))) {
          sanitizedEnv[key] = value;
        }
      }
    }

    return {
      ...request.config,
      env: sanitizedEnv,
      isolation: "sandboxed",
    };
  }

  // -------------------------------------------------------------------------
  // Internal: garbage collection
  // -------------------------------------------------------------------------

  /**
   * Start the GC loop using chained setTimeout with random jitter (B-010).
   * Jitter (0–10s) prevents thundering herd when multiple timers align.
   * Uses setTimeout chain instead of setInterval so each cycle's delay
   * is independent and includes fresh jitter.
   */
  private startGc(): void {
    if (this.gcTimer) return;
    this.scheduleNextGc();
  }

  private scheduleNextGc(): void {
    if (this.destroyed) return;
    const jitter = Math.floor(Math.random() * 10_000); // 0–10s
    this.gcTimer = setTimeout(() => {
      this.runGc()
        .catch((err) => {
          logActivity({
            source: "agent",
            summary: "Instance GC error",
            detail: (err as Error).message,
          });
        })
        .finally(() => {
          this.scheduleNextGc();
        });
    }, this.config.gcIntervalMs + jitter);
  }

  private stopGc(): void {
    if (this.gcTimer) {
      clearTimeout(this.gcTimer);
      this.gcTimer = null;
    }
    if (this.gcAdaptiveTimer) {
      clearTimeout(this.gcAdaptiveTimer);
      this.gcAdaptiveTimer = null;
    }
  }

  /**
   * Schedule an accelerated GC cycle when the regular cycle found more work
   * than it could handle (batch-capped). Uses gcMinIntervalMs to avoid
   * thrashing. Skipped if a regular GC timer tick will fire sooner.
   */
  private scheduleAdaptiveGc(remainingEligible: number): void {
    if (this.gcAdaptiveTimer || this.destroyed) return;

    // Scale delay: more backlog → shorter delay (floor at gcMinIntervalMs)
    const urgency = Math.min(1, remainingEligible / this.config.gcBatchSize);
    const delay = Math.max(
      this.config.gcMinIntervalMs,
      this.config.gcIntervalMs * (1 - urgency * 0.8),
    );

    this.gcAdaptiveTimer = setTimeout(() => {
      this.gcAdaptiveTimer = null;
      this.gcMetrics.adaptiveRuns++;
      this.runGc().catch((err) => {
        logActivity({
          source: "agent",
          summary: "Adaptive GC error",
          detail: (err as Error).message,
        });
      });
    }, delay);
  }

  /**
   * Remove terminated/completed/failed instances that have exceeded the GC TTL.
   * Cleans up both the registry and local metadata, plus associated task files.
   *
   * Optimizations (DASH-139 / DASH-141):
   * - Filter at registry level to avoid scanning non-terminal instances
   * - Use ISO string comparison instead of Date parsing in hot loop
   * - Batch file deletions in chunks to reduce NTFS directory lock contention
   * - Concurrent-run guard prevents overlapping GC cycles
   * - Adaptive scheduling runs sooner when batch-capped
   * - Top-level imports (no dynamic import overhead per cycle)
   * - GC metrics tracking for observability
   */
  private async runGc(): Promise<void> {
    // Prevent overlapping GC cycles (adaptive + regular timer can race)
    if (this.gcRunning) return;
    this.gcRunning = true;

    const start = Date.now();
    try {
      await this.runGcInner(start);
    } finally {
      this.gcRunning = false;
    }
  }

  private async runGcInner(start: number): Promise<void> {
    const timing: GcPhaseTiming = {
      scanMs: 0,
      metaCleanupMs: 0,
      registryRemoveMs: 0,
      fileDeleteMs: 0,
      pruneMs: 0,
      totalMs: 0,
    };

    // Phase 1: query only terminal instances using cached array (avoids
    // spreading TERMINAL_STATES into a new array every cycle)
    const terminal = this.runtime.listInstances({
      states: this.terminalStatesArray,
    });

    if (terminal.length === 0) return;

    // Pre-compute ISO cutoff string — lexicographic comparison avoids Date parsing
    const cutoffMs = start - this.config.gcTtlMs;
    const cutoff = new Date(cutoffMs).toISOString();

    // Phase 2: identify eligible instances, counting total for adaptive scheduling
    const eligible: Array<{ id: string; taskId?: string }> = [];
    let totalEligible = 0;

    // When backlog exceeds hard limit, bypass batch cap for this cycle (B-010).
    // This prevents unbounded accumulation when instances terminate faster
    // than GC can drain at normal batch size.
    const effectiveBatchSize = terminal.length > AgentInstanceManager.BACKLOG_HARD_LIMIT
      ? terminal.length  // uncapped — drain everything
      : this.config.gcBatchSize;

    for (const inst of terminal) {
      const finishedAt = inst.terminatedAt ?? inst.updatedAt;
      if (finishedAt < cutoff) {
        totalEligible++;
        if (eligible.length < effectiveBatchSize) {
          eligible.push({ id: inst.id, taskId: inst.taskId });
        }
      }
    }

    if (eligible.length === 0) return;

    timing.scanMs = Date.now() - start;

    // Phase 3: clear local metadata (sync, fast)
    const metaStart = Date.now();
    for (const { id } of eligible) {
      this.meta.delete(id);
    }
    timing.metaCleanupMs = Date.now() - metaStart;

    // Yield to event loop between phases so GC doesn't block other work
    await new Promise<void>((r) => setTimeout(r, 0));

    // Phase 4+5 (merged): remove from registry in-memory, then delete ALL
    // files (registry + task + logs) in a single chunked pass.
    const registryStart = Date.now();
    const ids = eligible.map((e) => e.id);
    const { removed: collected, filePaths: allFiles } =
      this.runtime.removeInstancesInMemory(ids);

    // Append task + log file paths for instances that have a taskId
    for (const { taskId } of eligible) {
      if (!taskId) continue;
      allFiles.push(join(TASKS_DIR, `${taskId}.json`));
      allFiles.push(join(LOGS_DIR, `${taskId}.stdout.log`));
      allFiles.push(join(LOGS_DIR, `${taskId}.stderr.log`));
      allFiles.push(join(LOGS_DIR, `${taskId}.prompt.txt`));
    }
    timing.registryRemoveMs = Date.now() - registryStart;

    // Single-pass chunked deletion for all file types.
    // Chunk size 40 balances parallelism vs NTFS directory lock contention.
    const deleteStart = Date.now();
    let failCount = 0;
    if (allFiles.length > 0) {
      const CHUNK = 40;
      for (let i = 0; i < allFiles.length; i += CHUNK) {
        const results = await Promise.allSettled(
          allFiles.slice(i, i + CHUNK).map((f) => unlink(f)),
        );
        for (const r of results) {
          if (r.status === "rejected") {
            const err = r.reason as NodeJS.ErrnoException;
            // ENOENT is expected (not all log types exist for every task)
            if (err?.code !== "ENOENT") failCount++;
          }
        }
      }
    }
    timing.fileDeleteMs = Date.now() - deleteStart;

    if (failCount > 0) {
      logActivity({
        source: "agent",
        summary: `Instance GC: ${failCount} file deletions failed`,
      });
    }

    // Phase 6: prune stale metadata entries for instances no longer in registry.
    // Prevents the meta map from growing unboundedly when instances are removed
    // externally or through other code paths.
    const pruneStart = Date.now();
    if (this.meta.size > this.config.gcBatchSize) {
      this.pruneOrphanedMeta();
    }
    timing.pruneMs = Date.now() - pruneStart;

    const elapsed = Date.now() - start;
    timing.totalMs = elapsed;
    const wasCapped = totalEligible > eligible.length;
    const wasBacklogForced = terminal.length > AgentInstanceManager.BACKLOG_HARD_LIMIT;

    // Update GC metrics
    this.gcMetrics.totalCycles++;
    this.gcMetrics.totalCollected += collected;
    this.gcMetrics.totalTimeMs += elapsed;
    this.gcMetrics.lastRunAt = new Date(start).toISOString();
    this.gcMetrics.lastPhaseTiming = timing;
    if (collected > this.gcMetrics.peakCollected) this.gcMetrics.peakCollected = collected;
    if (elapsed > this.gcMetrics.peakTimeMs) this.gcMetrics.peakTimeMs = elapsed;
    if (timing.fileDeleteMs > this.gcMetrics.peakFileDeleteMs) this.gcMetrics.peakFileDeleteMs = timing.fileDeleteMs;
    if (wasCapped) this.gcMetrics.cappedCycles++;

    log.debug("GC cycle complete", { collected, totalEligible, terminal: terminal.length, elapsed, wasCapped, cycle: this.gcMetrics.totalCycles });

    logActivity({
      source: "agent",
      summary: `Instance GC: collected ${collected} of ${totalEligible} eligible (${terminal.length} terminal)`,
      detail: `${elapsed}ms [scan:${timing.scanMs} meta:${timing.metaCleanupMs} reg:${timing.registryRemoveMs} del:${timing.fileDeleteMs} prune:${timing.pruneMs}] ${allFiles.length} files, cycle #${this.gcMetrics.totalCycles}${wasCapped ? ', BATCH CAPPED' : ''}${wasBacklogForced ? ', BACKLOG FORCED' : ''}`,
    });

    // If we hit the batch cap, there's more work to do — schedule an early cycle
    if (wasCapped) {
      this.scheduleAdaptiveGc(totalEligible - eligible.length);
    }
  }

  /**
   * Prune metadata entries for instances that no longer exist in the registry.
   * Uses a Set of current instance IDs for O(1) lookups instead of calling
   * getInstance() per entry (which scans the registry map each time).
   */
  private pruneOrphanedMeta(): void {
    // Build a Set of all known instance IDs (single pass over registry)
    const knownIds = new Set(
      this.runtime.listInstances().map((i) => i.id),
    );
    for (const id of this.meta.keys()) {
      if (!knownIds.has(id)) {
        this.meta.delete(id);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Internal: health checks
  // -------------------------------------------------------------------------

  private startHealthChecks(): void {
    if (this.healthTimer) return;

    this.healthTimer = setInterval(() => {
      this.runHealthChecks().catch((err) => {
        logActivity({
          source: "agent",
          summary: "Health check error",
          detail: (err as Error).message,
        });
      });
    }, this.config.healthCheckIntervalMs);
  }

  private stopHealthChecks(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  /**
   * Run health checks on all active instances.
   * If auto-recovery is enabled, restart instances that exceed the
   * unhealthy threshold.
   */
  private async runHealthChecks(): Promise<void> {
    const active = this.runtime.listActive();

    for (const inst of active) {
      const health = this.assessHealth(inst.id);

      if (!health.healthy && this.config.autoRecover) {
        const meta = this.ensureMeta(inst.id);

        if (meta.consecutiveFailures >= this.config.unhealthyThreshold) {
          // Cap total auto-restarts to prevent infinite restart loops
          if (meta.restartCount >= this.config.maxAutoRestarts) {
            logActivity({
              source: "agent",
              summary: `Auto-recovery skipped (max restarts ${this.config.maxAutoRestarts} reached): ${inst.metadata.label}`,
              detail: `Restarts: ${meta.restartCount}, failures: ${meta.consecutiveFailures}`,
            });
            continue;
          }

          logActivity({
            source: "agent",
            summary: `Auto-recovering unhealthy agent: ${inst.metadata.label}`,
            detail: `Score: ${health.score}, failures: ${meta.consecutiveFailures}, restarts: ${meta.restartCount}/${this.config.maxAutoRestarts}`,
          });

          try {
            await this.restart(inst.id, "Auto-recovery: unhealthy threshold exceeded");
          } catch (err) {
            logActivity({
              source: "agent",
              summary: `Auto-recovery failed: ${inst.metadata.label}`,
              detail: (err as Error).message,
            });
          }
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Internal: filter instances
  // -------------------------------------------------------------------------

  private filterInstances(filter: InstanceFilter): AgentInstance[] {
    let instances = this.runtime.listInstances();

    if (filter.states) {
      const states = new Set(filter.states);
      instances = instances.filter((i) => states.has(i.state));
    }

    if (filter.tags) {
      const tags = new Set(filter.tags);
      instances = instances.filter((i) =>
        i.metadata.tags.some((t) => tags.has(t)),
      );
    }

    if (filter.origin) {
      instances = instances.filter((i) => i.metadata.origin === filter.origin);
    }

    if (filter.labelPattern) {
      const re = new RegExp(filter.labelPattern, "i");
      instances = instances.filter((i) => re.test(i.metadata.label));
    }

    if (filter.olderThanMs) {
      const cutoff = Date.now() - filter.olderThanMs;
      instances = instances.filter(
        (i) => new Date(i.createdAt).getTime() < cutoff,
      );
    }

    return instances;
  }

  // -------------------------------------------------------------------------
  // Internal: metadata helpers
  // -------------------------------------------------------------------------

  private ensureMeta(instanceId: string): InstanceMeta {
    let meta = this.meta.get(instanceId);
    if (!meta) {
      meta = {
        history: [],
        restartCount: 0,
        consecutiveFailures: 0,
      };
      this.meta.set(instanceId, meta);
    }
    return meta;
  }
}
