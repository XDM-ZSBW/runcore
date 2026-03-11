/**
 * Agent Runtime Environment — Unified facade.
 *
 * Provides four core components on top of the existing runtime/ layer:
 *
 * 1. **AgentPool** — Pool-level lifecycle management (spawn, monitor, cleanup, drain).
 * 2. **ResourceManager** — Per-agent CPU/memory allocation with utilization tracking.
 * 3. **ErrorRecovery** — Retry policies with exponential backoff + circuit breakers.
 * 4. **AgentIsolation** — Process boundary enforcement, env sanitization, timeouts.
 *
 * Usage:
 *   const pool = await AgentPool.create();
 *   const instance = await pool.spawn({ taskId, label, prompt, origin });
 *   pool.getMonitoringSnapshot();
 *   await pool.shutdown("done");
 */

import type {
  AgentInstance,
  AgentState,
  AgentError,
  SpawnRequest,
  ResourceAllocation,
  ResourceSnapshot,
  AgentInstanceConfig,
  RuntimeConfig,
  LifecycleEvent,
} from "./runtime/types.js";
import { TERMINAL_STATES } from "./runtime/types.js";
import { RuntimeManager } from "./runtime/manager.js";
import type { AgentInstanceManager, HealthSummary, InstanceHealth } from "./instance-manager.js";
import { logActivity } from "../activity/log.js";

// Lazy-loaded spawn-tier modules
let _runtimeIndex: typeof import("./runtime/index.js") | null = null;
let _instanceMgr: typeof import("./instance-manager.js") | null = null;

async function getRuntimeIndex() {
  if (!_runtimeIndex) { try { _runtimeIndex = await import("./runtime/index.js"); } catch { _runtimeIndex = null; } }
  return _runtimeIndex;
}
async function getInstanceMgr() {
  if (!_instanceMgr) { try { _instanceMgr = await import("./instance-manager.js"); } catch { _instanceMgr = null; } }
  return _instanceMgr;
}

// ===========================================================================
// ErrorRecovery — Retry policies and circuit breakers
// ===========================================================================

/** Circuit breaker states. */
export type CircuitState = "closed" | "open" | "half-open";

/** Configuration for a circuit breaker. */
export interface CircuitBreakerConfig {
  /** Failures within the window to trip the circuit. Default: 5. */
  failureThreshold: number;
  /** Rolling window for failure counting (ms). Default: 60s. */
  windowMs: number;
  /** How long the circuit stays open before probing (ms). Default: 30s. */
  resetTimeoutMs: number;
  /** Max probe attempts in half-open state before re-opening. Default: 2. */
  halfOpenMaxProbes: number;
}

const DEFAULT_CIRCUIT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  windowMs: 60_000,
  resetTimeoutMs: 30_000,
  halfOpenMaxProbes: 2,
};

/** Per-operation circuit breaker state. */
interface CircuitBreakerState {
  state: CircuitState;
  failures: number[];       // timestamps of failures within window
  lastFailure?: number;
  openedAt?: number;
  probeCount: number;
  totalTrips: number;
  config: CircuitBreakerConfig;
}

/** Retry policy for a spawn or operation. */
export interface RetryPolicy {
  maxRetries: number;
  backoffMs: number;
  backoffMultiplier: number;
  maxBackoffMs: number;
  /** Only retry on these error codes. Empty = retry all recoverable. */
  retryableErrors?: string[];
}

const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  backoffMs: 2_000,
  backoffMultiplier: 2,
  maxBackoffMs: 30_000,
};

/** Snapshot of error recovery state for monitoring. */
export interface ErrorRecoverySnapshot {
  circuits: Record<string, {
    state: CircuitState;
    failureCount: number;
    totalTrips: number;
    lastFailure?: string;
    openedAt?: string;
  }>;
  retryPolicy: RetryPolicy;
}

export class ErrorRecovery {
  private circuits = new Map<string, CircuitBreakerState>();
  private retryPolicy: RetryPolicy;

  constructor(retryPolicy?: Partial<RetryPolicy>) {
    this.retryPolicy = { ...DEFAULT_RETRY_POLICY, ...retryPolicy };
  }

  /** Get or create a circuit breaker for a named operation. */
  getCircuit(name: string, config?: Partial<CircuitBreakerConfig>): CircuitBreakerState {
    let circuit = this.circuits.get(name);
    if (!circuit) {
      circuit = {
        state: "closed",
        failures: [],
        probeCount: 0,
        totalTrips: 0,
        config: { ...DEFAULT_CIRCUIT_CONFIG, ...config },
      };
      this.circuits.set(name, circuit);
    }
    return circuit;
  }

