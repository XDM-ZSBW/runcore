/**
 * Google Tasks integration facade — single entry point for the HUMAN's
 * personal task management via Google Tasks.
 *
 * Consolidates: Google OAuth auth, CRUD operations, recurring tasks,
 * polling timer, notification integration, and lifecycle management.
 *
 * This is separate from Core's internal queue — it's for the human's
 * personal tasks and reminders.
 *
 * Usage:
 *   import { initGoogleTasks, shutdownGoogleTasks, getGoogleTasksStatus } from "./integrations/google-tasks.js";
 *   // At startup:
 *   initGoogleTasks();
 *   // In routes / agent code:
 *   const status = await getGoogleTasksStatus();
 *   if (status.available) { ... }
 */

import {
  isGoogleConfigured,
  isGoogleAuthenticated,
  getAuthUrl,
  exchangeCode,
  clearTokenCache,
} from "../google/auth.js";
import {
  isTasksAvailable,
  listTaskLists,
  createTaskList,
  updateTaskList,
  deleteTaskList,
  listTasks,
  getTask,
  createTask,
  updateTask,
  completeTask,
  uncompleteTask,
  deleteTask,
  createRecurringWeeklyTasks,
  formatTasksForContext,
} from "../google/tasks.js";
import type { TaskList, Task, RecurringTaskConfig } from "../google/tasks.js";
import {
  startTasksTimer,
  stopTasksTimer,
  isTasksTimerRunning,
} from "../google/tasks-timer.js";
import { pushNotification } from "../goals/notifications.js";
import { logActivity } from "../activity/log.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("integration.google-tasks");

// ─── Lifecycle ───────────────────────────────────────────────────────────────

let initialized = false;

/**
 * Initialize the Google Tasks integration.
 * Starts the background polling timer for due-task notifications.
 * Safe to call multiple times — second call is a no-op.
 */
export function initGoogleTasks(pollIntervalMs?: number): void {
  if (initialized) return;
  initialized = true;

  if (isGoogleAuthenticated()) {
    startTasksTimer(pollIntervalMs);
    logActivity({ source: "tasks", summary: "Google Tasks integration initialized" });
    log.info("Google Tasks integration initialized");
  } else {
    log.warn("Google Tasks not authenticated — timer not started");
    logActivity({
      source: "tasks",
      summary: "Google Tasks init skipped — not authenticated",
    });
  }
}

/**
 * Shut down the Google Tasks integration.
 * Stops the background polling timer.
 */
export function shutdownGoogleTasks(): void {
  stopTasksTimer();
  initialized = false;
  logActivity({ source: "tasks", summary: "Google Tasks integration shut down" });
  log.info("Google Tasks integration shut down");
}

// ─── Status & health ─────────────────────────────────────────────────────────

export interface GoogleTasksIntegrationStatus {
  available: boolean;
  configured: boolean;
  authenticated: boolean;
  timerRunning: boolean;
  error: string | null;
}

/**
 * Get the full integration status: config, auth, timer health.
 */
export function getGoogleTasksStatus(): GoogleTasksIntegrationStatus {
  const configured = isGoogleConfigured();
  const authenticated = isGoogleAuthenticated();

  if (!configured) {
    return {
      available: false,
      configured: false,
      authenticated: false,
      timerRunning: false,
      error: "GOOGLE_CLIENT_ID and/or GOOGLE_CLIENT_SECRET not set in vault",
    };
  }

  if (!authenticated) {
    return {
      available: false,
      configured: true,
      authenticated: false,
      timerRunning: false,
      error: "GOOGLE_REFRESH_TOKEN not set — OAuth flow not completed",
    };
  }

  return {
    available: true,
    configured: true,
    authenticated: true,
    timerRunning: isTasksTimerRunning(),
    error: null,
  };
}

/**
 * Quick availability check (no API call).
 */
export function isGoogleTasksAvailable(): boolean {
  return isTasksAvailable();
}

// ─── Authentication ──────────────────────────────────────────────────────────

/**
 * Get the Google OAuth authorization URL for the consent screen.
 */
export function getGoogleTasksAuthUrl(redirectUri: string) {
  return getAuthUrl(redirectUri);
}

/**
 * Exchange an authorization code for tokens.
 * After success, call initGoogleTasks() to start the timer.
 */
export async function exchangeGoogleTasksCode(code: string, redirectUri: string) {
  const result = await exchangeCode(code, redirectUri);
  if (result.ok) {
    logActivity({
      source: "tasks",
      summary: "Google Tasks OAuth completed",
      actionLabel: "PROMPTED",
      reason: "user completed OAuth flow",
    });
  }
  return result;
}

/**
 * Clear the cached OAuth access token (e.g., on vault key change).
 */
export { clearTokenCache as clearGoogleTasksTokenCache };

// ─── Task List operations ────────────────────────────────────────────────────

/**
 * List all Google Task lists for the user.
 */
