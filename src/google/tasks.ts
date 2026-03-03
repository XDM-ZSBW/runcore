/**
 * Google Tasks API client.
 * Raw fetch via googleGet/googlePost/googlePatch/googleDelete — no SDK.
 * All functions return { ok, data?, message } — never throw.
 */

import { googleGet, googlePost, googlePatch, googleDelete, isGoogleAuthenticated } from "./auth.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("google.tasks");

const TASKS_API = "https://tasks.googleapis.com/tasks/v1";

// --- Types ---

export interface TaskList {
  id: string;
  title: string;
  updated: string;
}

export interface Task {
  id: string;
  title: string;
  notes?: string;
  status: "needsAction" | "completed";
  due?: string; // RFC 3339 date (date portion only, e.g. 2026-03-01T00:00:00.000Z)
  completed?: string; // RFC 3339 timestamp
  parent?: string;
  position: string;
  updated: string;
}

interface GoogleTaskList {
  id: string;
  title?: string;
  updated?: string;
}

interface GoogleTaskListsResponse {
  items?: GoogleTaskList[];
}

interface GoogleTask {
  id: string;
  title?: string;
  notes?: string;
  status?: string;
  due?: string;
  completed?: string;
  parent?: string;
  position?: string;
  updated?: string;
}

interface GoogleTasksResponse {
  items?: GoogleTask[];
}

// --- Helpers ---

function parseTaskList(tl: GoogleTaskList): TaskList {
  return {
    id: tl.id,
    title: tl.title ?? "(untitled)",
    updated: tl.updated ?? "",
  };
}

function parseTask(t: GoogleTask): Task {
  return {
    id: t.id,
    title: t.title ?? "(untitled)",
    notes: t.notes,
    status: t.status === "completed" ? "completed" : "needsAction",
    due: t.due,
    completed: t.completed,
    parent: t.parent,
    position: t.position ?? "0",
    updated: t.updated ?? "",
  };
}

/**
 * Convert a Date or ISO string to Google Tasks due date format.
 * Google Tasks expects RFC 3339 with time set to 00:00:00.000Z.
 *
 * Uses string extraction for ISO strings to avoid the UTC-midnight-to-local-time
 * shift bug: new Date('2026-03-04') parses as UTC midnight, but getDate() returns
 * local time, which can shift the date backward in timezones behind UTC.
 * Fix for ts_temporal_mismatch_01.
 */