  /**
   * Check if an operation is allowed through its circuit breaker.
   * Returns true if the call should proceed, false if the circuit is open.
   */
  allowRequest(circuitName: string): boolean {
    const circuit = this.getCircuit(circuitName);
    const now = Date.now();

    switch (circuit.state) {
      case "closed":
        return true;

      case "open": {
        // Check if reset timeout has elapsed → transition to half-open
        if (circuit.openedAt && now - circuit.openedAt >= circuit.config.resetTimeoutMs) {
          circuit.state = "half-open";
          circuit.probeCount = 0;
          logActivity({
            source: "agent",
            summary: `Circuit breaker half-open: ${circuitName}`,
            detail: `Allowing probe after ${circuit.config.resetTimeoutMs}ms`,
          });
          return true;
        }
        return false;
      }

      case "half-open": {
        // Allow limited probes in half-open
        if (circuit.probeCount < circuit.config.halfOpenMaxProbes) {
          circuit.probeCount++;
          return true;
        }
        return false;
      }
    }
  }

  /** Record a successful operation — resets the circuit to closed. */
  recordSuccess(circuitName: string): void {
    const circuit = this.circuits.get(circuitName);
    if (!circuit) return;

    if (circuit.state === "half-open") {
      circuit.state = "closed";
      circuit.failures = [];
      circuit.probeCount = 0;
      circuit.openedAt = undefined;
      logActivity({
        source: "agent",
        summary: `Circuit breaker closed: ${circuitName}`,
        detail: "Probe succeeded, circuit restored",
      });
    }
  }

  /** Record a failure — may trip the circuit to open. */
  recordFailure(circuitName: string, error?: AgentError): void {
    const circuit = this.getCircuit(circuitName);
    const now = Date.now();

    // If in half-open and probe failed, re-open immediately
    if (circuit.state === "half-open") {
      circuit.state = "open";
      circuit.openedAt = now;
      circuit.totalTrips++;
      logActivity({
        source: "agent",
        summary: `Circuit breaker re-opened: ${circuitName}`,
        detail: `Probe failed, trip #${circuit.totalTrips}`,
      });
      return;
    }

    // Prune old failures outside the window
    circuit.failures = circuit.failures.filter(
      (t) => now - t < circuit.config.windowMs,
    );

    circuit.failures.push(now);
    circuit.lastFailure = now;

    // Check threshold
    if (circuit.failures.length >= circuit.config.failureThreshold) {
      circuit.state = "open";
      circuit.openedAt = now;
      circuit.totalTrips++;
      logActivity({
        source: "agent",
        summary: `Circuit breaker opened: ${circuitName}`,
        detail: `${circuit.failures.length} failures in ${circuit.config.windowMs}ms window, trip #${circuit.totalTrips}`,
      });
    }
  }

  /** Calculate retry delay for a given attempt number. Returns null if exhausted. */
  getRetryDelay(attempt: number, error?: AgentError): number | null {
    if (attempt >= this.retryPolicy.maxRetries) return null;

    // If we have a non-recoverable error, don't retry
    if (error && !error.recoverable) return null;

    // If retryableErrors is set, check if this error qualifies
    if (
      error &&
      this.retryPolicy.retryableErrors?.length &&
      !this.retryPolicy.retryableErrors.includes(error.code)
    ) {
      return null;
    }

    const delay = Math.min(
      this.retryPolicy.backoffMs * Math.pow(this.retryPolicy.backoffMultiplier, attempt),
      this.retryPolicy.maxBackoffMs,
    );

    return delay;
  }

  /** Get a monitoring snapshot of all circuit breakers. */
  snapshot(): ErrorRecoverySnapshot {
    const circuits: ErrorRecoverySnapshot["circuits"] = {};
    for (const [name, circuit] of this.circuits) {
      circuits[name] = {
        state: circuit.state,
        failureCount: circuit.failures.length,
        totalTrips: circuit.totalTrips,
        lastFailure: circuit.lastFailure
          ? new Date(circuit.lastFailure).toISOString()
          : undefined,
        openedAt: circuit.openedAt
          ? new Date(circuit.openedAt).toISOString()
          : undefined,
      };
    }
    return { circuits, retryPolicy: this.retryPolicy };
  }

