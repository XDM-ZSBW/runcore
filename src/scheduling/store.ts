/**
 * Scheduling store — append-only JSONL persistence for SchedulingBlock.
 * Follows src/queue/store.ts pattern.
 *
 * File: brain/scheduling/blocks.jsonl
 * Update strategy: append full updated block. On load, last occurrence per id wins.
 */

import { join } from "node:path";
import { stat } from "node:fs/promises";
import { createLogger } from "../utils/logger.js";
import { readBrainLines, appendBrainLine, ensureBrainJsonl } from "../lib/brain-io.js";
import type { SchedulingBlock, BlockFilter, DaySchedule, BlockStatus, BlockType } from "./types.js";

const log = createLogger("scheduling.store");

const SCHEMA_LINE = JSON.stringify({ _schema: "scheduling-blocks", _version: "1.0" });

function generateId(): string {
  const hex = Math.random().toString(16).slice(2, 10).padEnd(8, "0");
  return `blk_${hex}`;
}

export class SchedulingStore {
  private readonly filePath: string;
  private cache: Map<string, SchedulingBlock> | null = null;
  private lastMtime = 0;
  private lastStaleCheckMs = 0;

  constructor(brainDir: string) {
    this.filePath = join(brainDir, "scheduling", "blocks.jsonl");
  }

  // ── File management ──────────────────────────────────────────────────────

  private async ensureFile(): Promise<void> {
    await ensureBrainJsonl(this.filePath, SCHEMA_LINE);
  }

  private async checkStale(): Promise<void> {
    if (!this.cache) return;
    const now = Date.now();
    if (now - this.lastStaleCheckMs < 5000) return;
    this.lastStaleCheckMs = now;

    try {
      const s = await stat(this.filePath);
      const mtime = s.mtimeMs;
      if (mtime > this.lastMtime) {
        this.cache = null; // Force reload
      }
    } catch {
      // File may not exist yet
    }
  }

  // ── Load ──────────────────────────────────────────────────────────────────

  private async load(): Promise<Map<string, SchedulingBlock>> {
    await this.checkStale();
    if (this.cache) return this.cache;

    await this.ensureFile();
    const lines = await readBrainLines(this.filePath);
    const map = new Map<string, SchedulingBlock>();

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj._schema) continue;
        if (!obj.id) continue;
        map.set(obj.id, obj as SchedulingBlock);
      } catch {
        continue;
      }
    }

    this.cache = map;
    try {
      const s = await stat(this.filePath);
      this.lastMtime = s.mtimeMs;
    } catch { /* ok */ }

    return map;
  }

  private invalidate(): void {
    this.cache = null;
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  async list(filter?: BlockFilter): Promise<SchedulingBlock[]> {
    const map = await this.load();
    let blocks = Array.from(map.values());

    if (filter?.date) {
      const datePrefix = filter.date; // YYYY-MM-DD
      blocks = blocks.filter((b) => {
        if (b.start) return b.start.startsWith(datePrefix);
        if (b.dueAt) return b.dueAt.startsWith(datePrefix);
        return false;
      });
    }

    if (filter?.status) {
      blocks = blocks.filter((b) => b.status === filter.status);
    }

    if (filter?.type) {
      blocks = blocks.filter((b) => b.type === filter.type);
    }

    // Sort by start time / dueAt
    blocks.sort((a, b) => {
      const aTime = a.start || a.dueAt || a.createdAt;
      const bTime = b.start || b.dueAt || b.createdAt;
      return aTime.localeCompare(bTime);
    });

    return blocks;
  }

  async get(id: string): Promise<SchedulingBlock | null> {
    const map = await this.load();
    return map.get(id) ?? null;
  }

  async create(opts: {
    type: BlockType;
    title: string;
    start?: string;
    end?: string;
    dueAt?: string;
    boardItemId?: string;
    tags?: string[];
  }): Promise<SchedulingBlock> {
    const now = new Date().toISOString();
    const block: SchedulingBlock = {
      id: generateId(),
      type: opts.type,
      title: opts.title,
      start: opts.start,
      end: opts.end,
      dueAt: opts.dueAt,
      boardItemId: opts.boardItemId,
      status: "planned",
      tags: opts.tags,
      createdAt: now,
      updatedAt: now,
    };

    await appendBrainLine(this.filePath, JSON.stringify(block));
    this.invalidate();
    log.info(`Created block ${block.id}: ${block.title}`);
    return block;
  }

  async update(id: string, changes: Partial<Pick<SchedulingBlock, "title" | "type" | "start" | "end" | "dueAt" | "boardItemId" | "status" | "outcome" | "tags">>): Promise<SchedulingBlock | null> {
    const existing = await this.get(id);
    if (!existing) return null;

    const updated: SchedulingBlock = {
      ...existing,
      ...changes,
      updatedAt: new Date().toISOString(),
    };

    await appendBrainLine(this.filePath, JSON.stringify(updated));
    this.invalidate();
    log.info(`Updated block ${id}: status=${updated.status}`);
    return updated;
  }

  // ── Day schedule ──────────────────────────────────────────────────────────

  async getToday(): Promise<DaySchedule> {
    const today = new Date().toISOString().slice(0, 10);
    const blocks = await this.list({ date: today });

    const stats = {
      total: blocks.length,
      planned: 0,
      active: 0,
      completed: 0,
      skipped: 0,
      cancelled: 0,
    };

    for (const b of blocks) {
      if (b.status in stats) {
        (stats as Record<string, number>)[b.status]++;
      }
    }

    return { date: today, blocks, stats };
  }

  // ── Timer helpers ─────────────────────────────────────────────────────────

  /** Get blocks starting within the next N milliseconds. */
  async getUpcoming(withinMs: number): Promise<SchedulingBlock[]> {
    const map = await this.load();
    const now = Date.now();
    const horizon = now + withinMs;
    const results: SchedulingBlock[] = [];

    for (const block of map.values()) {
      if (block.status !== "planned") continue;
      if (!block.start) continue;

      const startTime = new Date(block.start).getTime();
      if (startTime > now && startTime <= horizon) {
        results.push(block);
      }
    }

    return results;
  }

  /** Get blocks that are overdue (past end time, still planned). */
  async getOverdue(): Promise<SchedulingBlock[]> {
    const map = await this.load();
    const now = Date.now();
    const results: SchedulingBlock[] = [];

    for (const block of map.values()) {
      if (block.status !== "planned") continue;

      if (block.end) {
        const endTime = new Date(block.end).getTime();
        if (endTime < now) {
          results.push(block);
        }
      } else if (block.dueAt) {
        const dueTime = new Date(block.dueAt).getTime();
        if (dueTime < now) {
          results.push(block);
        }
      }
    }

    return results;
  }

  /** Get blocks whose start time has arrived but are still planned. */
  async getReadyToActivate(): Promise<SchedulingBlock[]> {
    const map = await this.load();
    const now = Date.now();
    const results: SchedulingBlock[] = [];

    for (const block of map.values()) {
      if (block.status !== "planned") continue;
      if (!block.start) continue;

      const startTime = new Date(block.start).getTime();
      const endTime = block.end ? new Date(block.end).getTime() : Infinity;
      if (startTime <= now && endTime > now) {
        results.push(block);
      }
    }

    return results;
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────

let _store: SchedulingStore | null = null;

export function createSchedulingStore(brainDir: string): SchedulingStore {
  if (_store) return _store;
  _store = new SchedulingStore(brainDir);
  return _store;
}

export function getSchedulingStore(): SchedulingStore | null {
  return _store;
}
