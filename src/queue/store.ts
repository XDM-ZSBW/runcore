/**
 * Queue store — append-only JSONL persistence for QueueTask.
 * Follows src/memory/file-backed.ts pattern.
 * All tasks encrypted at rest via brain-io.
 *
 * File: brain/operations/queue.jsonl
 * Update strategy: append full updated task. On load, last occurrence per id wins.
 */

import { join } from "node:path";
import { stat, readFile, writeFile, mkdir } from "node:fs/promises";
import type { QueueTask, QueueExchange, QueueTaskState, QueueProject } from "./types.js";
import { DEFAULT_PROJECT_ID } from "./types.js";
import { createLogger } from "../utils/logger.js";
import { readBrainLines, appendBrainLine, writeBrainLines, ensureBrainJsonl } from "../lib/brain-io.js";
import { decryptLine } from "../lib/encryption.js";
import { getEncryptionKey } from "../lib/key-store.js";

const log = createLogger("queue.store");

const SCHEMA_LINE = JSON.stringify({ _schema: "queue", _version: "1.0" });

function generateId(): string {
  return `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

function generateExchangeId(): string {
  return `ex_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

const DEFAULT_PROJECTS: QueueProject[] = [
  { id: "triage", name: "Triage", prefix: "TRI", description: "Uncategorized items awaiting project assignment" },
  { id: "core-dev", name: "Core Dev", prefix: "CORE", description: "Core runtime and brain development" },
];

export class ProjectStore {
  private readonly filePath: string;
  private cache: QueueProject[] | null = null;

  constructor(brainDir: string) {
    this.filePath = join(brainDir, "operations", "projects.json");
  }

  /** Load projects from disk. Seeds defaults if file missing. */
  async load(): Promise<QueueProject[]> {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(this.filePath, "utf-8");
      this.cache = JSON.parse(raw) as QueueProject[];
    } catch {
      // File missing or corrupt — seed defaults
      this.cache = [...DEFAULT_PROJECTS];
      await this.save();
    }
    return this.cache;
  }

  private async save(): Promise<void> {
    const dir = join(this.filePath, "..");
    await mkdir(dir, { recursive: true });
    await writeFile(this.filePath, JSON.stringify(this.cache, null, 2), "utf-8");
  }

  async list(): Promise<QueueProject[]> {
    return this.load();
  }

  async get(id: string): Promise<QueueProject | undefined> {
    const projects = await this.load();
    // Exact match first
    const exact = projects.find((p) => p.id === id);
    if (exact) return exact;
    // Fuzzy: match by prefix (case-insensitive) or id starts-with
    const lower = id.toLowerCase();
    return projects.find((p) => p.prefix.toLowerCase() === lower)
      ?? projects.find((p) => p.id.startsWith(lower))
      ?? projects.find((p) => lower.startsWith(p.id));
  }

  async getByPrefix(prefix: string): Promise<QueueProject | undefined> {
    const projects = await this.load();
    return projects.find((p) => p.prefix === prefix.toUpperCase());
  }

  async create(project: Omit<QueueProject, "id">): Promise<QueueProject> {
    const projects = await this.load();
    const id = project.name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
    if (projects.some((p) => p.id === id)) throw new Error(`Project "${id}" already exists`);
    if (projects.some((p) => p.prefix === project.prefix.toUpperCase())) {
      throw new Error(`Prefix "${project.prefix}" already in use`);
    }
    const newProject: QueueProject = { id, ...project, prefix: project.prefix.toUpperCase() };
    projects.push(newProject);
    await this.save();
    log.info("project created", { id, prefix: newProject.prefix });
    return newProject;
  }

  async update(id: string, changes: Partial<Pick<QueueProject, "name" | "description">>): Promise<QueueProject | null> {
    const projects = await this.load();
    const idx = projects.findIndex((p) => p.id === id);
    if (idx === -1) return null;
    projects[idx] = { ...projects[idx], ...changes };
    await this.save();
    return projects[idx];
  }

  async delete(id: string): Promise<boolean> {
    const projects = await this.load();
    const idx = projects.findIndex((p) => p.id === id);
    if (idx === -1) return false;
    projects.splice(idx, 1);
    await this.save();
    log.info("project deleted", { id });
    return true;
  }
}

