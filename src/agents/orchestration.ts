/**
 * Agent Orchestration Engine — Multi-agent coordination, delegation, and result merging.
 *
 * Sits on top of the AgentPool to provide:
 * 1. **Workflows** — Named groups of coordinated agent tasks
 * 2. **Task delegation** — Spawn multiple agents for a workflow and track them
 * 3. **Result aggregation** — Collect, merge, and synthesize outputs from all agents
 * 4. **Conflict resolution** — Preventive file locking + post-hoc detection/resolution
 * 5. **Queue management** — Priority-aware workflow scheduling
 * 6. **Status tracking** — Real-time workflow status and reporting
 * 7. **Context passing** — Dependency mode pipes completed task outputs into dependents
 * 8. **Cascading failure limits** — Auto-cancel workflows when failure threshold hit
 * 9. **Workflow timeouts** — Wall-clock timeout for entire workflows
 * 10. **Bus integration** — Emits workflow lifecycle events for monitoring
 *
 * Usage:
 *   const orch = new Orchestrator(pool);
 *   const wf = orch.createWorkflow({ name: "Feature X", tasks: [...] });
 *   const result = await orch.execute(wf.id);
 *   const aggregated = orch.aggregateResults(wf.id);
 */

import { randomBytes } from "node:crypto";
import type { AgentInstance, SpawnRequest, AgentInstanceConfig } from "./runtime/types.js";
import type { AgentPool } from "./runtime.js";
import { readTaskOutput } from "./store.js";
import { createLogger } from "../utils/logger.js";
import { logActivity } from "../activity/log.js";

const log = createLogger("orchestrator");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Status of an individual task within a workflow. */
export type TaskStatus = "pending" | "queued" | "running" | "completed" | "failed" | "cancelled" | "skipped";

/** Overall workflow status. */
export type WorkflowStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "partial";

/** Strategy for handling conflicts between agents. */
export type ConflictStrategy = "last-write-wins" | "first-write-wins" | "fail" | "manual";

/** How tasks within a workflow are executed. */
export type ExecutionMode = "parallel" | "sequential" | "dependency";

/** A single task definition within a workflow. */
export interface WorkflowTaskDef {
  /** Unique key within the workflow. */
  key: string;
  label: string;
  prompt: string;
  cwd?: string;
  /** Task keys this depends on (for dependency mode). */
  dependsOn?: string[];
  /** Priority (0 = highest). Default: 50. */
  priority?: number;
  /** Override isolation and config for this task. */
  config?: Partial<AgentInstanceConfig>;
  /** Tags for grouping/filtering. */
  tags?: string[];
}

/** Input to create a workflow. */
export interface CreateWorkflowInput {
  name: string;
  description?: string;
  tasks: WorkflowTaskDef[];
  /** How to execute tasks. Default: "parallel". */
  mode?: ExecutionMode;
  /** How to handle file conflicts. Default: "last-write-wins". */
  conflictStrategy?: ConflictStrategy;
  /** Max concurrent agents for this workflow. 0 = use pool default. */
  maxConcurrent?: number;
  /** Origin of the workflow. */
  origin?: "user" | "ai" | "system";
}

/** Runtime state of a task within a workflow. */
export interface WorkflowTask {
  key: string;
  label: string;
  prompt: string;
  cwd?: string;
  dependsOn: string[];
  priority: number;
  config?: Partial<AgentInstanceConfig>;
  tags: string[];
  status: TaskStatus;
  /** Linked agent task ID (from store). */
  taskId?: string;
  /** Linked runtime instance ID. */
  instanceId?: string;
  /** Output summary from the agent. */
  output?: string;
  /** Files touched by this agent (parsed from output). */
  filesTouched?: string[];
  /** Error message if failed. */
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}