export async function getTaskLists() {
  return listTaskLists();
}

/**
 * Create a new task list.
 */
export async function addTaskList(title: string) {
  const result = await createTaskList(title);
  if (result.ok) {
    logActivity({
      source: "tasks",
      summary: `Task list created: ${title}`,
      actionLabel: "PROMPTED",
      reason: "user created task list",
    });
  }
  return result;
}

/**
 * Rename a task list.
 */
export async function renameTaskList(taskListId: string, title: string) {
  const result = await updateTaskList(taskListId, title);
  if (result.ok) {
    logActivity({
      source: "tasks",
      summary: `Task list renamed: ${title}`,
      actionLabel: "PROMPTED",
    });
  }
  return result;
}

/**
 * Delete a task list.
 */
export async function removeTaskList(taskListId: string) {
  const result = await deleteTaskList(taskListId);
  if (result.ok) {
    logActivity({
      source: "tasks",
      summary: `Task list deleted: ${taskListId}`,
      actionLabel: "PROMPTED",
    });
  }
  return result;
}

// ─── Task CRUD ───────────────────────────────────────────────────────────────

/**
 * List tasks in a task list.
 * @param taskListId - Defaults to "@default" for the user's primary list.
 */
export async function getTasks(
  taskListId?: string,
  opts?: {
    showCompleted?: boolean;
    dueMin?: string;
    dueMax?: string;
    maxResults?: number;
  },
) {
  return listTasks(taskListId ?? "@default", opts);
}

/**
 * Get a single task by ID.
 */
export async function getTaskById(taskListId: string, taskId: string) {
  return getTask(taskListId, taskId);
}

/**
 * Create a new task for the human.
 * Optionally sends a notification to confirm creation.
 */
export async function addTask(
  title: string,
  opts?: {
    notes?: string;
    due?: string;
    taskListId?: string;
    parent?: string;
    notify?: boolean;
  },
) {
  const taskListId = opts?.taskListId ?? "@default";
  const result = await createTask(taskListId, {
    title,
    notes: opts?.notes,
    due: opts?.due,
    parent: opts?.parent,
  });

  if (result.ok) {
    logActivity({
      source: "tasks",
      summary: `Task created: ${title}`,
      actionLabel: "PROMPTED",
      reason: "user created task",
    });

    if (opts?.notify) {
      const dueStr = opts.due ? ` (due: ${opts.due})` : "";
      pushNotification({
        timestamp: new Date().toISOString(),
        source: "tasks",
        message: `New task added: ${title}${dueStr}`,
      });
    }
  }

  return result;
}

/**
 * Update an existing task.
 */
export async function editTask(
  taskListId: string,
  taskId: string,
  changes: {
    title?: string;
    notes?: string;
    due?: string;
    status?: "needsAction" | "completed";
  },
) {
  const result = await updateTask(taskListId, taskId, changes);
  if (result.ok) {
    logActivity({
      source: "tasks",
      summary: `Task updated: ${taskId}`,
      actionLabel: "PROMPTED",
    });
  }
  return result;
}

/**
 * Mark a task as completed.
 */
export async function markTaskDone(taskListId: string, taskId: string) {
  const result = await completeTask(taskListId, taskId);
  if (result.ok && result.data) {
    logActivity({
      source: "tasks",
      summary: `Task completed: ${result.data.title}`,
      actionLabel: "PROMPTED",
      reason: "user completed task",
    });
    pushNotification({
      timestamp: new Date().toISOString(),
      source: "tasks",
      message: `Task completed: ${result.data.title}`,
    });
  }
  return result;
}

/**
 * Reopen a completed task.
 */
export async function markTaskUndone(taskListId: string, taskId: string) {
  const result = await uncompleteTask(taskListId, taskId);
  if (result.ok) {
    logActivity({
      source: "tasks",
      summary: `Task reopened: ${taskId}`,
      actionLabel: "PROMPTED",
    });
  }
  return result;
}

/**
 * Delete a task.
 */
export async function removeTask(taskListId: string, taskId: string) {
  const result = await deleteTask(taskListId, taskId);
  if (result.ok) {
    logActivity({
      source: "tasks",
      summary: `Task deleted: ${taskId}`,
      actionLabel: "PROMPTED",
    });
  }
  return result;
}

// ─── Recurring tasks ─────────────────────────────────────────────────────────

/**
 * Create recurring weekly tasks (Google Tasks has no native recurrence).
 * Generates concrete future tasks for the next N weeks.
 */
export async function addRecurringWeeklyTasks(config: RecurringTaskConfig) {
  const result = await createRecurringWeeklyTasks(config);
  if (result.ok) {
    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    logActivity({
      source: "tasks",
      summary: `Recurring tasks created: ${config.title} every ${dayNames[config.dayOfWeek]}`,
      actionLabel: "PROMPTED",
      reason: "user set up recurring task",
    });
  }
  return result;
}