export class QueueStore {
  private readonly filePath: string;
  private readonly projectStore: ProjectStore;
  private cache: Map<string, QueueTask> | null = null;
  private lastMtime = 0;
  private lastStaleCheckMs = 0;
  private nextNums: Map<string, number> = new Map();
  private onStateTransition?: (task: QueueTask, from: string, to: string) => void;

  constructor(brainDir: string, projectStore?: ProjectStore) {
    this.filePath = join(brainDir, "operations", "queue.jsonl");
    this.projectStore = projectStore ?? new ProjectStore(brainDir);
  }

  /** Expose project store for external use. */
  getProjectStore(): ProjectStore {
    return this.projectStore;
  }

  /** Register a callback fired when a task's state changes. */
  setOnStateTransition(fn: (task: QueueTask, from: string, to: string) => void): void {
    this.onStateTransition = fn;
  }

  /** Ensure the file exists with a schema header. */
  private async ensureFile(): Promise<void> {
    await ensureBrainJsonl(this.filePath, SCHEMA_LINE);
  }

  /** Load file and build in-memory cache. Called once on first access (or on reload). */
  private async load(): Promise<Map<string, QueueTask>> {
    if (this.cache) return this.cache;
    await this.ensureFile();

    log.debug("loading queue from file", { filePath: this.filePath });
    const lines = await readBrainLines(this.filePath);

    const map = new Map<string, QueueTask>();
    const highWater = new Map<string, number>();

    for (const line of lines) {
      try {
        let obj = JSON.parse(line);
        if (obj._schema) continue;
        // Decrypt encrypted entries that readBrainLines couldn't handle
        // (e.g. file not in allowlist, or key unavailable at read time)
        if (obj._e) {
          const key = getEncryptionKey();
          if (!key) {
            log.debug("Skipping encrypted queue entry — no key available");
            continue;
          }
          try {
            obj = JSON.parse(decryptLine(line, key));
          } catch {
            log.debug("Failed to decrypt queue entry — skipping");
            continue;
          }
        }
        if (!obj.id) continue;
        // Last occurrence of each id wins (overwrites previous)
        map.set(obj.id, obj as QueueTask);
        // Track highest N per prefix (e.g. DASH-5, CORE-3, TRI-1)
        const match = (obj.identifier as string | undefined)?.match(/^([A-Z]+)-(\d+)$/);
        if (match) {
          const prefix = match[1];
          const n = parseInt(match[2], 10);
          if (n > (highWater.get(prefix) ?? 0)) highWater.set(prefix, n);
        }
      } catch {
        continue;
      }
    }

    // Build nextNums from high-water marks
    this.nextNums = new Map();
    for (const [prefix, max] of highWater) {
      this.nextNums.set(prefix, max + 1);
    }

    // Backfill project on legacy DASH-N tasks that don't have one
    for (const task of map.values()) {
      if (!task.project && task.identifier?.startsWith("DASH-")) {
        task.project = "core-dev";
      }
    }

    this.cache = map;

    // Record file mtime for staleness detection
    try {
      const s = await stat(this.filePath);
      this.lastMtime = s.mtimeMs;
    } catch { /* file just read successfully, stat failure is non-fatal */ }

    const prefixes = [...this.nextNums.entries()].map(([p, n]) => `${p}:${n}`).join(", ");
    log.info("queue loaded from file", { taskCount: map.size, nextNums: prefixes, lines: lines.length });
    return map;
  }

  /** If the file was modified externally since last load, clear cache and reload.
   *  Skips the stat() call if checked within the last 5s — avoids redundant I/O
   *  when the autonomous loop calls list() multiple times in the same cycle. */
  private async checkStale(): Promise<void> {
    if (!this.cache) return; // not loaded yet, load() will handle it
    const now = Date.now();
    if (now - this.lastStaleCheckMs < 5000) return;
    this.lastStaleCheckMs = now;
    try {
      const s = await stat(this.filePath);
      if (s.mtimeMs > this.lastMtime) {
        log.info("queue file changed externally, reloading", { oldMtime: this.lastMtime, newMtime: s.mtimeMs });
        this.cache = null;
        await this.load();
      }
    } catch { /* stat failed, skip check */ }
  }

