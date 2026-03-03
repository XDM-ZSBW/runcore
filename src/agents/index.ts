export type { AgentTask, AgentTaskStatus, CreateTaskInput } from "./types.js";
export type { GcMetrics, GcPhaseTiming } from "./instance-manager.js";
export {
  ensureDirs,
  createTask,
  readTask,
  listTasks,
  updateTask,
  readTaskOutput,
} from "./store.js";
export { cancelAgent, setOnBatchComplete, setAgentPool, hasAgentPool, isAgentsBusy, activeAgentCount } from "./spawn.js";
export { recoverTasks, startAgentMonitor, stopAgentMonitor } from "./monitor.js";
export {
  acquireLocks,
  releaseLocks,
  releaseFileLock,
  forceReleaseLock,
  listLocks,
  checkLocks,
  getLocksForAgent,
  pruneAllStaleLocks,
  type FileLock,
  type LockConflict,
  type AcquireResult,
} from "./locks.js";
export {
  Orchestrator,
  parseFilesFromOutput,
  type WorkflowTaskDef,
  type CreateWorkflowInput,
  type Workflow,
  type WorkflowTask,
  type WorkflowResult,
  type WorkflowStatus,
  type TaskStatus,
  type FileConflict,
  type ConflictStrategy,
  type ExecutionMode,
  type OrchestratorReport,
} from "./orchestration.js";
export {
  TaskCooldownManager,
  type CooldownConfig,
  type CooldownEntry,
  type CooldownStatus,
} from "./cooldown.js";
export {
  WorkflowEngine,
  parseWorkflowFile,
  type WorkflowDefinition,
  type StepDef,
  type Condition,
  type FailurePolicy,
  type WorkflowRun,
  type StepResult,
  type StepStatus,
} from "./workflow.js";

import type { CreateTaskInput, AgentTask } from "./types.js";
import { ensureDirs, createTask, readTask, listTasks as listAllTasks, readTaskOutput } from "./store.js";
import { spawnAgent, cancelAgent, setAgentPool } from "./spawn.js";
import { recoverTasks, startAgentMonitor, stopAgentMonitor } from "./monitor.js";

/** Create a task and immediately spawn it. */
export async function submitTask(input: CreateTaskInput): Promise<AgentTask> {
  const task = await createTask(input);
  await spawnAgent(task);
  return task;
}

/** Get a single task by ID. */
export async function getTask(id: string): Promise<AgentTask | null> {
  return readTask(id);
}

/** Get task output (stdout log). */
export async function getTaskOutput(id: string): Promise<string> {
  return readTaskOutput(id);
}

/** Cancel a running task. */
export async function cancelTask(id: string): Promise<boolean> {
  return cancelAgent(id);
}

/**
 * Initialize: ensure directories exist.
 * Does NOT run recovery — call recoverAndStartMonitor() after the
 * RuntimeManager is initialized so the monitor can skip tasks it manages.
 */
export async function initAgents(): Promise<void> {
  await ensureDirs();
}

/**
 * Recover tasks from previous session and start the monitor poll loop.
 * Must be called AFTER createRuntime() so recoverTasks() can check the
 * runtime registry and skip tasks that RuntimeManager already handles.
 * This prevents the double-recovery race that caused DASH-82.
 */
export async function recoverAndStartMonitor(): Promise<void> {
  await recoverTasks();
  startAgentMonitor();
}

/** Shutdown: stop the monitor. Does NOT kill detached processes. */
export function shutdownAgents(): void {
  stopAgentMonitor();
}