  /** Reset a specific circuit breaker to closed. */
  resetCircuit(name: string): void {
    const circuit = this.circuits.get(name);
    if (circuit) {
      circuit.state = "closed";
      circuit.failures = [];
      circuit.probeCount = 0;
      circuit.openedAt = undefined;
    }
  }

  /** Clear all circuit breakers. */
  clear(): void {
    this.circuits.clear();
  }
}

// ===========================================================================
// AgentIsolation — Process boundary enforcement
// ===========================================================================

/** Isolation level for an agent. */
export type IsolationLevel = "shared" | "sandboxed" | "strict";

/** Isolation constraints applied to a spawn request. */
export interface IsolationConstraints {
  level: IsolationLevel;
  /** Allowed env var prefixes. */
  envAllowList: string[];
  /** Maximum wall-clock time (ms). */
  timeoutMs: number;
  /** Working directory override (sandboxed agents get a unique dir). */
  cwd?: string;
  /** Whether the agent can spawn child agents. */
  canSpawnChildren: boolean;
}

const DEFAULT_ISOLATION: IsolationConstraints = {
  level: "shared",
  envAllowList: ["CORE_", "DASH_", "NODE_", "PATH", "HOME", "USERPROFILE", "TEMP", "TMP"],
  timeoutMs: 10 * 60_000,
  canSpawnChildren: true,
};

const SANDBOXED_ISOLATION: IsolationConstraints = {
  level: "sandboxed",
  envAllowList: ["CORE_", "DASH_", "NODE_", "PATH"],
  timeoutMs: 5 * 60_000,
  canSpawnChildren: false,
};

const STRICT_ISOLATION: IsolationConstraints = {
  level: "strict",
  envAllowList: ["PATH"],
  timeoutMs: 2 * 60_000,
  canSpawnChildren: false,
};

export class AgentIsolation {
  private readonly sandboxRoot: string;

  constructor(sandboxRoot: string = "brain/agents/sandboxes") {
    this.sandboxRoot = sandboxRoot;
  }

  /** Resolve isolation constraints for a spawn request. */
  resolveConstraints(request: SpawnRequest): IsolationConstraints {
    const level = request.config?.isolation ?? "shared";

    switch (level) {
      case "sandboxed":
        return {
          ...SANDBOXED_ISOLATION,
          cwd: `${this.sandboxRoot}/${request.taskId}`,
          timeoutMs: request.config?.timeoutMs ?? SANDBOXED_ISOLATION.timeoutMs,
        };
      default:
        return {
          ...DEFAULT_ISOLATION,
          timeoutMs: request.config?.timeoutMs ?? DEFAULT_ISOLATION.timeoutMs,
        };
    }
  }

  /** Resolve strict isolation for untrusted or system-critical agents. */
  resolveStrictConstraints(request: SpawnRequest): IsolationConstraints {
    return {
      ...STRICT_ISOLATION,
      cwd: `${this.sandboxRoot}/${request.taskId}`,
      timeoutMs: request.config?.timeoutMs ?? STRICT_ISOLATION.timeoutMs,
    };
  }

  /**
   * Sanitize environment variables based on isolation constraints.
   * Returns a clean env object with only allowed variables.
   */
  sanitizeEnv(
    env: Record<string, string | undefined>,
    constraints: IsolationConstraints,
  ): Record<string, string> {
    const clean: Record<string, string> = {};

    for (const [key, value] of Object.entries(env)) {
      if (value == null) continue;
      if (constraints.envAllowList.some((prefix) => key.startsWith(prefix))) {
        clean[key] = value;
      }
    }

    // Always strip CLAUDECODE to allow nested sessions
    delete clean.CLAUDECODE;

    return clean;
  }

  /**
   * Apply isolation constraints to a spawn request's config.
   * Returns the modified config partial to merge into the request.
   */
  applyToConfig(
    request: SpawnRequest,
    constraints: IsolationConstraints,
  ): Partial<AgentInstanceConfig> {
    const baseConfig = request.config ?? {};
    const sanitizedEnv = this.sanitizeEnv(
      { ...process.env, ...baseConfig.env },
      constraints,
    );

    return {
      ...baseConfig,
      timeoutMs: constraints.timeoutMs,
      env: sanitizedEnv,
      isolation: constraints.level === "strict" ? "sandboxed" : constraints.level,
    };
  }
}

// ===========================================================================
// ResourceManager — Enhanced resource tracking
// ===========================================================================

/** Per-agent resource usage record. */
export interface AgentResourceUsage {
  agentId: string;
  label: string;
  allocated: ResourceAllocation;
  startedAt: string;
  elapsedMs: number;
  state: AgentState;
}