  /** Append a task object to the JSONL file. */
  private async append(task: QueueTask): Promise<void> {
    await appendBrainLine(this.filePath, JSON.stringify(task));
  }

  /** List all active (non-archived) tasks. */
  async list(): Promise<QueueTask[]> {
    await this.checkStale();
    const map = await this.load();
    return [...map.values()]
      .filter((t) => t.status !== "archived")
      .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0) || (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
  }

  /** Get a task by internal id. */
  async get(id: string): Promise<QueueTask | null> {
    const map = await this.load();
    const task = map.get(id);
    if (!task || task.status === "archived") return null;
    return task;
  }

  /** Get a task by human-readable identifier (e.g. "DASH-3"). */
  async getByIdentifier(identifier: string): Promise<QueueTask | null> {
    const map = await this.load();
    for (const task of map.values()) {
      if (task.identifier === identifier && task.status !== "archived") return task;
    }
    return null;
  }

  /** Create a new task. Returns the created task. */
  async create(opts: {
    title: string;
    description?: string;
    state?: QueueTaskState;
    priority?: number;
    assignee?: string | null;
    project?: string;
    origin?: "chat" | "agent" | "autonomous" | "external";
    originSessionId?: string;
  }): Promise<QueueTask> {
    await this.load();

    // Resolve prefix from project
    let prefix = "DASH"; // fallback for projectless items
    if (opts.project) {
      const proj = await this.projectStore.get(opts.project);
      if (proj) prefix = proj.prefix;
    }

    // Find next unique identifier — guard against collisions from stale counters
    let num = this.nextNums.get(prefix) ?? 1;
    const existingIdentifiers = new Set<string>();
    for (const t of this.cache!.values()) {
      if (t.identifier) existingIdentifiers.add(t.identifier);
    }
    while (existingIdentifiers.has(`${prefix}-${num}`)) {
      log.warn("identifier collision detected, skipping", { identifier: `${prefix}-${num}` });
      num++;
    }
    this.nextNums.set(prefix, num + 1);

    const now = new Date().toISOString();
    const task: QueueTask = {
      id: generateId(),
      identifier: `${prefix}-${num}`,
      title: opts.title,
      description: opts.description ?? "",
      state: opts.state ?? "todo",
      priority: opts.priority ?? 0,
      assignee: opts.assignee ?? null,
      project: opts.project,
      exchanges: [],
      createdAt: now,
      updatedAt: now,
      status: "active",
      origin: opts.origin,
      originSessionId: opts.originSessionId,
    };
    this.cache!.set(task.id, task);
    await this.append(task);
    log.info("task created", { id: task.id, identifier: task.identifier, project: opts.project, title: task.title });
    return task;
  }

  /** Update an existing task. Appends the full updated object only if something meaningful changed. */
  async update(id: string, changes: Partial<Pick<QueueTask,
    "title" | "description" | "state" | "priority" | "assignee" | "project" | "agentTaskId"
  >>): Promise<QueueTask | null> {
    const map = await this.load();
    const existing = map.get(id);
    if (!existing || existing.status === "archived") return null;

    const updated: QueueTask = {
      ...existing,
      ...changes,
      updatedAt: new Date().toISOString(),
    };

    // Skip append if nothing meaningful changed (prevents JSONL bloat)
    const dominated =
      existing.title === updated.title &&
      existing.description === updated.description &&
      existing.state === updated.state &&
      existing.priority === updated.priority &&
      existing.assignee === updated.assignee &&
      existing.project === updated.project &&
      existing.agentTaskId === updated.agentTaskId;

    map.set(id, updated);
    if (!dominated) {
      await this.append(updated);
      log.debug("task updated", { id, identifier: updated.identifier, changes: Object.keys(changes) });
      // Fire transition callback when state changed
      if (existing.state !== updated.state && this.onStateTransition) {
        try { this.onStateTransition(updated, existing.state, updated.state); } catch {}
      }
    }
    return updated;
  }

  /** Archive a task (soft-delete). */
  async archive(id: string): Promise<boolean> {
    const map = await this.load();
    const existing = map.get(id);
    if (!existing) return false;

    const archived: QueueTask = {
      ...existing,
      status: "archived",
      updatedAt: new Date().toISOString(),
    };
    map.set(id, archived);
    await this.append(archived);
    log.info("task archived", { id, identifier: existing.identifier });
    return true;
  }

