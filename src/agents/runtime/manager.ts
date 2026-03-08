/**
 * Agent Runtime Environment — RuntimeManager.
 *
 * The central orchestrator that ties together lifecycle management,
 * resource allocation, the event bus, registry persistence, and the
 * agent driver. Provides the high-level API for spawning, pausing,
 * resuming, and terminating agent instances.
 *
 * Usage:
 *   const manager = new RuntimeManager(driver, configOverrides);
 *   await manager.init();
 *   const instance = await manager.spawn({ taskId, label, prompt, origin });
 *   await manager.pause(instance.id);
 *   await manager.resume(instance.id);
 *   await manager.terminate(instance.id);
 *   await manager.shutdown();
 */

import type {
  AgentInstance,
  AgentDriver,
  AgentError,
  RuntimeConfig,
  SpawnRequest,
  ResourceSnapshot,
  LifecycleEvent,
  AgentMessage,
} from "./types.js";
import { TERMINAL_STATES } from "./types.js";
import { RuntimeError, ErrorCodes } from "./errors.js";
import { loadRuntimeConfig, resolveInstanceConfig, resolveResources } from "./config.js";
import { transition, shouldRetry, prepareRetry, isTerminal } from "./lifecycle.js";
import { ResourcePool } from "./resources.js";
import { RuntimeBus } from "./bus.js";
import { AgentRegistry } from "./registry.js";
import { logActivity } from "../../activity/log.js";
import { createLogger } from "../../utils/logger.js";
import { rememberTaskOutcome } from "../memory.js";
import { readTask, readTaskOutput, updateTask } from "../store.js";
import { updateBoardTaskState } from "../spawn.js";

const log = createLogger("agent-runtime");

// ---------------------------------------------------------------------------
// RuntimeManager
// ---------------------------------------------------------------------------

export class RuntimeManager {
  readonly config: RuntimeConfig;
  readonly bus: RuntimeBus;
  readonly resources: ResourcePool;
  readonly registry: AgentRegistry;

  private readonly driver: AgentDriver;
  private monitorTimer: ReturnType<typeof setInterval> | null = null;
  private shutdownRequested = false;

  // ── Retry loop guards ──────────────────────────────────────────────────
  /** Prevents concurrent handleExit calls for the same instance. */
  private handleExitGuard = new Set<string>();
  /** Tracks instances with a pending retry timeout (prevents duplicate scheduling). */
  private retryPending = new Set<string>();

  // ── Global retry budget ────────────────────────────────────────────────
  /** Rolling window of retry timestamps across all instances. */
  private globalRetryTimestamps: number[] = [];
  /**
   * Max retries across all instances within the budget window.
   * Scaled to 3× maxConcurrentAgents to avoid budget exhaustion when a full
   * batch fails (each agent gets maxRetries=2, so 5 agents = 10 retries
   * which previously exhausted the entire budget in one batch).
   */
  private globalRetryBudget: number;
  /** Rolling window for the global retry budget (ms). */
  private static GLOBAL_RETRY_WINDOW_MS = 5 * 60_000; // 5 minutes

  constructor(driver: AgentDriver, configOverrides?: Partial<RuntimeConfig>) {
    this.config = loadRuntimeConfig(configOverrides);
    this.driver = driver;
    this.bus = new RuntimeBus();
    this.resources = new ResourcePool(this.config);
    this.registry = new AgentRegistry(this.config.persistDir);
    // Scale retry budget: 3× max concurrent agents ensures one bad batch
    // doesn't exhaust the entire budget (5 agents × 2 retries = 10, budget = 15)
    this.globalRetryBudget = Math.max(10, this.config.maxConcurrentAgents * 3);
  }

  // -------------------------------------------------------------------------
  // Initialization & shutdown
  // -------------------------------------------------------------------------

  /** Initialize the runtime: load registry, recover agents, start monitor. */
  async init(): Promise<void> {
    const t0 = Date.now();
    log.info("Initializing agent runtime", { driver: this.driver.name, maxAgents: this.config.maxConcurrentAgents });

    const t1 = Date.now();
    await this.registry.init();
    const registryMs = Date.now() - t1;

    const t2 = Date.now();
    await this.recoverAgents();
    const recoveryMs = Date.now() - t2;

    this.startMonitor();
    const totalMs = Date.now() - t0;

    logActivity({
      source: "agent",
      summary: "Agent runtime initialized",
      detail: `Driver: ${this.driver.name}, max agents: ${this.config.maxConcurrentAgents}, init ${totalMs}ms [registry:${registryMs}ms recovery:${recoveryMs}ms]`,
    });
  }