/** Detailed resource utilization snapshot. */
export interface ResourceUtilization {
  snapshot: ResourceSnapshot;
  perAgent: AgentResourceUsage[];
  utilization: {
    agentPercent: number;
    memoryPercent: number;
  };
  pressure: "low" | "moderate" | "high" | "critical";
}

export class ResourceManager {
  private readonly runtime: RuntimeManager;

  constructor(runtime: RuntimeManager) {
    this.runtime = runtime;
  }

  /** Get detailed per-agent resource utilization. */
  getUtilization(): ResourceUtilization {
    const snapshot = this.runtime.getResourceSnapshot();
    const instances = this.runtime.listActive();
    const now = Date.now();

    const perAgent: AgentResourceUsage[] = instances.map((inst) => ({
      agentId: inst.id,
      label: inst.metadata.label,
      allocated: inst.resources,
      startedAt: inst.createdAt,
      elapsedMs: now - new Date(inst.createdAt).getTime(),
      state: inst.state,
    }));

    const agentPercent = snapshot.maxAgents > 0
      ? (snapshot.activeAgents / snapshot.maxAgents) * 100
      : 0;
    const memoryPercent = snapshot.maxMemoryMB > 0
      ? (snapshot.totalMemoryMB / snapshot.maxMemoryMB) * 100
      : 0;

    let pressure: ResourceUtilization["pressure"];
    const maxUtil = Math.max(agentPercent, memoryPercent);
    if (maxUtil >= 90) pressure = "critical";
    else if (maxUtil >= 75) pressure = "high";
    else if (maxUtil >= 50) pressure = "moderate";
    else pressure = "low";

    return {
      snapshot,
      perAgent,
      utilization: {
        agentPercent: Math.round(agentPercent * 10) / 10,
        memoryPercent: Math.round(memoryPercent * 10) / 10,
      },
      pressure,
    };
  }

  /** Check if there's capacity to spawn with the given resources. */
  canSpawn(resources?: Partial<ResourceAllocation>): boolean {
    const alloc: ResourceAllocation = {
      memoryLimitMB: resources?.memoryLimitMB ?? this.runtime.config.defaultMemoryLimitMB,
      cpuWeight: resources?.cpuWeight ?? this.runtime.config.defaultCpuWeight,
    };
    return this.runtime.resources.canAllocate(alloc);
  }

  /** Get the number of queued spawn requests. */
  get queueLength(): number {
    return this.runtime.resources.queueLength;
  }
}

// ===========================================================================
// AgentPool — Top-level lifecycle management
// ===========================================================================

/** Configuration for the agent pool. */
export interface AgentPoolConfig {
  /** Maximum concurrent agents. Overrides runtime default. */
  maxConcurrent?: number;
  /** Circuit breaker config for spawn operations. */
  spawnCircuit?: Partial<CircuitBreakerConfig>;
  /** Default retry policy for agent operations. */
  retryPolicy?: Partial<RetryPolicy>;
  /** Sandbox root for isolated agents. */
  sandboxRoot?: string;
  /** Whether to drain the queue on shutdown (vs. reject). Default: true. */
  drainOnShutdown?: boolean;
  /** Max time to wait for drain on shutdown (ms). Default: 30s. */
  drainTimeoutMs?: number;
}

const DEFAULT_POOL_CONFIG: Required<AgentPoolConfig> = {
  maxConcurrent: 5,
  spawnCircuit: {},
  retryPolicy: {},
  sandboxRoot: "brain/agents/sandboxes",
  drainOnShutdown: true,
  drainTimeoutMs: 30_000,
};

/** Full monitoring snapshot of the agent pool. */
export interface PoolMonitoringSnapshot {
  timestamp: string;
  pool: {
    active: number;
    queued: number;
    maxConcurrent: number;
    totalSpawned: number;
    totalCompleted: number;
    totalFailed: number;
  };
  resources: ResourceUtilization;
  errorRecovery: ErrorRecoverySnapshot;
  health: HealthSummary | null;
}

export class AgentPool {
  readonly errorRecovery: ErrorRecovery;
  readonly isolation: AgentIsolation;
  readonly resourceManager: ResourceManager;

  private readonly runtime: RuntimeManager;
  private readonly instanceManager: AgentInstanceManager;
  private readonly config: Required<AgentPoolConfig>;

  private totalSpawned = 0;
  private totalCompleted = 0;
  private totalFailed = 0;
  private shuttingDown = false;