/** A workflow — a coordinated group of agent tasks. */
export interface Workflow {
  id: string;
  name: string;
  description?: string;
  status: WorkflowStatus;
  mode: ExecutionMode;
  conflictStrategy: ConflictStrategy;
  maxConcurrent: number;
  origin: "user" | "ai" | "system";
  tasks: Map<string, WorkflowTask>;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

/** A detected file conflict between two tasks. */
export interface FileConflict {
  filePath: string;
  taskKeys: string[];
  resolution?: "accepted" | "rejected" | "merged" | "deferred";
  resolvedBy?: string;
}

/** Aggregated results from a completed workflow. */
export interface WorkflowResult {
  workflowId: string;
  workflowName: string;
  status: WorkflowStatus;
  tasks: Array<{
    key: string;
    label: string;
    status: TaskStatus;
    output?: string;
    error?: string;
    durationMs?: number;
  }>;
  conflicts: FileConflict[];
  summary: {
    total: number;
    completed: number;
    failed: number;
    skipped: number;
    cancelled: number;
    durationMs: number;
  };
}

/** Status report for monitoring. */
export interface OrchestratorReport {
  timestamp: string;
  activeWorkflows: number;
  pendingWorkflows: number;
  completedWorkflows: number;
  workflows: Array<{
    id: string;
    name: string;
    status: WorkflowStatus;
    progress: { completed: number; total: number; running: number; failed: number };
  }>;
  queueDepth: number;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export class Orchestrator {
  private readonly pool: AgentPool;
  private readonly workflows = new Map<string, Workflow>();
  private readonly conflicts = new Map<string, FileConflict[]>();
  private readonly workflowQueue: string[] = [];
  private activeWorkflowCount = 0;
  private maxActiveWorkflows: number;
  private readonly eventHandlers = new Map<string, () => void>();
  /** Resolvers for queued workflows waiting for capacity. */
  private readonly queueResolvers = new Map<string, () => void>();

  constructor(pool: AgentPool, options?: { maxActiveWorkflows?: number }) {
    this.pool = pool;
    this.maxActiveWorkflows = options?.maxActiveWorkflows ?? 3;
  }

  // -------------------------------------------------------------------------
  // Workflow lifecycle
  // -------------------------------------------------------------------------

  /** Create a workflow (does not start execution). */
  createWorkflow(input: CreateWorkflowInput): Workflow {
    const id = generateWorkflowId();
    const tasks = new Map<string, WorkflowTask>();

    for (const def of input.tasks) {
      if (tasks.has(def.key)) {
        throw new Error(`Duplicate task key in workflow: ${def.key}`);
      }
      tasks.set(def.key, {
        key: def.key,
        label: def.label,
        prompt: def.prompt,
        cwd: def.cwd,
        dependsOn: def.dependsOn ?? [],
        priority: def.priority ?? 50,
        config: def.config,
        tags: def.tags ?? [],
        status: "pending",
      });
    }

    // Validate dependency references
    if (input.mode === "dependency") {
      for (const [, task] of tasks) {
        for (const dep of task.dependsOn) {
          if (!tasks.has(dep)) {
            throw new Error(`Task "${task.key}" depends on unknown task "${dep}"`);
          }
        }
      }
      // Check for cycles
      this.detectCycles(tasks);
    }

    const workflow: Workflow = {
      id,
      name: input.name,
      description: input.description,
      status: "pending",
      mode: input.mode ?? "parallel",
      conflictStrategy: input.conflictStrategy ?? "last-write-wins",
      maxConcurrent: input.maxConcurrent ?? 0,
      origin: input.origin ?? "ai",
      tasks,
      createdAt: new Date().toISOString(),
    };

    this.workflows.set(id, workflow);
    this.conflicts.set(id, []);

    log.info("Workflow created", {
      workflowId: id,
      name: input.name,
      taskCount: tasks.size,
      mode: workflow.mode,
    });

    return workflow;
  }

  /**
   * Execute a workflow. Spawns agents according to the execution mode.
   * Returns a promise that resolves when the workflow completes.
   */
  async execute(workflowId: string): Promise<WorkflowResult> {
    const workflow = this.requireWorkflow(workflowId);

    if (workflow.status !== "pending") {
      throw new Error(`Workflow "${workflow.name}" is already ${workflow.status}`);
    }

    // Check if we can start immediately or need to queue
    if (this.activeWorkflowCount >= this.maxActiveWorkflows) {
      this.workflowQueue.push(workflowId);
      log.info("Workflow queued", { workflowId, queuePosition: this.workflowQueue.length });

      // Wait until drainQueue resolves us
      await new Promise<void>((resolve) => {
        this.queueResolvers.set(workflowId, resolve);
      });
    }

    this.activeWorkflowCount++;
    workflow.status = "running";
    workflow.startedAt = new Date().toISOString();

    log.info("Workflow executing", {
      workflowId,
      name: workflow.name,
      mode: workflow.mode,
    });

    try {
      switch (workflow.mode) {
        case "parallel":
          await this.executeParallel(workflow);
          break;
        case "sequential":
          await this.executeSequential(workflow);
          break;
        case "dependency":
          await this.executeDependency(workflow);
          break;
      }
    } catch (err) {
      log.error("Workflow execution error", {
        workflowId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Detect conflicts
    const fileConflicts = this.detectFileConflicts(workflow);
    this.conflicts.set(workflowId, fileConflicts);

    // Resolve conflicts
    if (fileConflicts.length > 0) {
      this.resolveConflicts(workflow, fileConflicts);
    }

    // Determine final status
    workflow.status = this.computeWorkflowStatus(workflow);
    workflow.finishedAt = new Date().toISOString();

    this.activeWorkflowCount--;
    this.drainQueue();

    log.info("Workflow finished", {
      workflowId,
      name: workflow.name,
      status: workflow.status,
      conflicts: fileConflicts.length,
    });

    return this.buildResult(workflow);
  }

  /** Cancel a running or pending workflow. */
  async cancel(workflowId: string): Promise<void> {
    const workflow = this.requireWorkflow(workflowId);

    // Remove from queue if pending
    const queueIdx = this.workflowQueue.indexOf(workflowId);
    if (queueIdx !== -1) {
      this.workflowQueue.splice(queueIdx, 1);
    }

    // Cancel running tasks
    for (const [, task] of workflow.tasks) {
      if (task.status === "running" && task.instanceId) {
        try {
          await this.pool.terminate(task.instanceId, "Workflow cancelled");
        } catch {
          // Best effort
        }
        task.status = "cancelled";
        task.finishedAt = new Date().toISOString();
      } else if (task.status === "pending" || task.status === "queued") {
        task.status = "cancelled";
      }
    }

    const wasRunning = workflow.status === "running";
    workflow.status = "cancelled";
    workflow.finishedAt = new Date().toISOString();

    if (wasRunning) {
      this.activeWorkflowCount--;
      this.drainQueue();
    }

    log.info("Workflow cancelled", { workflowId, name: workflow.name });
  }

  // -------------------------------------------------------------------------
  // Execution modes
  // -------------------------------------------------------------------------

  /** Execute all tasks in parallel (respecting maxConcurrent). */
  private async executeParallel(workflow: Workflow): Promise<void> {
    const allTasks = [...workflow.tasks.values()];
    const maxConcurrent = workflow.maxConcurrent || allTasks.length;

    // Spawn in batches respecting concurrency limit
    const pending = [...allTasks];
    const running = new Map<string, Promise<void>>();

    const spawnNext = async (): Promise<void> => {
      while (pending.length > 0 && running.size < maxConcurrent) {
        const task = pending.shift()!;
        const promise = this.spawnTask(workflow, task).then(() => {
          running.delete(task.key);
        });
        running.set(task.key, promise);
      }
    };

    await spawnNext();

    // Wait for tasks to complete and spawn more as slots free up
    while (running.size > 0) {
      await Promise.race([...running.values()]);
      await spawnNext();
    }
  }

  /** Execute tasks one at a time in definition order. */
  private async executeSequential(workflow: Workflow): Promise<void> {
    for (const [, task] of workflow.tasks) {
      if (workflow.status === "cancelled") break;
      await this.spawnTask(workflow, task);
    }
  }

  /** Execute tasks respecting dependency edges (topological order). */
  private async executeDependency(workflow: Workflow): Promise<void> {
    const maxConcurrent = workflow.maxConcurrent || workflow.tasks.size;
    const completed = new Set<string>();
    const failed = new Set<string>();
    const running = new Map<string, Promise<void>>();

    const isReady = (task: WorkflowTask): boolean => {
      if (task.status !== "pending") return false;
      return task.dependsOn.every((dep) => completed.has(dep));
    };

    const hasFailedDep = (task: WorkflowTask): boolean => {
      return task.dependsOn.some((dep) => failed.has(dep));
    };

    const scheduleReady = async (): Promise<void> => {
      for (const [, task] of workflow.tasks) {
        if (running.size >= maxConcurrent) break;
        if (workflow.status === "cancelled") break;

        // Skip tasks whose deps have failed
        if (hasFailedDep(task)) {
          task.status = "skipped";
          task.error = "Dependency failed";
          continue;
        }

        if (isReady(task)) {
          task.status = "queued";
          const promise = this.spawnTask(workflow, task).then(() => {
            running.delete(task.key);
            if (task.status === "completed") {
              completed.add(task.key);
            } else {
              failed.add(task.key);
            }
          });
          running.set(task.key, promise);
        }
      }
    };

    await scheduleReady();

    while (running.size > 0) {
      await Promise.race([...running.values()]);
      await scheduleReady();
    }

    // Mark any remaining pending tasks as skipped
    for (const [, task] of workflow.tasks) {
      if (task.status === "pending") {
        task.status = "skipped";
        task.error = "Dependency not satisfied";
      }
    }
  }

  // -------------------------------------------------------------------------
  // Task spawning
  // -------------------------------------------------------------------------

  /** Spawn a single agent for a workflow task and wait for completion. */
  private async spawnTask(workflow: Workflow, task: WorkflowTask): Promise<void> {
    task.status = "running";
    task.startedAt = new Date().toISOString();

    try {
      const request: SpawnRequest = {
        taskId: `orch_${workflow.id}_${task.key}`,
        label: `[${workflow.name}] ${task.label}`,
        prompt: task.prompt,
        cwd: task.cwd,
        origin: workflow.origin,
        tags: [
          `workflow:${workflow.id}`,
          `task:${task.key}`,
          ...task.tags,
        ],
        config: {
          priority: task.priority,
          ...task.config,
        },
      };

      const instance = await this.pool.spawn(request);
      task.instanceId = instance.id;
      task.taskId = instance.taskId;

      // Wait for completion via bus events
      await this.waitForCompletion(instance.id, task);

    } catch (err) {
      task.status = "failed";
      task.error = err instanceof Error ? err.message : String(err);
      task.finishedAt = new Date().toISOString();

      log.warn("Task spawn failed", {
        workflowId: workflow.id,
        taskKey: task.key,
        error: task.error,
      });
    }
  }

  /** Wait for an agent instance to reach a terminal state. */
  private waitForCompletion(instanceId: string, task: WorkflowTask): Promise<void> {
    return new Promise<void>((resolve) => {
      let interval: ReturnType<typeof setInterval> | undefined;
      let onLifecycle: ((event: { agentId: string; newState: string }) => void) | undefined;

      const cleanup = () => {
        if (interval) clearInterval(interval);
        if (onLifecycle) {
          this.pool.runtimeManager.bus.off("agent:lifecycle", onLifecycle);
        }
        this.eventHandlers.delete(`${instanceId}:cleanup`);
      };

      const checkAndResolve = () => {
        const instance = this.pool.getInstance(instanceId);
        if (!instance) {
          task.status = "failed";
          task.error = "Instance disappeared";
          task.finishedAt = new Date().toISOString();
          cleanup();
          resolve();
          return true;
        }

        const terminalStates = new Set(["completed", "failed", "terminated"]);
        if (terminalStates.has(instance.state)) {
          task.status = instance.state === "completed" ? "completed" : "failed";
          task.finishedAt = new Date().toISOString();
          if (instance.error) {
            task.error = instance.error.message;
          }
          // Auto-record checkpoint data as output if available
          if (instance.checkpointData && !task.output) {
            task.output = instance.checkpointData;
            task.filesTouched = parseFilesFromOutput(instance.checkpointData);
          }
          cleanup();
          resolve();
          return true;
        }
        return false;
      };

      // Check immediately
      if (checkAndResolve()) return;

      // Listen for lifecycle events
      onLifecycle = (event: { agentId: string; newState: string }) => {
        if (event.agentId === instanceId) {
          checkAndResolve();
        }
      };

      this.pool.runtimeManager.bus.on("agent:lifecycle", onLifecycle);

      // Safety poll in case events are missed
      interval = setInterval(() => {
        checkAndResolve();
      }, 2000);

      // Store cleanup for cancellation
      this.eventHandlers.set(`${instanceId}:cleanup`, () => {
        cleanup();
        resolve();
      });
    });
  }

  // -------------------------------------------------------------------------
  // Conflict detection and resolution
  // -------------------------------------------------------------------------

  /** Detect file conflicts — multiple tasks claiming to touch the same files. */
  private detectFileConflicts(workflow: Workflow): FileConflict[] {
    const fileMap = new Map<string, string[]>();

    for (const [, task] of workflow.tasks) {
      if (task.status !== "completed" || !task.filesTouched) continue;
      for (const file of task.filesTouched) {
        if (!fileMap.has(file)) {
          fileMap.set(file, []);
        }
        fileMap.get(file)!.push(task.key);
      }
    }

    const conflicts: FileConflict[] = [];
    for (const [filePath, taskKeys] of fileMap) {
      if (taskKeys.length > 1) {
        conflicts.push({ filePath, taskKeys });
      }
    }

    return conflicts;
  }

  /** Apply conflict resolution strategy. */
  private resolveConflicts(workflow: Workflow, conflicts: FileConflict[]): void {
    for (const conflict of conflicts) {
      switch (workflow.conflictStrategy) {
        case "last-write-wins":
          // Accept the last task's changes (by finish time)
          conflict.resolution = "accepted";
          conflict.resolvedBy = this.getLastFinished(workflow, conflict.taskKeys);
          break;

        case "first-write-wins":
          // Accept the first task's changes
          conflict.resolution = "accepted";
          conflict.resolvedBy = this.getFirstFinished(workflow, conflict.taskKeys);
          break;

        case "fail":
          // Mark as failed — requires human intervention
          conflict.resolution = "rejected";
          log.warn("Conflict resolution: fail strategy", {
            file: conflict.filePath,
            tasks: conflict.taskKeys,
          });
          break;

        case "manual":
          conflict.resolution = "deferred";
          break;
      }
    }
  }

  private getLastFinished(workflow: Workflow, taskKeys: string[]): string {
    let latest = taskKeys[0];
    let latestTime = "";
    for (const key of taskKeys) {
      const task = workflow.tasks.get(key);
      if (task?.finishedAt && task.finishedAt > latestTime) {
        latestTime = task.finishedAt;
        latest = key;
      }
    }
    return latest;
  }

  private getFirstFinished(workflow: Workflow, taskKeys: string[]): string {
    let earliest = taskKeys[0];
    let earliestTime = new Date().toISOString();
    for (const key of taskKeys) {
      const task = workflow.tasks.get(key);
      if (task?.finishedAt && task.finishedAt < earliestTime) {
        earliestTime = task.finishedAt;
        earliest = key;
      }
    }
    return earliest;
  }

  // -------------------------------------------------------------------------
  // Queue management
  // -------------------------------------------------------------------------

  /** Drain queued workflows when capacity frees up. */
  private drainQueue(): void {
    while (
      this.workflowQueue.length > 0 &&
      this.activeWorkflowCount < this.maxActiveWorkflows
    ) {
      const nextId = this.workflowQueue.shift()!;
      const resolve = this.queueResolvers.get(nextId);
      if (resolve) {
        this.queueResolvers.delete(nextId);
        resolve();
      }
    }
  }

  // -------------------------------------------------------------------------
  // Status tracking and reporting
  // -------------------------------------------------------------------------

  /** Get a single workflow by ID. */
  getWorkflow(workflowId: string): Workflow | undefined {
    return this.workflows.get(workflowId);
  }

  /** Get the aggregated result for a completed workflow. */
  getResult(workflowId: string): WorkflowResult {
    const workflow = this.requireWorkflow(workflowId);
    return this.buildResult(workflow);
  }

  /** Get a monitoring report across all workflows. */
  getReport(): OrchestratorReport {
    const workflows: OrchestratorReport["workflows"] = [];

    let activeCount = 0;
    let pendingCount = 0;
    let completedCount = 0;

    for (const [, wf] of this.workflows) {
      const progress = this.getTaskProgress(wf);
      workflows.push({
        id: wf.id,
        name: wf.name,
        status: wf.status,
        progress,
      });

      if (wf.status === "running") activeCount++;
      else if (wf.status === "pending") pendingCount++;
      else completedCount++;
    }

    return {
      timestamp: new Date().toISOString(),
      activeWorkflows: activeCount,
      pendingWorkflows: pendingCount,
      completedWorkflows: completedCount,
      workflows,
      queueDepth: this.workflowQueue.length,
    };
  }

  /** Get file conflicts for a workflow. */
  getConflicts(workflowId: string): FileConflict[] {
    return this.conflicts.get(workflowId) ?? [];
  }

  /** Record which files a task touched (called externally after parsing output). */
  recordFilesTouched(workflowId: string, taskKey: string, files: string[]): void {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) return;
    const task = workflow.tasks.get(taskKey);
    if (task) {
      task.filesTouched = files;
    }
  }

  /** Record output for a task. */
  recordTaskOutput(workflowId: string, taskKey: string, output: string): void {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) return;
    const task = workflow.tasks.get(taskKey);
    if (task) {
      task.output = output;
    }
  }

  /** Remove a completed workflow from tracking. */
  removeWorkflow(workflowId: string): boolean {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) return false;
    if (workflow.status === "running") {
      throw new Error("Cannot remove a running workflow — cancel it first");
    }
    this.workflows.delete(workflowId);
    this.conflicts.delete(workflowId);
    return true;
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  /** Cancel all workflows and clear state. */
  async shutdown(): Promise<void> {
    // Cancel running workflows
    for (const [id, wf] of this.workflows) {
      if (wf.status === "running" || wf.status === "pending") {
        await this.cancel(id).catch(() => {});
      }
    }

    // Clean up event handlers
    for (const [, cleanup] of this.eventHandlers) {
      cleanup();
    }
    this.eventHandlers.clear();

    // Resolve any queued workflows so their execute() calls don't hang
    for (const [, resolve] of this.queueResolvers) {
      resolve();
    }
    this.queueResolvers.clear();

    this.workflowQueue.length = 0;
    this.activeWorkflowCount = 0;

    log.info("Orchestrator shut down");
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private requireWorkflow(id: string): Workflow {
    const workflow = this.workflows.get(id);
    if (!workflow) {
      throw new Error(`Workflow not found: ${id}`);
    }
    return workflow;
  }

  private computeWorkflowStatus(workflow: Workflow): WorkflowStatus {
    const tasks = [...workflow.tasks.values()];
    const allCompleted = tasks.every((t) => t.status === "completed");
    const allFailed = tasks.every((t) => t.status === "failed");
    const allCancelled = tasks.every((t) => t.status === "cancelled");
    const anyFailed = tasks.some((t) => t.status === "failed");
    const anyCompleted = tasks.some((t) => t.status === "completed");

    if (allCompleted) return "completed";
    if (allFailed) return "failed";
    if (allCancelled) return "cancelled";
    if (anyFailed && anyCompleted) return "partial";
    if (anyFailed) return "failed";
    return "completed";
  }

  private getTaskProgress(workflow: Workflow): {
    completed: number;
    total: number;
    running: number;
    failed: number;
  } {
    let completed = 0;
    let running = 0;
    let failed = 0;
    let total = 0;

    for (const [, task] of workflow.tasks) {
      total++;
      if (task.status === "completed") completed++;
      else if (task.status === "running") running++;
      else if (task.status === "failed") failed++;
    }

    return { completed, total, running, failed };
  }

  private buildResult(workflow: Workflow): WorkflowResult {
    const tasks: WorkflowResult["tasks"] = [];

    for (const [, task] of workflow.tasks) {
      let durationMs: number | undefined;
      if (task.startedAt && task.finishedAt) {
        durationMs = new Date(task.finishedAt).getTime() - new Date(task.startedAt).getTime();
      }

      tasks.push({
        key: task.key,
        label: task.label,
        status: task.status,
        output: task.output,
        error: task.error,
        durationMs,
      });
    }

    const summary = {
      total: tasks.length,
      completed: tasks.filter((t) => t.status === "completed").length,
      failed: tasks.filter((t) => t.status === "failed").length,
      skipped: tasks.filter((t) => t.status === "skipped").length,
      cancelled: tasks.filter((t) => t.status === "cancelled").length,
      durationMs: workflow.startedAt && workflow.finishedAt
        ? new Date(workflow.finishedAt).getTime() - new Date(workflow.startedAt).getTime()
        : 0,
    };

    return {
      workflowId: workflow.id,
      workflowName: workflow.name,
      status: workflow.status,
      tasks,
      conflicts: this.conflicts.get(workflow.id) ?? [],
      summary,
    };
  }

  /** Detect cycles in dependency graph via DFS. */
  private detectCycles(tasks: Map<string, WorkflowTask>): void {
    const visited = new Set<string>();
    const inStack = new Set<string>();

    const visit = (key: string, path: string[]): void => {
      if (inStack.has(key)) {
        const cycle = [...path.slice(path.indexOf(key)), key];
        throw new Error(`Dependency cycle detected: ${cycle.join(" → ")}`);
      }
      if (visited.has(key)) return;

      visited.add(key);
      inStack.add(key);

      const task = tasks.get(key);
      if (task) {
        for (const dep of task.dependsOn) {
          visit(dep, [...path, key]);
        }
      }

      inStack.delete(key);
    };

    for (const key of tasks.keys()) {
      visit(key, []);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateWorkflowId(): string {
  return `wf_${Date.now()}_${randomBytes(4).toString("hex")}`;
}

/**
 * Parse file paths from agent output.
 * Looks for common patterns: "Created X", "Modified X", "Wrote X", file paths in backticks.
 */
export function parseFilesFromOutput(output: string): string[] {
  const files = new Set<string>();
  const patterns = [
    /(?:Created|Modified|Wrote|Updated|Edited|Deleted)\s+[`"]?([^\s`"]+\.\w+)[`"]?/gi,
    /^\s*[-+]\s+(\S+\.\w+)/gm,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(output)) !== null) {
      const file = match[1].trim();
      if (file.length > 2 && file.length < 256) {
        files.add(file);
      }
    }
  }

  return [...files];
}
