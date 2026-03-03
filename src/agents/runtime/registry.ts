/**
 * Agent Runtime Environment — Agent instance registry.
 *
 * In-memory map of AgentInstance objects with file-backed persistence.
 * Follows Core patterns: JSON files in brain/agents/runtime/, atomic writes.
 */

import { mkdir, readFile, writeFile, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { AgentInstance, AgentState } from "./types.js";
import { TERMINAL_STATES } from "./types.js";

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class AgentRegistry {
  private readonly persistDir: string;
  private readonly instances = new Map<string, AgentInstance>();
  private initialized = false;

  constructor(persistDir: string) {
    this.persistDir = persistDir;
  }

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------

  /** Ensure persist directory exists and load all instances from disk. */
  async init(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.persistDir, { recursive: true });
    await this.loadAll();
    this.initialized = true;
  }

  // -------------------------------------------------------------------------
  // CRUD
  // -------------------------------------------------------------------------

  /** Generate a unique instance ID. */
  generateId(): string {
    return `rt_${Date.now()}_${randomBytes(4).toString("hex")}`;
  }

  /** Register a new instance. Persists to disk. */
  async register(instance: AgentInstance): Promise<void> {
    this.instances.set(instance.id, instance);
    await this.persist(instance);
  }

  /** Get an instance by ID. */
  get(id: string): AgentInstance | undefined {
    return this.instances.get(id);
  }

  /** Get an instance by its linked taskId. */
  getByTaskId(taskId: string): AgentInstance | undefined {
    for (const inst of this.instances.values()) {
      if (inst.taskId === taskId) return inst;
    }
    return undefined;
  }

  /**
   * Update an instance (merge partial fields). Persists to disk.
   * When `skipPersist` is true, updates in-memory only (used for terminal
   * state transitions — GC will delete the file within gcTtlMs anyway,
   * so the disk write is wasted I/O).
   */
  async update(
    id: string,
    partial: Partial<AgentInstance>,
    skipPersist = false,
  ): Promise<AgentInstance | undefined> {
    const instance = this.instances.get(id);
    if (!instance) return undefined;
    Object.assign(instance, partial);
    instance.updatedAt = new Date().toISOString();
    if (!skipPersist) {
      await this.persist(instance);
    }
    return instance;
  }

  /** List all instances, optionally filtered by state. */
  list(filter?: { state?: AgentState; states?: AgentState[] }): AgentInstance[] {
    if (!filter) return Array.from(this.instances.values());

    // Use Set for O(1) state lookups when filtering by multiple states
    const stateSet = filter.states ? new Set(filter.states) : null;

    const result: AgentInstance[] = [];
    for (const inst of this.instances.values()) {
      if (filter.state && inst.state !== filter.state) continue;
      if (stateSet && !stateSet.has(inst.state)) continue;
      result.push(inst);
    }
    return result;
  }

  /** List all active (non-terminal) instances. */
  listActive(): AgentInstance[] {
    return Array.from(this.instances.values()).filter(
      (inst) => !TERMINAL_STATES.has(inst.state),
    );
  }

  /** Count instances by state. */
  countByState(): Record<AgentState, number> {
    const counts: Record<string, number> = {};
    for (const inst of this.instances.values()) {
      counts[inst.state] = (counts[inst.state] || 0) + 1;
    }
    return counts as Record<AgentState, number>;
  }

  /** Total number of tracked instances. */
  get size(): number {
    return this.instances.size;
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  /** Atomic write: instance → JSON file. Uses compact JSON (no indentation). */
  private async persist(instance: AgentInstance): Promise<void> {
    const target = join(this.persistDir, `${instance.id}.json`);
    const tmp = target + ".tmp";
    await writeFile(tmp, JSON.stringify(instance), "utf-8");
    await rename(tmp, target);
  }

  /** Load all instance files from the persist directory (parallel I/O). */
  private async loadAll(): Promise<void> {
    let files: string[];
    try {
      files = await readdir(this.persistDir);
    } catch {
      return;
    }

    const jsonFiles = files.filter((f) => f.endsWith(".json"));
    if (jsonFiles.length === 0) return;

    // Read all files in parallel instead of sequentially
    const results = await Promise.allSettled(
      jsonFiles.map((f) => readFile(join(this.persistDir, f), "utf-8")),
    );

    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      try {
        const instance = JSON.parse(result.value) as AgentInstance;
        this.instances.set(instance.id, instance);
      } catch {
        // Skip corrupted files
      }
    }
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  /** Remove a single instance from memory and delete its persist file. */
  async remove(id: string): Promise<boolean> {
    const existed = this.instances.delete(id);
    if (existed) {
      const target = join(this.persistDir, `${id}.json`);
      await unlink(target).catch(() => {});
    }
    return existed;
  }

  /**
   * Remove multiple instances with chunked file deletion.
   * Deletes from in-memory map first (fast), then deletes files in chunks
   * to reduce NTFS directory lock contention on Windows (DASH-139).
   * Returns the number of instances actually removed.
   */
  async removeMany(ids: string[]): Promise<number> {
    const toDelete: string[] = [];
    for (const id of ids) {
      if (this.instances.delete(id)) {
        toDelete.push(id);
      }
    }
    if (toDelete.length > 0) {
      const CHUNK = 20;
      for (let i = 0; i < toDelete.length; i += CHUNK) {
        await Promise.all(
          toDelete.slice(i, i + CHUNK).map((id) =>
            unlink(join(this.persistDir, `${id}.json`)).catch(() => {}),
          ),
        );
      }
    }
    return toDelete.length;
  }

  /**
   * Remove multiple instances from the in-memory map only (no file I/O).
   * Returns the IDs that were actually removed and their persist file paths,
   * so the caller can batch-delete them alongside other files in a single pass.
   */
  removeManyInMemory(ids: string[]): { removed: number; filePaths: string[] } {
    const filePaths: string[] = [];
    let removed = 0;
    for (const id of ids) {
      if (this.instances.delete(id)) {
        removed++;
        filePaths.push(join(this.persistDir, `${id}.json`));
      }
    }
    return { removed, filePaths };
  }

  /** Clear all in-memory instances. Does not delete files. */
  clear(): void {
    this.instances.clear();
  }
}