function toDueDate(date: string | Date): string {
  if (typeof date === "string") {
    // Extract YYYY-MM-DD directly from the string to avoid timezone shift
    const match = date.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (match) {
      return `${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z`;
    }
  }
  // For Date objects or non-ISO strings, use local-time getters
  // (Date objects were constructed with local intent)
  const d = typeof date === "string" ? new Date(date) : date;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T00:00:00.000Z`;
}

// --- Public API ---

/**
 * Check if Tasks is ready (Google authenticated).
 */
export function isTasksAvailable(): boolean {
  return isGoogleAuthenticated();
}

// ==================== Task Lists ====================

/**
 * List all task lists for the authenticated user.
 */
export async function listTaskLists(): Promise<{
  ok: boolean;
  data?: TaskList[];
  message: string;
}> {
  log.debug("Listing task lists");
  const result = await googleGet<GoogleTaskListsResponse>(
    `${TASKS_API}/users/@me/lists`,
    { maxResults: "100" },
  );

  if (!result.ok) {
    log.error("Failed to list task lists", { error: result.message });
    return { ok: false, message: result.message };
  }

  const lists = (result.data?.items ?? []).map(parseTaskList);
  log.debug("Task lists fetched", { count: lists.length });
  return { ok: true, data: lists, message: `${lists.length} task lists` };
}

/**
 * Create a new task list.
 */
export async function createTaskList(title: string): Promise<{
  ok: boolean;
  data?: TaskList;
  message: string;
}> {
  if (!title) return { ok: false, message: "Title is required" };

  log.debug("Creating task list", { title });
  const result = await googlePost<GoogleTaskList>(
    `${TASKS_API}/users/@me/lists`,
    { title },
  );

  if (!result.ok || !result.data) {
    log.error("Failed to create task list", { title, error: result.message });
    return { ok: false, message: result.message };
  }

  log.info("Task list created", { title, taskListId: result.data.id });
  return {
    ok: true,
    data: parseTaskList(result.data),
    message: `Task list created: ${title}`,
  };
}

/**
 * Update a task list's title.
 */
export async function updateTaskList(
  taskListId: string,
  title: string,
): Promise<{ ok: boolean; data?: TaskList; message: string }> {
  log.debug("Updating task list", { taskListId, title });
  const result = await googlePatch<GoogleTaskList>(
    `${TASKS_API}/users/@me/lists/${taskListId}`,
    { title },
  );

  if (!result.ok || !result.data) {
    log.error("Failed to update task list", { taskListId, error: result.message });
    return { ok: false, message: result.message };
  }

  log.info("Task list updated", { taskListId, title });
  return {
    ok: true,
    data: parseTaskList(result.data),
    message: `Task list updated: ${title}`,
  };
}

/**
 * Delete a task list.
 */
export async function deleteTaskList(taskListId: string): Promise<{
  ok: boolean;
  message: string;
}> {
  log.debug("Deleting task list", { taskListId });
  const result = await googleDelete(`${TASKS_API}/users/@me/lists/${taskListId}`);
  if (!result.ok) {
    log.error("Failed to delete task list", { taskListId, error: result.message });
  } else {
    log.info("Task list deleted", { taskListId });
  }
  return result;
}

// ==================== Tasks ====================

/**
 * List tasks in a task list.
 * @param taskListId - Task list ID (default: "@default" for the user's default list)
 * @param showCompleted - Include completed tasks (default: false)
 * @param showHidden - Include hidden/deleted tasks (default: false)
 * @param dueMin - Only tasks due after this date (ISO string)
 * @param dueMax - Only tasks due before this date (ISO string)
 */
export async function listTasks(
  taskListId: string = "@default",
  opts?: {
    showCompleted?: boolean;
    showHidden?: boolean;
    dueMin?: string;
    dueMax?: string;
    maxResults?: number;
  },
): Promise<{ ok: boolean; data?: Task[]; message: string }> {
  const params: Record<string, string> = {
    maxResults: String(opts?.maxResults ?? 100),
    showCompleted: String(opts?.showCompleted ?? false),
    showHidden: String(opts?.showHidden ?? false),
  };
  if (opts?.dueMin) params.dueMin = toDueDate(opts.dueMin);
  if (opts?.dueMax) params.dueMax = toDueDate(opts.dueMax);

  log.debug("Listing tasks", { taskListId, showCompleted: opts?.showCompleted });
  const result = await googleGet<GoogleTasksResponse>(
    `${TASKS_API}/lists/${taskListId}/tasks`,
    params,
  );

  if (!result.ok) {
    log.error("Failed to list tasks", { taskListId, error: result.message });
    return { ok: false, message: result.message };
  }

  const tasks = (result.data?.items ?? []).map(parseTask);
  log.debug("Tasks listed", { taskListId, count: tasks.length });
  return { ok: true, data: tasks, message: `${tasks.length} tasks` };
}

/**
 * Get a single task by ID.
 */
export async function getTask(
  taskListId: string,
  taskId: string,
): Promise<{ ok: boolean; data?: Task; message: string }> {
  const result = await googleGet<GoogleTask>(
    `${TASKS_API}/lists/${taskListId}/tasks/${taskId}`,
  );

  if (!result.ok || !result.data) return { ok: false, message: result.message };

  return { ok: true, data: parseTask(result.data), message: "OK" };
}

/**
 * Create a new task.
 */
export async function createTask(
  taskListId: string,
  task: {
    title: string;
    notes?: string;
    due?: string;
    parent?: string;
  },
): Promise<{ ok: boolean; data?: Task; message: string }> {
  if (!task.title) return { ok: false, message: "Title is required" };

  const body: Record<string, any> = { title: task.title };
  if (task.notes) body.notes = task.notes;
  if (task.due) body.due = toDueDate(task.due);

  let url = `${TASKS_API}/lists/${taskListId}/tasks`;
  if (task.parent) url += `?parent=${task.parent}`;

  const result = await googlePost<GoogleTask>(url, body);

  if (!result.ok || !result.data) return { ok: false, message: result.message };

  return {
    ok: true,
    data: parseTask(result.data),
    message: `Task created: ${task.title}`,
  };
}

/**
 * Update an existing task.
 */
export async function updateTask(
  taskListId: string,
  taskId: string,
  changes: {
    title?: string;
    notes?: string;
    due?: string;
    status?: "needsAction" | "completed";
  },
): Promise<{ ok: boolean; data?: Task; message: string }> {
  const body: Record<string, any> = {};
  if (changes.title !== undefined) body.title = changes.title;
  if (changes.notes !== undefined) body.notes = changes.notes;
  if (changes.due !== undefined) body.due = toDueDate(changes.due);
  if (changes.status !== undefined) {
    body.status = changes.status;
    if (changes.status === "completed") {
      body.completed = new Date().toISOString();
    } else {
      // Clearing completed resets the task to needsAction
      body.completed = null;
    }
  }

  const result = await googlePatch<GoogleTask>(
    `${TASKS_API}/lists/${taskListId}/tasks/${taskId}`,
    body,
  );

  if (!result.ok || !result.data) return { ok: false, message: result.message };

  return {
    ok: true,
    data: parseTask(result.data),
    message: `Task updated: ${taskId}`,
  };
}

/**
 * Mark a task as completed.
 */
export async function completeTask(
  taskListId: string,
  taskId: string,
): Promise<{ ok: boolean; data?: Task; message: string }> {
  return updateTask(taskListId, taskId, { status: "completed" });
}

/**
 * Mark a task as incomplete (reopen).
 */
export async function uncompleteTask(
  taskListId: string,
  taskId: string,
): Promise<{ ok: boolean; data?: Task; message: string }> {
  return updateTask(taskListId, taskId, { status: "needsAction" });
}

/**
 * Delete a task.
 */
export async function deleteTask(
  taskListId: string,
  taskId: string,
): Promise<{ ok: boolean; message: string }> {
  return googleDelete(`${TASKS_API}/lists/${taskListId}/tasks/${taskId}`);
}

// ==================== Recurring Tasks ====================

export interface RecurringTaskConfig {
  title: string;
  notes?: string;
  taskListId?: string; // defaults to "@default"
  /** Day of week: 0=Sunday, 1=Monday, ..., 6=Saturday */
  dayOfWeek: number;
  /** Hour in 24h format (0-23) */
  hour: number;
  /** Minute (0-59) */
  minute?: number;
  /** How many weeks ahead to create tasks (default: 4) */
  weeksAhead?: number;
}

/**
 * Create recurring weekly tasks by generating individual tasks with due dates
 * for the next N weeks. Google Tasks API doesn't support native recurrence,
 * so we create concrete future tasks.
 *
 * Example: createRecurringWeeklyTasks({
 *   title: "Status Report",
 *   dayOfWeek: 5, // Friday
 *   hour: 16,     // 4 PM
 *   weeksAhead: 4,
 * })
 */
export async function createRecurringWeeklyTasks(
  config: RecurringTaskConfig,
): Promise<{ ok: boolean; data?: Task[]; message: string }> {
  const {
    title,
    notes,
    taskListId = "@default",
    dayOfWeek,
    hour,
    minute = 0,
    weeksAhead = 4,
  } = config;

  if (dayOfWeek < 0 || dayOfWeek > 6) {
    return { ok: false, message: "dayOfWeek must be 0 (Sunday) through 6 (Saturday)" };
  }

  // Find the next occurrence of the given day of week
  const now = new Date();
  const currentDay = now.getDay();
  let daysUntilNext = dayOfWeek - currentDay;
  if (daysUntilNext < 0) daysUntilNext += 7;
  if (daysUntilNext === 0) {
    // If today is the target day, check if the time has passed
    const targetToday = new Date(now);
    targetToday.setHours(hour, minute, 0, 0);
    if (now > targetToday) daysUntilNext = 7;
  }

  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const dayName = dayNames[dayOfWeek];
  const timeStr = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

  const created: Task[] = [];
  const errors: string[] = [];

  for (let week = 0; week < weeksAhead; week++) {
    const dueDate = new Date(now);
    dueDate.setDate(now.getDate() + daysUntilNext + week * 7);
    dueDate.setHours(hour, minute, 0, 0);

    const dateLabel = dueDate.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
    const taskTitle = `${title} — ${dayName} ${dateLabel} ${timeStr}`;
    const taskNotes = notes
      ? `${notes}\n\nRecurring: every ${dayName} at ${timeStr}`
      : `Recurring: every ${dayName} at ${timeStr}`;

    const result = await createTask(taskListId, {
      title: taskTitle,
      notes: taskNotes,
      due: dueDate.toISOString(),
    });

    if (result.ok && result.data) {
      created.push(result.data);
    } else {
      errors.push(`Week ${week + 1}: ${result.message}`);
    }
  }

  if (created.length === 0) {
    return { ok: false, message: `Failed to create any tasks: ${errors.join("; ")}` };
  }

  const msg = errors.length > 0
    ? `Created ${created.length}/${weeksAhead} tasks (${errors.length} failed)`
    : `Created ${created.length} recurring tasks: ${title} every ${dayName} at ${timeStr}`;

  return { ok: true, data: created, message: msg };
}

// ==================== Context formatting ====================

/**
 * Format tasks as a readable text block for LLM context injection.
 */
export function formatTasksForContext(tasks: Task[]): string {
  if (tasks.length === 0) return "No tasks.";

  return tasks
    .map((t) => {
      const check = t.status === "completed" ? "[x]" : "[ ]";
      let dueStr = "";
      if (t.due) {
        // Extract YYYY-MM-DD directly to avoid UTC-midnight-to-local shift (ts_temporal_mismatch_01)
        const m = t.due.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (m) {
          const d = new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
          dueStr = ` (due: ${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })})`;
        } else {
          dueStr = ` (due: ${new Date(t.due).toLocaleDateString("en-US", { month: "short", day: "numeric" })})`;
        }
      }
      const notesStr = t.notes ? ` — ${t.notes.split("\n")[0]}` : "";
      return `- ${check} ${t.title}${dueStr}${notesStr}`;
    })
    .join("\n");
}
