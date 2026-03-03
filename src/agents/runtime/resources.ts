/**
 * Agent Runtime Environment — Resource allocation and tracking.
 *
 * Tracks aggregate resource usage across all active agents.
 * Enforces limits on concurrent agents and total memory.
 * Queues spawn requests when resources are exhausted.
 */

import type {
  AgentInstance,
  ResourceAllocation,
  ResourceSnapshot,
  RuntimeConfig,
  SpawnRequest,
} from "./types.js";
import { RuntimeError, ErrorCodes } from "./errors.js";

// ---------------------------------------------------------------------------
// Resource pool
// ---------------------------------------------------------------------------

export class ResourcePool {
  private readonly config: RuntimeConfig;

  /** Active agent allocations, keyed by agent ID. */
  private allocations = new Map<string, ResourceAllocation>();

  /** Queued spawn requests waiting for resources, ordered by priority. */
  private waitQueue: Array<{
    request: SpawnRequest;
    resolve: (value: void) => void;
    reject: (reason: unknown) => void;
    priority: number;
    enqueuedAt: string;
  }> = [];

  constructor(config: RuntimeConfig) {
    this.config = config;
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /** Current number of active agent allocations. */
  get activeCount(): number {
    return this.allocations.size;
  }

  /** Number of queued requests. */
  get queueLength(): number {
    return this.waitQueue.length;
  }

  /** Total memory currently allocated. */
  get totalMemoryMB(): number {
    let total = 0;
    for (const alloc of this.allocations.values()) {
      total += alloc.memoryLimitMB;
    }
    return total;
  }

  /** Snapshot of current resource usage. */
  snapshot(): ResourceSnapshot {
    return {
      activeAgents: this.activeCount,
      maxAgents: this.config.maxConcurrentAgents,
      totalMemoryMB: this.totalMemoryMB,
      maxMemoryMB: this.config.maxTotalMemoryMB,
      queuedRequests: this.queueLength,
    };
  }

  // -------------------------------------------------------------------------
  // Allocation
  // -------------------------------------------------------------------------

  /** Check if resources are available for a given allocation. */
  canAllocate(resources: ResourceAllocation): boolean {
    if (this.activeCount >= this.config.maxConcurrentAgents) return false;
    if (this.totalMemoryMB + resources.memoryLimitMB > this.config.maxTotalMemoryMB) return false;
    return true;
  }

  /**
   * Reserve resources for an agent. Throws if limits exceeded.
   * Call this immediately before spawning.
   */
  allocate(agentId: string, resources: ResourceAllocation): void {
    if (this.allocations.has(agentId)) {
      throw new RuntimeError(
        ErrorCodes.RESOURCE_EXHAUSTED,
        `Agent ${agentId} already has resources allocated`,
        false,
      );
    }

    if (this.activeCount >= this.config.maxConcurrentAgents) {
      throw new RuntimeError(
        ErrorCodes.MAX_AGENTS_REACHED,
        `Cannot allocate: ${this.activeCount}/${this.config.maxConcurrentAgents} agents active`,
        true,
        { activeCount: this.activeCount, max: this.config.maxConcurrentAgents },
      );
    }

    if (this.totalMemoryMB + resources.memoryLimitMB > this.config.maxTotalMemoryMB) {
      throw new RuntimeError(
        ErrorCodes.MEMORY_LIMIT_EXCEEDED,
        `Cannot allocate ${resources.memoryLimitMB}MB: ${this.totalMemoryMB}/${this.config.maxTotalMemoryMB}MB used`,
        true,
        { requested: resources.memoryLimitMB, used: this.totalMemoryMB, max: this.config.maxTotalMemoryMB },
      );
    }

    this.allocations.set(agentId, { ...resources });
  }

  /** Release resources when an agent terminates. Drains the wait queue if possible. */
  release(agentId: string): void {
    this.allocations.delete(agentId);
    this.drainQueue();
  }

  /** Update an existing allocation (e.g., after resize). */
  updateAllocation(agentId: string, resources: Partial<ResourceAllocation>): void {
    const current = this.allocations.get(agentId);
    if (!current) return;

    if (resources.memoryLimitMB != null) current.memoryLimitMB = resources.memoryLimitMB;
    if (resources.cpuWeight != null) current.cpuWeight = resources.cpuWeight;
  }

  /** Get the allocation for a specific agent. */
  getAllocation(agentId: string): ResourceAllocation | undefined {
    return this.allocations.get(agentId);
  }

  // -------------------------------------------------------------------------
  // Wait queue
  // -------------------------------------------------------------------------

  /**
   * Enqueue a spawn request to wait for resources.
   * Returns a promise that resolves when resources become available.
   */
  enqueue(request: SpawnRequest, priority: number = 50): Promise<void> {
    return new Promise((resolve, reject) => {
      this.waitQueue.push({
        request,
        resolve,
        reject,
        priority,
        enqueuedAt: new Date().toISOString(),
      });

      // Sort by priority (lower number = higher priority)
      this.waitQueue.sort((a, b) => a.priority - b.priority);
    });
  }

  /** Reject all queued requests (e.g., on shutdown). */
  rejectAll(reason: string): void {
    for (const entry of this.waitQueue) {
      entry.reject(
        new RuntimeError(ErrorCodes.SHUTDOWN_IN_PROGRESS, reason, false),
      );
    }
    this.waitQueue = [];
  }

  /** Drain the queue: resolve as many waiting requests as capacity allows. */
  private drainQueue(): void {
    while (this.waitQueue.length > 0) {
      const next = this.waitQueue[0];
      const resources: ResourceAllocation = {
        memoryLimitMB: this.config.defaultMemoryLimitMB,
        cpuWeight: this.config.defaultCpuWeight,
      };

      if (!this.canAllocate(resources)) break;

      this.waitQueue.shift();
      next.resolve();
    }
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  /** Clear all allocations and queued requests. For shutdown. */
  clear(): void {
    this.allocations.clear();
    this.rejectAll("Resource pool cleared");
  }
}
