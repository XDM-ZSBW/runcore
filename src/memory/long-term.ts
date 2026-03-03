/**
 * Long-term memory: episodic, semantic, procedural (COALA-style).
 * In-memory store; can be swapped for a persistent backend.
 */

import type { LongTermMemoryType, MemoryEntry } from "../types.js";

export interface LongTermMemoryStore {
  /** List all entries, optionally by type. */
  list(type?: LongTermMemoryType): Promise<MemoryEntry[]>;
  /** Add an entry; returns the created entry with id. */
  add(entry: Omit<MemoryEntry, "id" | "createdAt">): Promise<MemoryEntry>;
  /** Get by id. */
  get(id: string): Promise<MemoryEntry | null>;
  /** Delete by id. */
  delete(id: string): Promise<boolean>;
  /** Search by content or meta (simple substring/metadata filter). */
  search(query: { type?: LongTermMemoryType; contentSubstring?: string; meta?: Record<string, unknown> }): Promise<MemoryEntry[]>;
}

function generateId(): string {
  return `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * In-memory LTM implementation.
 * Replace with a persistent store (e.g. vector DB for semantic search) as needed.
 */
export class InMemoryLongTermMemory implements LongTermMemoryStore {
  private entries: Map<string, MemoryEntry> = new Map();

  async list(type?: LongTermMemoryType): Promise<MemoryEntry[]> {
    let list = Array.from(this.entries.values());
    if (type) list = list.filter((e) => e.type === type);
    return list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  async add(entry: Omit<MemoryEntry, "id" | "createdAt">): Promise<MemoryEntry> {
    const full: MemoryEntry = {
      ...entry,
      id: generateId(),
      createdAt: new Date().toISOString(),
    };
    this.entries.set(full.id, full);
    return full;
  }

  async get(id: string): Promise<MemoryEntry | null> {
    return this.entries.get(id) ?? null;
  }

  async delete(id: string): Promise<boolean> {
    return this.entries.delete(id);
  }

  async search(query: {
    type?: LongTermMemoryType;
    contentSubstring?: string;
    meta?: Record<string, unknown>;
  }): Promise<MemoryEntry[]> {
    let list = Array.from(this.entries.values());
    if (query.type) list = list.filter((e) => e.type === query.type);
    if (query.contentSubstring) {
      const terms = query.contentSubstring
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length > 2);
      if (terms.length > 0) {
        list = list.filter((e) =>
          e.content && terms.some((term) => e.content.toLowerCase().includes(term))
        );
      }
    }
    if (query.meta && Object.keys(query.meta).length > 0) {
      list = list.filter((e) => {
        if (!e.meta) return false;
        return Object.entries(query.meta!).every(([k, v]) => e.meta![k] === v);
      });
    }
    return list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }
}