  private constructor(
    runtime: RuntimeManager,
    instanceManager: AgentInstanceManager,
    config: Required<AgentPoolConfig>,
  ) {
    this.runtime = runtime;
    this.instanceManager = instanceManager;
    this.config = config;
    this.errorRecovery = new ErrorRecovery(config.retryPolicy);
    this.isolation = new AgentIsolation(config.sandboxRoot);
    this.resourceManager = new ResourceManager(runtime);
  }

  /**
   * Create and initialize a fully wired AgentPool.
   * Uses the existing runtime singleton or creates one.
   */
  static async create(config?: AgentPoolConfig): Promise<AgentPool> {
    const merged = { ...DEFAULT_POOL_CONFIG, ...config };

    const runtimeConfig: Partial<RuntimeConfig> = {};
    if (merged.maxConcurrent) {
      runtimeConfig.maxConcurrentAgents = merged.maxConcurrent;
    }

    const rtMod = await getRuntimeIndex();
    if (!rtMod) throw new Error("Agent runtime module not available (spawn tier required)");
    const imMod = await getInstanceMgr();
    if (!imMod) throw new Error("Instance manager module not available (spawn tier required)");

    const runtime = await rtMod.createRuntime(runtimeConfig);
    const instanceManager = new imMod.AgentInstanceManager(runtime);
    await instanceManager.init();

    const pool = new AgentPool(runtime, instanceManager, merged);
    pool.attachEventTracking();

    // Initialize the spawn circuit breaker
    pool.errorRecovery.getCircuit("spawn", merged.spawnCircuit);

    logActivity({
      source: "agent",
      summary: "Agent pool initialized",
      detail: `Max concurrent: ${merged.maxConcurrent}`,
    });

    return pool;
  }

  /**
   * Create from existing runtime and instance manager.
   * Use when the runtime is already initialized (e.g., from server.ts).
   */
  static fromExisting(
    runtime: RuntimeManager,
    instanceManager: AgentInstanceManager,
    config?: AgentPoolConfig,
  ): AgentPool {
    const merged = { ...DEFAULT_POOL_CONFIG, ...config };
    const pool = new AgentPool(runtime, instanceManager, merged);
    pool.attachEventTracking();
    pool.errorRecovery.getCircuit("spawn", merged.spawnCircuit);
    return pool;
  }

  // -------------------------------------------------------------------------
  // Spawn — with circuit breaker and isolation
  // -------------------------------------------------------------------------

  /**
   * Spawn an agent through the pool.
   * Applies circuit breaker check, isolation constraints, and delegates
   * to the instance manager for load-balanced spawning.
   */
  async spawn(request: SpawnRequest): Promise<AgentInstance> {
    if (this.shuttingDown) {
      throw new Error("Agent pool is shutting down");
    }

    // Circuit breaker check
    if (!this.errorRecovery.allowRequest("spawn")) {
      const circuit = this.errorRecovery.getCircuit("spawn");
      throw new Error(
        `Spawn circuit breaker is ${circuit.state}: too many recent failures (${circuit.totalTrips} trips)`,
      );
    }

    // Apply isolation constraints
    const constraints = this.isolation.resolveConstraints(request);
    const isolatedConfig = this.isolation.applyToConfig(request, constraints);

    const enrichedRequest: SpawnRequest = {
      ...request,
      config: { ...request.config, ...isolatedConfig },
    };

    try {
      const instance = await this.instanceManager.spawn(enrichedRequest);
      this.totalSpawned++;
      this.errorRecovery.recordSuccess("spawn");
      return instance;
    } catch (err) {
      this.errorRecovery.recordFailure("spawn", {
        code: "SPAWN_FAILED",
        message: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
        recoverable: true,
      });
      throw err;
    }
  }

  /**
   * Spawn with strict isolation for untrusted or system-critical agents.
   */
  async spawnIsolated(request: SpawnRequest): Promise<AgentInstance> {
    const constraints = this.isolation.resolveStrictConstraints(request);
    const isolatedConfig = this.isolation.applyToConfig(request, constraints);

    return this.spawn({
      ...request,
      config: { ...request.config, ...isolatedConfig, isolation: "sandboxed" },
    });
  }

  // -------------------------------------------------------------------------
  // Lifecycle operations (delegate to instance manager)
  // -------------------------------------------------------------------------

  async pause(instanceId: string, reason?: string): Promise<AgentInstance> {
    return this.instanceManager.pause(instanceId, reason);
  }