// ─── Context & summaries ─────────────────────────────────────────────────────

/**
 * Get a human-readable summary of pending tasks for LLM context injection.
 * Fetches incomplete tasks from the default list and formats them.
 */
export async function getTasksSummary(taskListId?: string): Promise<{
  ok: boolean;
  summary?: string;
  taskCount?: number;
  message: string;
}> {
  const result = await listTasks(taskListId ?? "@default", {
    showCompleted: false,
  });

  if (!result.ok || !result.data) {
    return { ok: false, message: result.message };
  }

  return {
    ok: true,
    summary: formatTasksForContext(result.data),
    taskCount: result.data.length,
    message: `${result.data.length} pending tasks`,
  };
}

/**
 * Get tasks due today for daily briefing / notification digest.
 */
export async function getTasksDueToday(taskListId?: string): Promise<{
  ok: boolean;
  data?: Task[];
  summary?: string;
  message: string;
}> {
  const now = new Date();
  const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);

  const result = await listTasks(taskListId ?? "@default", {
    showCompleted: false,
    dueMax: endOfDay.toISOString(),
  });

  if (!result.ok || !result.data) {
    return { ok: false, message: result.message };
  }

  return {
    ok: true,
    data: result.data,
    summary: formatTasksForContext(result.data),
    message: `${result.data.length} tasks due today`,
  };
}

/**
 * Get overdue tasks that need attention.
 */
export async function getOverdueTasks(taskListId?: string): Promise<{
  ok: boolean;
  data?: Task[];
  summary?: string;
  message: string;
}> {
  const now = new Date();
  // Get tasks due before right now
  const result = await listTasks(taskListId ?? "@default", {
    showCompleted: false,
    dueMax: now.toISOString(),
  });

  if (!result.ok || !result.data) {
    return { ok: false, message: result.message };
  }

  // Filter to only actually overdue (due date in the past)
  const overdue = result.data.filter((t) => {
    if (!t.due) return false;
    const match = t.due.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!match) return false;
    const dueDate = new Date(
      parseInt(match[1]),
      parseInt(match[2]) - 1,
      parseInt(match[3]),
      23, 59, 59,
    );
    return dueDate.getTime() < now.getTime();
  });

  return {
    ok: true,
    data: overdue,
    summary: formatTasksForContext(overdue),
    message: `${overdue.length} overdue tasks`,
  };
}

// ─── Notification helpers ────────────────────────────────────────────────────

/**
 * Push a daily task digest notification.
 * Intended to be called from a daily cron/timer.
 */
export async function pushDailyTaskDigest(): Promise<{
  ok: boolean;
  message: string;
}> {
  const [dueResult, overdueResult] = await Promise.all([
    getTasksDueToday(),
    getOverdueTasks(),
  ]);

  const parts: string[] = [];

  if (overdueResult.ok && overdueResult.data && overdueResult.data.length > 0) {
    parts.push(`${overdueResult.data.length} overdue task(s)`);
  }

  if (dueResult.ok && dueResult.data && dueResult.data.length > 0) {
    parts.push(`${dueResult.data.length} task(s) due today`);
  }

  if (parts.length === 0) {
    return { ok: true, message: "No tasks need attention today" };
  }

  const message = `Task digest: ${parts.join(", ")}`;
  pushNotification({
    timestamp: new Date().toISOString(),
    source: "tasks",
    message,
  });

  logActivity({
    source: "tasks",
    summary: message,
    actionLabel: "AUTONOMOUS",
    reason: "daily task digest",
  });

  return { ok: true, message };
}

// ─── Quick-command helpers ────────────────────────────────────────────────────

/**
 * Quick add: parse a natural-language-ish task string.
 * Supports "title due:YYYY-MM-DD" and "title note:some notes".
 *
 * Example: quickAddTask("Buy groceries due:2026-03-01 note:organic milk")
 */
export async function quickAddTask(
  input: string,
  taskListId?: string,
): Promise<{ ok: boolean; data?: Task; message: string }> {
  let title = input;
  let due: string | undefined;
  let notes: string | undefined;

  // Extract due:YYYY-MM-DD
  const dueMatch = input.match(/\bdue:(\d{4}-\d{2}-\d{2})\b/);
  if (dueMatch) {
    due = dueMatch[1];
    title = title.replace(dueMatch[0], "").trim();
  }

  // Extract note:...
  const noteMatch = input.match(/\bnote:(.+)$/);
  if (noteMatch) {
    notes = noteMatch[1].trim();
    title = title.replace(noteMatch[0], "").trim();
  }

  if (!title) {
    return { ok: false, message: "Task title is required" };
  }

  return addTask(title, { due, notes, taskListId: taskListId ?? "@default" });
}

// ─── Re-exports for convenience ──────────────────────────────────────────────

export { formatTasksForContext };
export type { TaskList, Task, RecurringTaskConfig };
