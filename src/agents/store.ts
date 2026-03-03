import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { AgentTask, CreateTaskInput } from "./types.js";
import { createLogger } from "../utils/logger.js";
import { readBrainFile, writeBrainFile } from "../lib/brain-io.js";

const log = createLogger("agent-store");

const BRAIN_DIR = join(process.cwd(), "brain", "agents");
const TASKS_DIR = join(BRAIN_DIR, "tasks");
const LOGS_DIR = join(BRAIN_DIR, "logs");

export { TASKS_DIR, LOGS_DIR };

/** Create brain/agents/tasks/ and brain/agents/logs/ if they don't exist. */
export async function ensureDirs(): Promise<void> {
  await mkdir(TASKS_DIR, { recursive: true });
  await mkdir(LOGS_DIR, { recursive: true });
}

function generateId(): string {
  const ts = Date.now();
  const rand = randomBytes(4).toString("hex");
  return `agent_${ts}_${rand}`;
}

function taskPath(id: string): string {
  return join(TASKS_DIR, `${id}.json`);
}

/** Write task JSON to disk (encrypted) with retry for Windows EPERM/EBUSY file-locking. */
export async function writeTask(task: AgentTask): Promise<void> {
  const target = taskPath(task.id);
  const data = JSON.stringify(task, null, 2);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await writeBrainFile(target, data);
      return;
    } catch (err: any) {
      if ((err.code === "EPERM" || err.code === "EBUSY") && attempt < 2) {
        log.warn("File locked, retrying write", { taskId: task.id, attempt: attempt + 1, code: err.code });
        await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
        continue;
      }
      log.error("Failed to write task file", { taskId: task.id, error: err.message });
      throw err;
    }
  }
}

/** Preamble prepended to every agent prompt — teaches early exit on ambiguity. */
const AGENT_PREAMBLE = `## Autonomy rules (READ FIRST)
If at any point you cannot proceed because you need a human decision, design choice,
or clarification — do NOT spend time guessing or building the wrong thing.
Instead, immediately output a [NEEDS_HUMAN] block and exit:

[NEEDS_HUMAN]
- Question 1 about what's unclear
- Question 2 about a design decision needed
- etc.
[/NEEDS_HUMAN]

This surfaces your questions to the human for the next grooming session.
Only use this when you genuinely can't proceed — if you can make a reasonable
default choice, do so and note the assumption.

---

`;

/** Create a new task file and return it. */
export async function createTask(input: CreateTaskInput): Promise<AgentTask> {
  const task: AgentTask = {
    id: generateId(),
    label: input.label,
    prompt: AGENT_PREAMBLE + input.prompt,
    cwd: input.cwd ?? process.cwd(),
    status: "pending",
    createdAt: new Date().toISOString(),
    origin: input.origin,
    sessionId: input.sessionId,
    timeoutMs: input.timeoutMs ?? 10 * 60 * 1000,
    boardTaskId: input.boardTaskId,
  };
  await writeTask(task);
  log.info("Task created", { taskId: task.id, label: task.label, origin: task.origin });
  return task;
}

/** Read a single task by ID. Returns null if file doesn't exist. */
export async function readTask(id: string): Promise<AgentTask | null> {
  try {
    const data = await readBrainFile(taskPath(id));
    return JSON.parse(data) as AgentTask;
  } catch {
    return null;
  }
}

/**
 * Extract the embedded timestamp from a task filename.
 * Task IDs follow the pattern: agent_{timestamp}_{random}.json
 * Returns the timestamp in ms, or 0 if unparseable.
 */
function extractTimestampFromFilename(filename: string): number {
  const match = filename.match(/^agent_(\d+)_/);
  return match ? parseInt(match[1], 10) : 0;
}

/** Concurrency-limited parallel file reads. */
async function readFilesParallel(
  files: string[],
  concurrency: number,
): Promise<AgentTask[]> {
  const tasks: AgentTask[] = [];
  for (let i = 0; i < files.length; i += concurrency) {
    const chunk = files.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      chunk.map(async (f) => {
        const data = await readBrainFile(join(TASKS_DIR, f));
        return JSON.parse(data) as AgentTask;
      }),
    );
    for (const r of results) {
      if (r.status === "fulfilled") {
        tasks.push(r.value);
      }
    }
  }
  return tasks;
}

export interface ListTasksOptions {
  /** Only include tasks created after this timestamp (ms since epoch). */
  since?: number;
}

/**
 * List all tasks, sorted newest-first by createdAt.
 *
 * Performance optimizations:
 * - `since` option uses filename-embedded timestamps to skip old files without reading them
 * - Parallel file reads (chunks of 20) instead of sequential
 */
export async function listTasks(options?: ListTasksOptions): Promise<AgentTask[]> {
  let files: string[];
  try {
    files = await readdir(TASKS_DIR);
  } catch {
    return [];
  }

  let jsonFiles = files.filter((f) => f.endsWith(".json"));

  // Pre-filter by filename timestamp when a `since` cutoff is provided.
  // This avoids reading+decrypting files that are guaranteed to be too old.
  if (options?.since) {
    const cutoff = options.since;
    jsonFiles = jsonFiles.filter((f) => {
      const ts = extractTimestampFromFilename(f);
      // If we can't extract a timestamp, include the file (safe fallback)
      return ts === 0 || ts >= cutoff;
    });
  }

  if (jsonFiles.length === 0) return [];

  const tasks = await readFilesParallel(jsonFiles, 20);
  tasks.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  return tasks;
}

/** Merge partial fields into a task and write back. */
export async function updateTask(
  id: string,
  partial: Partial<AgentTask>,
): Promise<AgentTask | null> {
  const task = await readTask(id);
  if (!task) return null;
  Object.assign(task, partial);
  await writeTask(task);
  return task;
}

/** Read output logs for a task. Reads stdout and stderr in parallel. */
export async function readTaskOutput(id: string): Promise<string> {
  const [stdoutResult, stderrResult] = await Promise.allSettled([
    readBrainFile(join(LOGS_DIR, `${id}.stdout.log`)),
    readBrainFile(join(LOGS_DIR, `${id}.stderr.log`)),
  ]);

  const out = (stdoutResult.status === "fulfilled" ? stdoutResult.value : "").trim();
  const err = (stderrResult.status === "fulfilled" ? stderrResult.value : "").trim();

  if (out && err) return `${out}\n\n--- stderr ---\n${err}`;
  if (out) return out;
  if (err) return err;
  return "";
}