  async resume(instanceId: string): Promise<AgentInstance> {
    return this.instanceManager.resume(instanceId);
  }

  async terminate(instanceId: string, reason?: string): Promise<AgentInstance> {
    return this.instanceManager.terminate(instanceId, reason);
  }

  async restart(instanceId: string, reason?: string): Promise<AgentInstance> {
    return this.instanceManager.restart(instanceId, reason);
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  getInstance(id: string): AgentInstance | undefined {
    return this.instanceManager.getInstance(id);
  }

  listActive(): AgentInstance[] {
    return this.runtime.listActive();
  }

  listAll(): AgentInstance[] {
    return this.runtime.listInstances();
  }

  getHealthSummary(): HealthSummary {
    return this.instanceManager.getHealthSummary();
  }

  assessHealth(instanceId: string): InstanceHealth {
    return this.instanceManager.assessHealth(instanceId);
  }

  // -------------------------------------------------------------------------
  // Monitoring
  // -------------------------------------------------------------------------

  /** Get a full monitoring snapshot of the pool. */
  getMonitoringSnapshot(): PoolMonitoringSnapshot {
    let health: HealthSummary | null = null;
    try {
      health = this.instanceManager.getHealthSummary();
    } catch {
      // Instance manager may not be fully initialized
    }

    return {
      timestamp: new Date().toISOString(),
      pool: {
        active: this.runtime.listActive().length,
        queued: this.resourceManager.queueLength,
        maxConcurrent: this.config.maxConcurrent,
        totalSpawned: this.totalSpawned,
        totalCompleted: this.totalCompleted,
        totalFailed: this.totalFailed,
      },
      resources: this.resourceManager.getUtilization(),
      errorRecovery: this.errorRecovery.snapshot(),
      health,
    };
  }

  // -------------------------------------------------------------------------
  // Graceful shutdown
  // -------------------------------------------------------------------------

  /**
   * Graceful shutdown:
   * 1. Stop accepting new spawns
   * 2. Optionally drain the queue (wait for queued items to complete)
   * 3. Terminate all active agents
   * 4. Clean up resources
   */
  async shutdown(reason: string = "Pool shutdown"): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    logActivity({
      source: "agent",
      summary: "Agent pool shutting down",
      detail: `Reason: ${reason}, drain: ${this.config.drainOnShutdown}`,
    });

    // Drain or reject queued requests
    if (this.config.drainOnShutdown) {
      await this.drainQueue(this.config.drainTimeoutMs);
    }

    // Shut down instance manager (stops GC, health timers)
    await this.instanceManager.shutdown();

    // Shut down the runtime (terminates agents, stops monitor, clears bus)
    await this.runtime.shutdown(reason);

    // Clear error recovery state
    this.errorRecovery.clear();

    logActivity({
      source: "agent",
      summary: "Agent pool shut down",
      detail: `Spawned: ${this.totalSpawned}, completed: ${this.totalCompleted}, failed: ${this.totalFailed}`,
    });
  }

  /** Wait for the queue to drain, with a timeout. */
  private async drainQueue(timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (this.resourceManager.queueLength > 0) {
      if (Date.now() - start > timeoutMs) {
        logActivity({
          source: "agent",
          summary: `Queue drain timed out after ${timeoutMs}ms`,
          detail: `${this.resourceManager.queueLength} requests still queued`,
        });
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  // -------------------------------------------------------------------------
  // Internal: event tracking
  // -------------------------------------------------------------------------

  private attachEventTracking(): void {
    this.runtime.bus.on("agent:completed", () => {
      this.totalCompleted++;
    });

    this.runtime.bus.on("agent:failed", ({ error }) => {
      this.totalFailed++;
      // Don't feed into spawn circuit breaker here — AgentPool.spawn() already
      // calls recordFailure("spawn") on spawn errors. Counting again here
      // would double-count and trip the breaker at half the expected threshold.
      // DRIVER_ERROR (non-zero exit) is a runtime failure, not a spawn failure,
      // so it shouldn't affect the spawn circuit breaker either.
    });
  }

  // -------------------------------------------------------------------------
  // Accessors for underlying layers
  // -------------------------------------------------------------------------

  /** Access the underlying RuntimeManager. */
  get runtimeManager(): RuntimeManager {
    return this.runtime;
  }

  /** Access the underlying AgentInstanceManager. */
  get agentInstanceManager(): AgentInstanceManager {
    return this.instanceManager;
  }

  /** Whether the pool is in shutdown mode. */
  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }
}