  /** Graceful shutdown: terminate active agents, stop monitor, clean up. */
  async shutdown(reason: string = "Runtime shutdown"): Promise<void> {
    if (this.shutdownRequested) return;
    log.info("Shutting down agent runtime", { reason });
    this.shutdownRequested = true;

    this.bus.emitShutdown(reason);
    this.stopMonitor();

    // Terminate all active agents
    const active = this.registry.listActive();
    const terminations = active.map((inst) =>
      this.terminate(inst.id, reason).catch(() => {}),
    );
    await Promise.allSettled(terminations);

    // Clean up resources, retry guards, and bus
    this.resources.clear();
    this.handleExitGuard.clear();
    this.retryPending.clear();
    this.globalRetryTimestamps.length = 0;
    this.bus.destroy();

    logActivity({
      source: "agent",
      summary: "Agent runtime shut down",
      detail: `Reason: ${reason}, terminated ${active.length} agents`,
    });
  }

  // -------------------------------------------------------------------------
  // Core lifecycle operations
  // -------------------------------------------------------------------------

  /** Spawn a new agent instance. */
  async spawn(request: SpawnRequest): Promise<AgentInstance> {
    log.info(`Spawning agent instance: ${request.label}`, { taskId: request.taskId, origin: request.origin });
    if (this.shutdownRequested) {
      throw new RuntimeError(ErrorCodes.SHUTDOWN_IN_PROGRESS, "Runtime is shutting down");
    }

    const instanceConfig = resolveInstanceConfig(this.config, request.config);
    const resourceAlloc = resolveResources(this.config, request.resources);

    // Check resource availability — queue if not available
    if (!this.resources.canAllocate(resourceAlloc)) {
      logActivity({
        source: "agent",
        summary: `Agent queued (resources exhausted): ${request.label}`,
        detail: `Active: ${this.resources.activeCount}/${this.config.maxConcurrentAgents}`,
      });

      await this.resources.enqueue(request, instanceConfig.priority);
    }

    // Create the instance
    const now = new Date().toISOString();
    const instance: AgentInstance = {
      id: this.registry.generateId(),
      taskId: request.taskId,
      state: "initializing",
      cwd: request.cwd,
      config: instanceConfig,
      resources: resourceAlloc,
      metadata: {
        label: request.label,
        origin: request.origin,
        parentId: request.parentId,
        tags: request.tags ?? [],
      },
      retryCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    // Store the prompt on the instance for the driver
    (instance as AgentInstance & { _prompt?: string })._prompt = request.prompt;

    // Register and allocate resources
    await this.registry.register(instance);
    this.resources.allocate(instance.id, resourceAlloc);

    logActivity({
      source: "agent",
      summary: `Spawning agent: ${request.label}`,
      detail: `Instance ${instance.id}, task ${request.taskId}`,
    });

    // Attempt to spawn via driver
    try {
      const pid = await this.driver.spawn(instance);
      instance.pid = pid;

      const event = transition(instance, "running", "Spawned successfully");
      await this.registry.update(instance.id, {
        state: instance.state,
        pid,
        updatedAt: instance.updatedAt,
      });

      this.bus.emitLifecycle(event);
      this.bus.emitSpawned(instance.id, pid);

      // Register exit handler with driver
      if ("onExit" in this.driver && typeof this.driver.onExit === "function") {
        (this.driver as { onExit: (id: string, handler: (code: number | null) => void) => void })
          .onExit(instance.id, (code) => this.handleExit(instance.id, code));
      }

      logActivity({
        source: "agent",
        summary: `Agent running: ${request.label}`,
        detail: `PID ${pid}, instance ${instance.id}`,
      });

      return instance;
    } catch (err) {
      const error = this.toAgentError(err, ErrorCodes.SPAWN_FAILED, true);
      const event = transition(instance, "failed", "Spawn failed", error);
      await this.registry.update(instance.id, {
        state: "failed",
        error,
        updatedAt: instance.updatedAt,
      });

      this.resources.release(instance.id);
      this.bus.emitLifecycle(event);

      // Check if retry is possible BEFORE emitting terminal failure.
      // Same fix as handleExit: prevent external listeners from firing
      // prematurely while retries are still pending.
      const retryDelay = shouldRetry(instance);
      if (retryDelay !== null) {
        logActivity({
          source: "agent",
          summary: `Agent spawn failed, will retry: ${request.label}`,
          detail: `Attempt ${instance.retryCount + 1}/${instance.config.maxRetries}, backoff ${retryDelay}ms`,
        });
        await this.maybeRetry(instance);
      } else {
        // Terminal failure — notify external listeners
        this.bus.emitFailed(instance.id, error);
        logActivity({
          source: "agent",
          summary: `Agent spawn failed (terminal): ${request.label}`,
          detail: (err as Error).message,
        });
      }

      return instance;
    }
  }

  /** Pause a running agent. */
  async pause(instanceId: string, reason?: string): Promise<AgentInstance> {
    const instance = this.requireInstance(instanceId);
    this.assertState(instance, "running");

    let checkpoint: string | undefined;
    try {
      checkpoint = await this.driver.pause(instance);
    } catch (err) {
      logActivity({
        source: "agent",
        summary: `Agent pause failed: ${instance.metadata.label}`,
        detail: (err as Error).message,
      });
      throw err;
    }

    if (checkpoint) {
      instance.checkpointData = checkpoint;
    }

    const event = transition(instance, "paused", reason ?? "Paused by request");
    await this.registry.update(instanceId, {
      state: "paused",
      checkpointData: instance.checkpointData,
      pausedAt: instance.pausedAt,
      updatedAt: instance.updatedAt,
    });

    this.resources.release(instanceId);
    this.bus.emitLifecycle(event);

    logActivity({
      source: "agent",
      summary: `Agent paused: ${instance.metadata.label}`,
      detail: checkpoint ? "Checkpoint saved" : "No checkpoint",
    });

    return instance;
  }

  /** Resume a paused agent. */
  async resume(instanceId: string): Promise<AgentInstance> {
    const instance = this.requireInstance(instanceId);
    this.assertState(instance, "paused");

    // Check resource availability
    if (!this.resources.canAllocate(instance.resources)) {
      throw new RuntimeError(
        ErrorCodes.RESOURCE_EXHAUSTED,
        "Cannot resume: resources unavailable",
        true,
      );
    }

    const resumeEvent = transition(instance, "resuming", "Resuming from pause");
    this.bus.emitLifecycle(resumeEvent);

    // Re-allocate resources
    this.resources.allocate(instanceId, instance.resources);

    try {
      const pid = await this.driver.resume(instance, instance.checkpointData);
      instance.pid = pid;
      instance.pausedAt = undefined;

      const runEvent = transition(instance, "running", "Resumed successfully");
      await this.registry.update(instanceId, {
        state: "running",
        pid,
        pausedAt: undefined,
        updatedAt: instance.updatedAt,
      });

      this.bus.emitLifecycle(runEvent);
      this.bus.emitSpawned(instanceId, pid);

      // Re-register exit handler
      if ("onExit" in this.driver && typeof this.driver.onExit === "function") {
        (this.driver as { onExit: (id: string, handler: (code: number | null) => void) => void })
          .onExit(instanceId, (code) => this.handleExit(instanceId, code));
      }

      logActivity({
        source: "agent",
        summary: `Agent resumed: ${instance.metadata.label}`,
        detail: `PID ${pid}, instance ${instanceId}`,
      });

      return instance;
    } catch (err) {
      const error = this.toAgentError(err, ErrorCodes.RESUME_FAILED, true);
      const failEvent = transition(instance, "failed", "Resume failed", error);
      await this.registry.update(instanceId, {
        state: "failed",
        error,
        updatedAt: instance.updatedAt,
      });

      this.resources.release(instanceId);
      this.bus.emitLifecycle(failEvent);
      this.bus.emitFailed(instanceId, error);

      logActivity({
        source: "agent",
        summary: `Agent resume failed: ${instance.metadata.label}`,
        detail: (err as Error).message,
      });

      return instance;
    }
  }

  /** Terminate an agent (from any active state). */
  async terminate(instanceId: string, reason?: string): Promise<AgentInstance> {
    const instance = this.requireInstance(instanceId);

    if (isTerminal(instance.state)) {
      return instance; // Already done
    }

    // Transition to terminating
    try {
      const termEvent = transition(instance, "terminating", reason ?? "Terminated by request");
      this.bus.emitLifecycle(termEvent);
    } catch {
      // If transition isn't valid from current state, force it
      instance.state = "terminating";
      instance.updatedAt = new Date().toISOString();
    }

    // Kill the process
    try {
      await this.driver.terminate(instance);
    } catch {
      // Best effort — process may already be dead
    }

    // Transition to terminated
    const finalEvent = transition(instance, "terminated", reason ?? "Terminated");
    // Skip disk persist — GC will delete this file within gcTtlMs.
    // On restart, driver.isAlive() returns false → recovery handles correctly.
    await this.registry.update(instanceId, {
      state: "terminated",
      terminatedAt: instance.terminatedAt,
      updatedAt: instance.updatedAt,
    }, true);

    this.resources.release(instanceId);
    this.bus.unsubscribe(instanceId);
    this.bus.emitLifecycle(finalEvent);

    // Update linked AgentTask
    await updateTask(instance.taskId, {
      status: "cancelled",
      finishedAt: new Date().toISOString(),
    }).catch(() => {});

    logActivity({
      source: "agent",
      summary: `Agent terminated: ${instance.metadata.label}`,
      detail: `Reason: ${reason ?? "requested"}, instance ${instanceId}`,
    });

    return instance;
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /** Get an agent instance by ID. */
  getInstance(id: string): AgentInstance | undefined {
    return this.registry.get(id);
  }

  /** Get an instance by its linked task ID. */
  getByTaskId(taskId: string): AgentInstance | undefined {
    return this.registry.getByTaskId(taskId);
  }

  /** List all instances, optionally filtered. */
  listInstances(filter?: { states?: string[] }): AgentInstance[] {
    if (filter?.states) {
      return this.registry.list({ states: filter.states as import("./types.js").AgentState[] });
    }
    return this.registry.list();
  }

  /** List all active (non-terminal) instances. */
  listActive(): AgentInstance[] {
    return this.registry.listActive();
  }

  /** Get a snapshot of current resource usage. */
  getResourceSnapshot(): ResourceSnapshot {
    return this.resources.snapshot();
  }

  /** Get instance counts by state. */
  getStateCounts(): Record<string, number> {
    return this.registry.countByState();
  }

  /** Remove a terminated instance from the registry and disk. */
  async removeInstance(id: string): Promise<boolean> {
    return this.registry.remove(id);
  }

  /** Remove multiple terminated instances in parallel. */
  async removeInstances(ids: string[]): Promise<number> {
    return this.registry.removeMany(ids);
  }

  /**
   * Remove multiple instances from in-memory registry only (no file I/O).
   * Returns the count removed and their persist file paths for caller-managed
   * batch deletion.
   */
  removeInstancesInMemory(ids: string[]): { removed: number; filePaths: string[] } {
    return this.registry.removeManyInMemory(ids);
  }

  // -------------------------------------------------------------------------
  // Inter-agent messaging
  // -------------------------------------------------------------------------

  /** Send a message between agents. */
  sendMessage(from: string, to: string, type: string, payload: unknown): AgentMessage {
    return this.bus.send({ from, to, type, payload });
  }

  /** Send a request and await a correlated response. */
  async requestResponse(
    from: string,
    to: string,
    type: string,
    payload: unknown,
    timeoutMs?: number,
  ): Promise<AgentMessage> {
    return this.bus.request({ from, to, type, payload }, timeoutMs);
  }

  /** Subscribe an agent to receive messages. */
  subscribeAgent(agentId: string, handler: (msg: AgentMessage) => void): void {
    this.bus.subscribe(agentId, handler);
  }

  // -------------------------------------------------------------------------
  // Event subscriptions (for external consumers)
  // -------------------------------------------------------------------------

  /** Subscribe to lifecycle events. */
  onLifecycle(handler: (event: LifecycleEvent) => void): void {
    this.bus.on("agent:lifecycle", handler);
  }

  /** Subscribe to agent error events. */
  onError(handler: (data: { agentId: string; error: AgentError }) => void): void {
    this.bus.on("agent:error", handler);
  }

  /** Subscribe to resource warning events. */
  onResourceWarning(handler: (data: { usage: ResourceSnapshot }) => void): void {
    this.bus.on("runtime:resource-warning", handler);
  }

  // -------------------------------------------------------------------------
  // Internal: process exit handling
  // -------------------------------------------------------------------------

  private async handleExit(instanceId: string, code: number | null): Promise<void> {
    const instance = this.registry.get(instanceId);
    if (!instance || isTerminal(instance.state)) return;

    // Guard: prevent concurrent handleExit for the same instance.
    // Monitor poll + driver exit handler can race, causing duplicate retry scheduling.
    if (this.handleExitGuard.has(instanceId)) {
      logActivity({
        source: "agent",
        summary: `handleExit skipped (concurrent call): ${instance.metadata.label}`,
        detail: `Instance ${instanceId}, exit code ${code} — another handleExit is already processing`,
      });
      return;
    }
    this.handleExitGuard.add(instanceId);

    try {
      await this.handleExitInner(instanceId, instance, code);
    } finally {
      this.handleExitGuard.delete(instanceId);
    }
  }

  private async handleExitInner(
    instanceId: string,
    instance: AgentInstance,
    code: number | null,
  ): Promise<void> {
    const output = await readTaskOutput(instance.taskId).catch(() => "");
    const resultSummary = output.trim().slice(0, 1000) || undefined;
    // Null exit code (signal/restart) with substantial output is treated as success,
    // matching the same logic in spawn.ts. Without this, RuntimeManager retries
    // agents that spawn.ts already marked as completed.
    const hasSubstantialOutput = output.trim().length > 100;
    const success = code === 0 || (code == null && hasSubstantialOutput);

    if (success) {
      const event = transition(instance, "completed", `Exited with code ${code}`);
      // Skip disk persist — GC will delete this file within gcTtlMs.
      // On restart, driver.isAlive() returns false → recovery handles correctly.
      await this.registry.update(instanceId, {
        state: "completed",
        updatedAt: instance.updatedAt,
        terminatedAt: instance.terminatedAt,
      }, true);

      this.resources.release(instanceId);
      this.bus.emitLifecycle(event);
      this.bus.emitCompleted(instanceId, code ?? undefined);
    } else {
      // Classify recoverability based on exit code and context:
      // - null + near timeout: timeout kill — not recoverable (retrying will timeout again)
      // - null (signal/OOM/killed): potentially recoverable (worth retrying)
      // - non-zero: check output for deterministic failure patterns
      const elapsed = Date.now() - new Date(instance.createdAt).getTime();
      const isTimeout = code === null && elapsed >= instance.config.timeoutMs * 0.9;
      const isDeterministicFailure = isTimeout || this.isDeterministicFailure(output, code);
      const recoverable = !isDeterministicFailure;

      if (isTimeout) {
        logActivity({
          source: "agent",
          summary: `Agent timed out: ${instance.metadata.label}`,
          detail: `Elapsed ${Math.round(elapsed / 1000)}s of ${Math.round(instance.config.timeoutMs / 1000)}s limit — will not retry`,
        });
      }

      const error = this.toAgentError(
        new Error(`Process exited with code ${code}`),
        ErrorCodes.DRIVER_ERROR,
        recoverable,
      );
      const event = transition(instance, "failed", `Exited with code ${code}`, error);
      await this.registry.update(instanceId, {
        state: "failed",
        error,
        updatedAt: instance.updatedAt,
      });

      // Release resources before retry check (maybeRetry re-allocates if needed)
      this.resources.release(instanceId);
      this.bus.emitLifecycle(event);

      // Check if retry is possible BEFORE emitting terminal failure.
      // This prevents external listeners (spawn.ts batch tracking) from
      // prematurely processing the failure while retries are still pending,
      // which was causing retry loop fan-out: continuation spawned new agents
      // while the RuntimeManager was still retrying the original.
      const retryDelay = shouldRetry(instance);
      if (retryDelay !== null) {
        logActivity({
          source: "agent",
          summary: `Agent failed, will retry: ${instance.metadata.label}`,
          detail: `Attempt ${instance.retryCount + 1}/${instance.config.maxRetries}, backoff ${retryDelay}ms, exit code ${code}, recoverable=${recoverable}, instance ${instanceId}`,
        });
        await this.maybeRetry(instance);
        return; // Don't emit agent:failed or update task store — retry pending
      }

      // Terminal failure — no more retries, notify external listeners
      logActivity({
        source: "agent",
        summary: `Agent failed (terminal, no retries left): ${instance.metadata.label}`,
        detail: `Exit code ${code}, retryCount=${instance.retryCount}/${instance.config.maxRetries}, recoverable=${recoverable}, instance ${instanceId}`,
      });
      this.bus.emitFailed(instanceId, error);
    }

    // ── Finalize (reached only for terminal success or terminal failure) ──
    this.bus.unsubscribe(instanceId);

    const newState = success ? "completed" : "failed";
    await updateTask(instance.taskId, {
      status: newState,
      exitCode: code ?? undefined,
      finishedAt: new Date().toISOString(),
      resultSummary,
    }).catch(() => {});

    // Persist to episodic memory
    const task = await readTask(instance.taskId).catch(() => null);
    if (task) {
      rememberTaskOutcome(
        { ...task, status: newState, exitCode: code ?? undefined },
        output,
      ).catch(() => {});
    }

    // Sync board task state (survives server restarts — inline spawn listeners don't)
    if (task?.boardTaskId) {
      updateBoardTaskState(
        task.boardTaskId,
        success
          ? { state: "done" }
          : { state: "todo", assignee: null },
      ).catch(() => {});
    }

    logActivity({
      source: "agent",
      summary: `Agent ${newState}: ${instance.metadata.label}`,
      detail: `Exit code ${code}, instance ${instanceId}`,
    });
  }

  // -------------------------------------------------------------------------
  // Internal: retry logic
  // -------------------------------------------------------------------------

  /**
   * Emit terminal failure event and finalize task store + memory.
   * Called when all retries are exhausted or a non-recoverable error occurs
   * within the retry path. This ensures external listeners (spawn.ts batch
   * tracking) are notified and the task store reflects the final state.
   *
   * Without this, tasks that fail during retries would leave the task store
   * in a stale "running" state and batch continuation would never trigger.
   */
  private async finalizeTerminalFailure(instance: AgentInstance, error?: AgentError): Promise<void> {
    const finalError = error ?? instance.error ?? {
      code: ErrorCodes.MAX_RETRIES_EXCEEDED,
      message: "Agent failed after all retry attempts",
      timestamp: new Date().toISOString(),
      recoverable: false,
    };

    this.bus.emitFailed(instance.id, finalError);
    this.bus.unsubscribe(instance.id);

    // Update linked AgentTask
    const output = await readTaskOutput(instance.taskId).catch(() => "");
    const resultSummary = output.trim().slice(0, 1000) || undefined;
    await updateTask(instance.taskId, {
      status: "failed",
      finishedAt: new Date().toISOString(),
      resultSummary,
    }).catch(() => {});

    // Persist to episodic memory
    const task = await readTask(instance.taskId).catch(() => null);
    if (task) {
      rememberTaskOutcome(
        { ...task, status: "failed" },
        output,
      ).catch(() => {});
    }

    logActivity({
      source: "agent",
      summary: `Agent failed (terminal): ${instance.metadata.label}`,
      detail: `${instance.retryCount} retries exhausted, instance ${instance.id}`,
    });
  }

  private async maybeRetry(instance: AgentInstance): Promise<void> {
    // Guard: prevent duplicate retry scheduling for the same instance.
    // This can happen when monitor poll and driver exit handler both trigger handleExit.
    if (this.retryPending.has(instance.id)) {
      logActivity({
        source: "agent",
        summary: `Retry already pending, skipping duplicate: ${instance.metadata.label}`,
        detail: `Instance ${instance.id}, retryCount=${instance.retryCount}`,
      });
      return;
    }

    const delay = shouldRetry(instance);
    if (delay === null) {
      // Retries exhausted — emit terminal failure for external listeners.
      // handleExit and spawn() skip emitting agent:failed when retry was
      // possible, so this is the terminal notification path.
      const terminalError = instance.error ?? {
        code: ErrorCodes.MAX_RETRIES_EXCEEDED,
        message: `Max retries (${instance.config.maxRetries}) exceeded after ${instance.retryCount} attempts`,
        timestamp: new Date().toISOString(),
        recoverable: false,
      };

      if (instance.retryCount > 0) {
        logActivity({
          source: "agent",
          summary: `Agent max retries exceeded: ${instance.metadata.label}`,
          detail: `${instance.retryCount}/${instance.config.maxRetries} attempts, instance ${instance.id}`,
        });
      }

      await this.finalizeTerminalFailure(instance, terminalError);
      return;
    }

    // Check global retry budget to prevent retry storms when many agents fail at once
    const now = Date.now();
    this.globalRetryTimestamps = this.globalRetryTimestamps.filter(
      (t) => now - t < RuntimeManager.GLOBAL_RETRY_WINDOW_MS,
    );
    if (this.globalRetryTimestamps.length >= this.globalRetryBudget) {
      const budgetError: AgentError = {
        code: ErrorCodes.MAX_RETRIES_EXCEEDED,
        message: `Global retry budget exhausted: ${this.globalRetryTimestamps.length} retries in ${RuntimeManager.GLOBAL_RETRY_WINDOW_MS / 60_000}min window`,
        timestamp: new Date().toISOString(),
        recoverable: false,
      };
      logActivity({
        source: "agent",
        summary: `Global retry budget exhausted, failing: ${instance.metadata.label}`,
        detail: `${this.globalRetryTimestamps.length}/${this.globalRetryBudget} retries in ${RuntimeManager.GLOBAL_RETRY_WINDOW_MS / 60_000}min, instance ${instance.id}`,
      });
      await this.finalizeTerminalFailure(instance, budgetError);
      return;
    }

    // Mark this instance as having a pending retry
    this.retryPending.add(instance.id);
    this.globalRetryTimestamps.push(now);

    logActivity({
      source: "agent",
      summary: `Agent retrying in ${delay}ms: ${instance.metadata.label}`,
      detail: `Attempt ${instance.retryCount + 1}/${instance.config.maxRetries}, instance ${instance.id}, global retries: ${this.globalRetryTimestamps.length}/${this.globalRetryBudget}`,
    });

    setTimeout(async () => {
      this.retryPending.delete(instance.id);
      let resourcesAllocated = false;
      try {
        const retryEvent = prepareRetry(instance);
        this.bus.emitLifecycle(retryEvent);

        await this.registry.update(instance.id, {
          state: "initializing",
          retryCount: instance.retryCount,
          error: undefined,
          pid: undefined,
          terminatedAt: undefined,
          updatedAt: instance.updatedAt,
        });

        // Re-read the original task for the prompt
        const task = await readTask(instance.taskId).catch(() => null);
        if (task) {
          (instance as AgentInstance & { _prompt?: string })._prompt = task.prompt;
        }

        // Re-allocate and spawn
        if (!this.resources.canAllocate(instance.resources)) {
          // Resources unavailable — fail the retry instead of leaving a zombie
          const error: AgentError = {
            code: ErrorCodes.RESOURCE_EXHAUSTED,
            message: `Resources unavailable for retry attempt ${instance.retryCount}`,
            timestamp: new Date().toISOString(),
            recoverable: false,
          };
          instance.state = "failed";
          instance.error = error;
          instance.updatedAt = new Date().toISOString();
          await this.registry.update(instance.id, {
            state: "failed",
            error,
            updatedAt: instance.updatedAt,
          });
          logActivity({
            source: "agent",
            summary: `Agent retry aborted (resources exhausted): ${instance.metadata.label}`,
            detail: `Attempt ${instance.retryCount}/${instance.config.maxRetries}, instance ${instance.id}`,
          });
          await this.finalizeTerminalFailure(instance, error);
          return;
        }

        this.resources.allocate(instance.id, instance.resources);
        resourcesAllocated = true;

        const pid = await this.driver.spawn(instance);
        instance.pid = pid;
        const runEvent = transition(instance, "running", "Retry spawned");
        await this.registry.update(instance.id, {
          state: "running",
          pid,
          updatedAt: instance.updatedAt,
        });

        this.bus.emitLifecycle(runEvent);
        this.bus.emitSpawned(instance.id, pid);

        logActivity({
          source: "agent",
          summary: `Agent retry spawned: ${instance.metadata.label}`,
          detail: `Attempt ${instance.retryCount}/${instance.config.maxRetries}, PID ${pid}, instance ${instance.id}`,
        });

        if ("onExit" in this.driver && typeof this.driver.onExit === "function") {
          (this.driver as { onExit: (id: string, handler: (code: number | null) => void) => void })
            .onExit(instance.id, (code) => this.handleExit(instance.id, code));
        }
      } catch (err) {
        // Clean up on retry failure: release resources and fail the instance
        // to prevent zombie agents stuck in "initializing" forever
        if (resourcesAllocated) {
          this.resources.release(instance.id);
        }

        const error: AgentError = {
          code: ErrorCodes.SPAWN_FAILED,
          message: `Retry spawn failed: ${(err as Error).message}`,
          timestamp: new Date().toISOString(),
          recoverable: false,
        };
        instance.state = "failed";
        instance.error = error;
        instance.updatedAt = new Date().toISOString();
        await this.registry.update(instance.id, {
          state: "failed",
          error,
          updatedAt: instance.updatedAt,
        }).catch(() => {});

        logActivity({
          source: "agent",
          summary: `Agent retry spawn failed: ${instance.metadata.label}`,
          detail: `Attempt ${instance.retryCount}/${instance.config.maxRetries}: ${(err as Error).message}, instance ${instance.id}`,
        });
        await this.finalizeTerminalFailure(instance, error);
      }
    }, delay);
  }

  // -------------------------------------------------------------------------
  // Internal: recovery on startup
  // -------------------------------------------------------------------------

  private async recoverAgents(): Promise<void> {
    const instances = this.registry.listActive();

    // Skip recovery entirely when there's nothing to recover (cold start)
    if (instances.length === 0) {
      log.info("No active instances to recover");
      return;
    }

    let recovered = 0;
    let marked = 0;

    // Separate alive, dead, and initializing instances for parallel recovery
    const alive: AgentInstance[] = [];
    const dead: AgentInstance[] = [];
    const initializing: AgentInstance[] = [];

    for (const instance of instances) {
      if (instance.state === "running" || instance.state === "resuming") {
        if (this.driver.isAlive(instance)) {
          alive.push(instance);
        } else {
          dead.push(instance);
        }
      } else if (instance.state === "initializing") {
        initializing.push(instance);
      }
    }

    // Count alive agents (no I/O needed)
    recovered = alive.length;
    for (const instance of alive) {
      logActivity({
        source: "agent",
        summary: `Recovered running agent: ${instance.metadata.label}`,
        detail: `PID ${instance.pid} still alive`,
      });
    }

    // Recover dead agents in parallel (each reads task output)
    if (dead.length > 0) {
      marked += dead.length;
      await Promise.all(dead.map(async (instance) => {
        const output = await readTaskOutput(instance.taskId).catch(() => "");
        const hasOutput = output.trim().length > 0;
        const finalState = hasOutput ? "completed" : "failed";

        if (hasOutput) {
          transition(instance, "completed", "Recovered after restart");
        } else {
          const error: AgentError = {
            code: ErrorCodes.DRIVER_ERROR,
            message: "Process died while runtime was down",
            timestamp: new Date().toISOString(),
            recoverable: false,
          };
          transition(instance, "failed", "Died during downtime", error);
        }

        await this.registry.update(instance.id, {
          state: instance.state,
          error: instance.error,
          terminatedAt: instance.terminatedAt,
          updatedAt: instance.updatedAt,
        });

        logActivity({
          source: "agent",
          summary: `Recovered ${finalState} agent: ${instance.metadata.label}`,
          detail: `PID ${instance.pid} was dead`,
        });
      }));
    }

    // Recover initializing agents in parallel
    if (initializing.length > 0) {
      marked += initializing.length;
      await Promise.all(initializing.map(async (instance) => {
        const error: AgentError = {
          code: ErrorCodes.DRIVER_ERROR,
          message: "Runtime restarted during initialization",
          timestamp: new Date().toISOString(),
          recoverable: true,
        };
        transition(instance, "failed", "Runtime restarted", error);
        await this.registry.update(instance.id, {
          state: "failed",
          error,
          updatedAt: instance.updatedAt,
        });
        await this.maybeRetry(instance);
      }));
    }

    if (recovered > 0 || marked > 0) {
      logActivity({
        source: "agent",
        summary: `Runtime recovery: ${recovered} alive, ${marked} resolved`,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Internal: monitoring
  // -------------------------------------------------------------------------

  private startMonitor(): void {
    if (this.monitorTimer) return;

    this.monitorTimer = setInterval(() => {
      this.monitorCycle().catch((err) => {
        logActivity({
          source: "agent",
          summary: "Runtime monitor error",
          detail: (err as Error).message,
        });
      });
    }, this.config.monitorIntervalMs);
  }

  private stopMonitor(): void {
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }
  }

  private async monitorCycle(): Promise<void> {
    const running = this.registry.list({ state: "running" });

    for (const instance of running) {
      // Skip instances with pending retries or active handleExit processing
      // to prevent concurrent exit handling that causes duplicate retry scheduling
      if (this.retryPending.has(instance.id) || this.handleExitGuard.has(instance.id)) {
        continue;
      }

      if (!this.driver.isAlive(instance)) {
        // Process died without triggering exit handler (recovered PID)
        await this.handleExit(instance.id, null);
      }
    }

    // Emit resource warning if nearing capacity
    const snapshot = this.resources.snapshot();
    const agentRatio = snapshot.activeAgents / snapshot.maxAgents;
    const memoryRatio = snapshot.totalMemoryMB / snapshot.maxMemoryMB;

    if (agentRatio > 0.8 || memoryRatio > 0.8) {
      this.bus.emitResourceWarning(snapshot);
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private requireInstance(id: string): AgentInstance {
    const instance = this.registry.get(id);
    if (!instance) {
      throw new RuntimeError(
        ErrorCodes.AGENT_NOT_FOUND,
        `Agent instance not found: ${id}`,
      );
    }
    return instance;
  }

  private assertState(instance: AgentInstance, expected: string): void {
    if (instance.state !== expected) {
      throw new RuntimeError(
        ErrorCodes.INVALID_TRANSITION,
        `Expected agent state '${expected}', got '${instance.state}'`,
        false,
        { agentId: instance.id, actual: instance.state, expected },
      );
    }
  }

  /**
   * Detect deterministic failures that won't succeed on retry.
   * Checks output for patterns like TypeScript errors, missing modules, etc.
   * A broader pattern set prevents wasting retry budget on non-recoverable errors.
   */
  private isDeterministicFailure(output: string, code: number | null): boolean {
    // null exit code = signal/OOM — worth retrying
    if (code === null) return false;

    // Check output for patterns that indicate a deterministic failure
    const tail = output.slice(-3000);
    const deterministicPatterns = [
      /error TS\d+:/i,              // TypeScript compilation errors
      /SyntaxError:/,               // JS/TS syntax errors
      /Cannot find module/,         // Missing module (won't appear on retry)
      /Module not found/,           // Same
      /ENOENT.*no such file/i,      // Missing file
      /Permission denied/i,         // Permission issues (won't self-resolve)
      /EACCES/,                     // Access denied (filesystem)
      /ENOSPC/i,                    // Disk full
      /Invalid API key/i,           // Auth errors (won't self-resolve)
      /authentication failed/i,     // Auth errors
      /unauthorized/i,              // 401 errors
      /forbidden/i,                 // 403 errors
      / 402[:\s]/,                  // Payment required (insufficient credits)
      /insufficient.credits/i,      // OpenRouter credit exhaustion
      /payment.required/i,          // Billing errors
      /out of.*credits/i,           // Credit exhaustion variant
      /can'?t afford/i,             // OpenRouter "can't afford" message
      /ERR_INVALID_ARG_TYPE/,       // Programming error
      /TypeError:.*is not a function/, // Programming error
      /ReferenceError:/,            // Undefined variable
      /ENOMEM/i,                    // Out of memory (system-level)
    ];

    return deterministicPatterns.some((pattern) => pattern.test(tail));
  }

  private toAgentError(
    err: unknown,
    code: string,
    recoverable: boolean,
  ): AgentError {
    const message = err instanceof Error ? err.message : String(err);
    return {
      code,
      message,
      timestamp: new Date().toISOString(),
      recoverable,
    };
  }
}
