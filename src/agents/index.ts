/**
 * Agent system — public API surface.
 *
 * Local tier: types, store (task CRUD), submitTask/getTask/cancelTask.
 * Spawn tier: locks, orchestration, workflow, governance, heartbeat, etc.
 * Spawn-tier re-exports are accessed via dynamic import of this module
 * from server.ts — they won't load on local tier (the .js files are stripped).
 */

export type { AgentTask, AgentTaskStatus, CreateTaskInput, SelfReportedIssue } from "./types.js";
export {
  ensureDirs,
  createTask,
  readTask,
  listTasks,
  updateTask,
  readTaskOutput,
} from "./store.js";

// Spawn-tier modules — dynamic import only. Server.ts loads these via
// `await import("./agents/spawn.js")` etc. behind tier checks.
// Type re-exports are safe (zero runtime cost):
export type { GcMetrics, GcPhaseTiming } from "./instance-manager.js";

import type { CreateTaskInput, AgentTask } from "./types.js";
import { ensureDirs, createTask, readTaskOutput, readTask } from "./store.js";

// Lazy-loaded spawn-tier modules
let _spawn: typeof import("./spawn.js") | null = null;
let _monitor: typeof import("./monitor.js") | null = null;
let _heartbeat: typeof import("./heartbeat.js") | null = null;

async function getSpawn() {
  if (!_spawn) { try { _spawn = await import("./spawn.js"); } catch { _spawn = null; } }
  return _spawn;
}
async function getMonitor() {
  if (!_monitor) { try { _monitor = await import("./monitor.js"); } catch { _monitor = null; } }
  return _monitor;
}
async function getHeartbeat() {
  if (!_heartbeat) { try { _heartbeat = await import("./heartbeat.js"); } catch { _heartbeat = null; } }
  return _heartbeat;
}

/** Create a task and immediately spawn it. */
export async function submitTask(input: CreateTaskInput): Promise<AgentTask> {
  const task = await createTask(input);
  const spawn = await getSpawn();
  if (spawn) {
    await spawn.spawnAgent(task);
  }
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
  const spawn = await getSpawn();
  return spawn ? spawn.cancelAgent(id) : false;
}

/** Wire batch completion callback. */
export async function setOnBatchComplete(
  cb: (sessionId: string, results: Array<{ label: string; status: string }>) => void
): Promise<void> {
  const spawn = await getSpawn();
  if (spawn) spawn.setOnBatchComplete(cb);
}

/** Set the agent pool reference. */
export async function setAgentPool(pool: unknown): Promise<void> {
  const spawn = await getSpawn();
  if (spawn) spawn.setAgentPool(pool as any);
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
 */
export async function recoverAndStartMonitor(): Promise<void> {
  const monitor = await getMonitor();
  if (monitor) {
    await monitor.recoverTasks();
    monitor.startAgentMonitor();
  }
}

/** Shutdown: stop the monitor and heartbeat trackers. */
export function shutdownAgents(): void {
  // These are fire-and-forget — if modules aren't loaded, nothing to shut down
  if (_monitor) _monitor.stopAgentMonitor();
  if (_heartbeat) _heartbeat.shutdownHeartbeats();
}
