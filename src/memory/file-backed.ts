/**
 * Long-term memory backed by the brain/ file system (Personal Brain OS).
 * Append-only JSONL: experiences (episodic), semantic.jsonl, procedural.jsonl.
 * All memory files encrypted at rest when encryption key is available.
 *
 * v2 brain: files live under brain/log/memory/
 * Legacy: files live under brain/memory/
 * Constructor accepts either — caller resolves via resolveBrainDir("memory").
 */

import { join } from "node:path";
import type { LongTermMemoryType, MemoryEntry } from "../types.js";
import type { LongTermMemoryStore } from "./long-term.js";
import { VectorIndex } from "./vector-index.js";
import { readBrainLines, appendBrainLine, ensureBrainJsonl } from "../lib/brain-io.js";
import { setEncryptionKey, clearEncryptionKey } from "../lib/key-store.js";

const TYPE_TO_FILE: Record<LongTermMemoryType, string> = {
  episodic: "experiences.jsonl",
  semantic: "semantic.jsonl",
  procedural: "procedural.jsonl",
};

function generateId(): string {
  return `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

/** Ensure the memory directory and file exist; first line is schema if missing. */
async function ensureFile(
  filePath: string,
  schema: { _schema: string; _version: string },
): Promise<void> {
  await ensureBrainJsonl(filePath, JSON.stringify(schema));
}

/**
 * File-backed LTM: reads/writes brain/memory/*.jsonl.
 * Append-only: add() only appends a line; never overwrites.
 * All memory files encrypted at rest via brain-io.
 */
export class FileSystemLongTermMemory implements LongTermMemoryStore {
  private vectorIndex: VectorIndex;

  constructor(private readonly basePath: string, encryptionKey?: Buffer) {
    // Wire the key into the shared key-store so brain-io can use it.
    if (encryptionKey) {
      setEncryptionKey(encryptionKey);
    } else {
      clearEncryptionKey();
    }
    this.vectorIndex = new VectorIndex(basePath);
  }

  /** Initialize vector index: load embeddings, backfill missing entries. */
  async init(): Promise<void> {
    const allEntries = await this.list();
    await this.vectorIndex.init(
      allEntries.map((e) => ({ id: e.id, content: e.content }))
    );
  }

  private path(file: string): string {
    return join(this.basePath, file);
  }

  private async readLines(fileName: string): Promise<string[]> {
    return readBrainLines(this.path(fileName));
  }

  /**
   * Collect IDs that have been archived (lines with status:"archived").
   * Then return only entries whose ID is not in that set.
   */
  private parseFile(lines: string[]): MemoryEntry[] {
    const archived = new Set<string>();
    const entries: MemoryEntry[] = [];
    for (const line of lines) {
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        if (obj._schema) continue;
        if (obj.status === "archived" && typeof obj.id === "string") {
          archived.add(obj.id);
          continue;
        }
        entries.push(obj as unknown as MemoryEntry);
      } catch { continue; }
    }
    return entries.filter((e) => !archived.has(e.id));
  }

  async list(type?: LongTermMemoryType): Promise<MemoryEntry[]> {
    if (type) {
      const lines = await this.readLines(TYPE_TO_FILE[type]);
      const entries = this.parseFile(lines);
      return entries.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    }
    // Read all JSONL files in parallel instead of sequentially
    const files = Object.values(TYPE_TO_FILE);
    const allLines = await Promise.all(files.map((file) => this.readLines(file)));
    const all: MemoryEntry[] = [];
    for (const lines of allLines) {
      all.push(...this.parseFile(lines));
    }
    return all.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  async add(entry: Omit<MemoryEntry, "id" | "createdAt">): Promise<MemoryEntry> {
    const full: MemoryEntry = {
      ...entry,
      id: generateId(),
      createdAt: new Date().toISOString(),
    };
    const file = TYPE_TO_FILE[entry.type];
    const p = this.path(file);
    await ensureFile(p, { _schema: entry.type, _version: "1.0" });
    await appendBrainLine(p, JSON.stringify(full));

    // Fire-and-forget vector embedding — never blocks writes
    if (this.vectorIndex.available) {
      this.vectorIndex.addEntry(full.id, full.content).catch(() => {});
    }

    return full;
  }

  async get(id: string): Promise<MemoryEntry | null> {
    const all = await this.list();
    return all.find((e) => e.id === id) ?? null;
  }

  async delete(id: string): Promise<boolean> {
    // Append-only: we do not support delete (would require rewrite). Return false so caller knows.
    return false;
  }

  async search(query: {
    type?: LongTermMemoryType;
    contentSubstring?: string;
    meta?: Record<string, unknown>;
  }): Promise<MemoryEntry[]> {
    let list = await this.list(query.type);

    // Keyword filtering (existing behavior)
    let keywordResults: MemoryEntry[] = list;
    if (query.contentSubstring) {
      const terms = query.contentSubstring
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length > 2);
      if (terms.length > 0) {
        keywordResults = list.filter((e) =>
          e.content && terms.some((term) => e.content.toLowerCase().includes(term))
        );
      }
    }
    if (query.meta && Object.keys(query.meta).length > 0) {
      keywordResults = keywordResults.filter((e) => {
        if (!e.meta) return false;
        return Object.entries(query.meta!).every(([k, v]) => e.meta![k] === v);
      });
    }

    // If vector index unavailable or no text query, return keyword-only
    if (!this.vectorIndex.available || !query.contentSubstring) {
      return keywordResults.sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
    }

    // Vector search
    try {
      const vectorHits = await this.vectorIndex.searchByText(
        query.contentSubstring,
        20
      );

      // Build lookup for all entries by id
      const entryMap = new Map(list.map((e) => [e.id, e]));

      // Merge via Reciprocal Rank Fusion
      const merged = mergeRRF(keywordResults, vectorHits, entryMap);
      return merged;
    } catch {
      // Vector search failed — fall back to keyword-only
      return keywordResults.sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
    }
  }
}

/**
 * Reciprocal Rank Fusion: merges keyword + vector results without score normalization.
 * RRF_score(entry) = Σ 1/(k + rank)  where k=60
 */
function mergeRRF(
  keywordResults: MemoryEntry[],
  vectorHits: Array<{ id: string; score: number }>,
  entryMap: Map<string, MemoryEntry>
): MemoryEntry[] {
  const k = 60;
  const scores = new Map<string, number>();

  // Keyword ranks
  for (let i = 0; i < keywordResults.length; i++) {
    const id = keywordResults[i].id;
    scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1));
  }

  // Vector ranks
  for (let i = 0; i < vectorHits.length; i++) {
    const id = vectorHits[i].id;
    scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1));
  }

  // Sort by fused score descending
  const ranked = Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => entryMap.get(id))
    .filter((e): e is MemoryEntry => e !== undefined);

  return ranked;
}