  /** Add an exchange (comment/interaction) to a task. */
  async addExchange(taskId: string, exchange: Omit<QueueExchange, "id" | "timestamp">): Promise<QueueExchange | null> {
    const map = await this.load();
    const existing = map.get(taskId);
    if (!existing || existing.status === "archived") return null;

    const ex: QueueExchange = {
      ...exchange,
      id: generateExchangeId(),
      timestamp: new Date().toISOString(),
    };
    const updated: QueueTask = {
      ...existing,
      exchanges: [...existing.exchanges, ex],
      updatedAt: new Date().toISOString(),
    };
    map.set(taskId, updated);
    await this.append(updated);
    log.debug("exchange added to task", { taskId, exchangeId: ex.id, author: ex.author, source: ex.source });
    return ex;
  }

  /** Get all exchanges for a task. */
  async getExchanges(taskId: string): Promise<QueueExchange[]> {
    const task = await this.get(taskId);
    return task?.exchanges ?? [];
  }

  /** Return the total count of active tasks. */
  async count(): Promise<number> {
    const all = await this.list();
    return all.length;
  }

  /**
   * Compact the JSONL file — rewrite with only the latest version of each task.
   * Eliminates stale duplicate lines from append-only updates.
   * Safe to call at any time; rebuilds from in-memory cache.
   */
  async compact(): Promise<{ before: number; after: number }> {
    const map = await this.load();
    const tasks = [...map.values()];
    const lines = [SCHEMA_LINE, ...tasks.map((t) => JSON.stringify(t))];
    await writeBrainLines(this.filePath, lines);

    const after = lines.length;
    log.info("queue compacted", { before: tasks.length + 1, after });
    return { before: tasks.length + 1, after };
  }

  /** Return the raw line count of the JSONL file. */
  async lineCount(): Promise<number> {
    const lines = await readBrainLines(this.filePath);
    return lines.length;
  }

  /**
   * Detect and repair identifier collisions — different tasks sharing the same identifier.
   * For each collision group, the earliest-created task keeps its identifier;
   * later tasks are reassigned to the next available number for that prefix.
   * Returns a list of reassignments made.
   */
  async repairCollisions(): Promise<Array<{ taskId: string; oldIdentifier: string; newIdentifier: string }>> {
    const map = await this.load();
    const repairs: Array<{ taskId: string; oldIdentifier: string; newIdentifier: string }> = [];

    // Group active tasks by identifier
    const byIdentifier = new Map<string, QueueTask[]>();
    for (const task of map.values()) {
      if (!task.identifier || task.status === "archived") continue;
      const group = byIdentifier.get(task.identifier) ?? [];
      group.push(task);
      byIdentifier.set(task.identifier, group);
    }

    // Collect all identifiers in use (for uniqueness checks during reassignment)
    const usedIdentifiers = new Set<string>();
    for (const task of map.values()) {
      if (task.identifier) usedIdentifiers.add(task.identifier);
    }

    // Fix collisions
    for (const [identifier, tasks] of byIdentifier) {
      if (tasks.length <= 1) continue;

      // Sort by createdAt — earliest keeps the identifier
      tasks.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));

      const match = identifier.match(/^([A-Z]+)-(\d+)$/);
      if (!match) continue;
      const prefix = match[1];

      // Reassign all except the first (earliest)
      for (let i = 1; i < tasks.length; i++) {
        let num = this.nextNums.get(prefix) ?? 1;
        while (usedIdentifiers.has(`${prefix}-${num}`)) num++;
        const newIdentifier = `${prefix}-${num}`;

        this.nextNums.set(prefix, num + 1);
        usedIdentifiers.add(newIdentifier);

        const oldIdentifier = tasks[i].identifier;
        const updated: QueueTask = {
          ...tasks[i],
          identifier: newIdentifier,
          updatedAt: new Date().toISOString(),
        };
        map.set(tasks[i].id, updated);
        await this.append(updated);
        repairs.push({ taskId: tasks[i].id, oldIdentifier: oldIdentifier!, newIdentifier });
        log.warn("collision repaired", { taskId: tasks[i].id, oldIdentifier, newIdentifier });
      }
    }

    return repairs;
  }
}
