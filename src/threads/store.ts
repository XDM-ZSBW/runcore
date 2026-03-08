/**
 * Thread store — append-only JSONL persistence for ChatThread.
 *
 * File: brain/operations/threads.jsonl
 * Update strategy: append full updated thread. On load, last occurrence per id wins.
 */

import { join } from "node:path";
import { stat } from "node:fs/promises";
import type { ChatThread } from "./types.js";
import { createLogger } from "../utils/logger.js";
import { readBrainLines, appendBrainLine, writeBrainLines, ensureBrainJsonl } from "../lib/brain-io.js";

const log = createLogger("threads.store");

const SCHEMA_LINE = JSON.stringify({ _schema: "threads", _version: "1.0" });

function generateId(): string {
  return `th_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

export class ThreadStore {
  private readonly filePath: string;
  private cache: Map<string, ChatThread> | null = null;
  private lastMtime = 0;
  private lastStaleCheckMs = 0;

  constructor(brainDir: string) {
    this.filePath = join(brainDir, "operations", "threads.jsonl");
  }

  private async ensureFile(): Promise<void> {
    await ensureBrainJsonl(this.filePath, SCHEMA_LINE);
  }

  private async load(): Promise<Map<string, ChatThread>> {
    if (this.cache) return this.cache;
    await this.ensureFile();

    const lines = await readBrainLines(this.filePath);
    const map = new Map<string, ChatThread>();

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj._schema) continue;
        if (!obj.id) continue;
        map.set(obj.id, obj as ChatThread);
      } catch {
        continue;
      }
    }

    this.cache = map;

    try {
      const s = await stat(this.filePath);
      this.lastMtime = s.mtimeMs;
    } catch {}

    log.info("threads loaded", { count: map.size });
    return map;
  }

  private async checkStale(): Promise<void> {
    if (!this.cache) return;
    const now = Date.now();
    if (now - this.lastStaleCheckMs < 5000) return;
    this.lastStaleCheckMs = now;
    try {
      const s = await stat(this.filePath);
      if (s.mtimeMs > this.lastMtime) {
        this.cache = null;
        await this.load();
      }
    } catch {}
  }

  private async append(thread: ChatThread): Promise<void> {
    await appendBrainLine(this.filePath, JSON.stringify(thread));
  }

  async list(): Promise<ChatThread[]> {
    await this.checkStale();
    const map = await this.load();
    return [...map.values()]
      .filter((t) => t.status !== "archived")
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(id: string): Promise<ChatThread | null> {
    const map = await this.load();
    const thread = map.get(id);
    if (!thread || thread.status === "archived") return null;
    return thread;
  }

  async getBySessionId(sessionId: string): Promise<ChatThread | null> {
    const map = await this.load();
    for (const thread of map.values()) {
      if (thread.sessionId === sessionId && thread.status !== "archived") return thread;
    }
    return null;
  }

  async create(opts: {
    title: string;
    summary?: string;
    sessionId: string;
    linkedBoardId?: string;
    origin?: "user" | "auto";
  }): Promise<ChatThread> {
    await this.load();

    const now = new Date().toISOString();
    const thread: ChatThread = {
      id: generateId(),
      title: opts.title,
      summary: opts.summary ?? "",
      createdAt: now,
      updatedAt: now,
      sessionId: opts.sessionId,
      status: "active",
      linkedBoardId: opts.linkedBoardId,
      origin: opts.origin ?? "user",
    };

    this.cache!.set(thread.id, thread);
    await this.append(thread);
    log.info("thread created", { id: thread.id, title: thread.title });
    return thread;
  }

  async update(id: string, changes: Partial<Pick<ChatThread,
    "title" | "summary" | "linkedBoardId"
  >>): Promise<ChatThread | null> {
    const map = await this.load();
    const existing = map.get(id);
    if (!existing || existing.status === "archived") return null;

    const updated: ChatThread = {
      ...existing,
      ...changes,
      updatedAt: new Date().toISOString(),
    };

    if (
      existing.title === updated.title &&
      existing.summary === updated.summary &&
      existing.linkedBoardId === updated.linkedBoardId
    ) {
      return existing;
    }

    map.set(id, updated);
    await this.append(updated);
    log.debug("thread updated", { id, changes: Object.keys(changes) });
    return updated;
  }

  async touch(id: string): Promise<void> {
    const map = await this.load();
    const existing = map.get(id);
    if (!existing || existing.status === "archived") return;

    const updated: ChatThread = {
      ...existing,
      updatedAt: new Date().toISOString(),
    };
    map.set(id, updated);
    await this.append(updated);
  }

  async archive(id: string): Promise<boolean> {
    const map = await this.load();
    const existing = map.get(id);
    if (!existing) return false;

    const archived: ChatThread = {
      ...existing,
      status: "archived",
      updatedAt: new Date().toISOString(),
    };
    map.set(id, archived);
    await this.append(archived);
    log.info("thread archived", { id, title: existing.title });
    return true;
  }

  async compact(): Promise<{ before: number; after: number }> {
    const map = await this.load();
    const threads = [...map.values()];
    const lines = [SCHEMA_LINE, ...threads.map((t) => JSON.stringify(t))];
    await writeBrainLines(this.filePath, lines);
    log.info("threads compacted", { count: threads.length });
    return { before: threads.length + 1, after: lines.length };
  }
}
