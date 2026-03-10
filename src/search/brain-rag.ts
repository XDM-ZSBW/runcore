/**
 * Brain RAG — semantic retrieval for brain files.
 *
 * Indexes brain files into chunks with Ollama embeddings.
 * Stores in brain/memory/file-embeddings.jsonl (append-only).
 * In-memory cosine similarity search over chunk vectors.
 *
 * The vector index is a derived cache. Delete the file, re-index from brain.
 */

import { join, relative, basename, dirname } from "node:path";
import { readdir, stat } from "node:fs/promises";
import { createLogger } from "../utils/logger.js";
import { readBrainFile, readBrainLines, appendBrainLine } from "../lib/brain-io.js";
import { BRAIN_DIR, FILES_DIR, resolveBrainDir } from "../lib/paths.js";
import { embed, embedBatch, isOllamaAvailable, cosine } from "./embedder.js";
import { chunkMarkdown, type Chunk } from "./chunker.js";

const log = createLogger("brain-rag");

const FILE_EMBEDDINGS = "file-embeddings.jsonl";
const BATCH_SIZE = 10;
const SEARCHABLE_EXTS = new Set([".md", ".yaml", ".yml", ".txt"]);
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".obsidian", "logs", "tasks",
  "daily", "hourly", "memory", "ops", "metrics", "ledger",
  ".config",
]);
const MAX_FILE_SIZE = 500_000; // 500KB

/** Directories to scan for brain files. */
const SCAN_DIRS = [
  FILES_DIR,
  resolveBrainDir("content"),
  resolveBrainDir("knowledge"),
  resolveBrainDir("identity"),
  resolveBrainDir("operations"),
  resolveBrainDir("skills"),
  resolveBrainDir("templates"),
];

// ── Persisted chunk embedding line ───────────────────────────────────────────

interface ChunkLine {
  id: string;
  filePath: string;
  heading: string;
  index: number;
  mtime: number;
  v: number[];
}

// ── In-memory chunk record ───────────────────────────────────────────────────

interface ChunkRecord {
  id: string;
  filePath: string;
  heading: string;
  index: number;
  mtime: number;
  text?: string; // only populated after chunking, not persisted in vec store
  vec: Float32Array;
}

// ── Public types ─────────────────────────────────────────────────────────────

export interface RAGResult {
  filePath: string;
  heading: string;
  chunk: string;
  score: number;
  fullPath: string;
  /** Other files in the same directory (sibling listing for option B) */
  siblings?: string[];
}

// ── BrainRAG class ───────────────────────────────────────────────────────────

export class BrainRAG {
  private chunks = new Map<string, ChunkRecord>();
  /** Track mtime per file so we know what's stale */
  private fileMtimes = new Map<string, number>();
  private embeddingsPath: string;
  private _ready = false;

  constructor() {
    this.embeddingsPath = join(BRAIN_DIR, "memory", FILE_EMBEDDINGS);
  }

  get ready(): boolean {
    return this._ready;
  }

  /** Load existing embeddings from disk. Fast — no Ollama needed. */
  async load(): Promise<void> {
    const lines = await readBrainLines(this.embeddingsPath);
    let loaded = 0;
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as ChunkLine;
        if (!entry.id || !entry.v) continue;
        // Last-write-wins: later lines for same ID supersede earlier
        this.chunks.set(entry.id, {
          id: entry.id,
          filePath: entry.filePath,
          heading: entry.heading,
          index: entry.index,
          mtime: entry.mtime,
          vec: new Float32Array(entry.v),
        });
        // Track highest mtime per file
        const existing = this.fileMtimes.get(entry.filePath) ?? 0;
        if (entry.mtime > existing) this.fileMtimes.set(entry.filePath, entry.mtime);
        loaded++;
      } catch { continue; }
    }
    this._ready = true;
    if (loaded > 0) log.info(`Loaded ${this.chunks.size} chunk embeddings from disk`);
  }

  /** Full index: scan all brain files, chunk and embed anything new or changed. */
  async indexAll(): Promise<{ indexed: number; skipped: number; errors: number }> {
    const available = await isOllamaAvailable();
    if (!available) {
      log.info("Ollama unavailable — skipping file indexing");
      return { indexed: 0, skipped: 0, errors: 0 };
    }

    let indexed = 0;
    let skipped = 0;
    let errors = 0;

    const seen = new Set<string>();
    for (const dir of SCAN_DIRS) {
      if (seen.has(dir)) continue;
      seen.add(dir);

      const files = await this.collectFiles(dir);
      for (const file of files) {
        try {
          const relPath = relative(BRAIN_DIR, file.path).replace(/\\/g, "/");
          const existingMtime = this.fileMtimes.get(relPath) ?? 0;

          if (file.mtime <= existingMtime) {
            skipped++;
            continue;
          }

          await this.indexFile(file.path);
          indexed++;
        } catch (err) {
          errors++;
          log.error(`Failed to index ${file.path}`, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    log.info(`Index complete: ${indexed} indexed, ${skipped} skipped, ${errors} errors (${this.chunks.size} total chunks)`);
    return { indexed, skipped, errors };
  }

  /** Index a single file: chunk, embed, persist. */
  async indexFile(filePath: string): Promise<void> {
    const relPath = relative(BRAIN_DIR, filePath).replace(/\\/g, "/");
    const content = await readBrainFile(filePath);
    const fileStat = await stat(filePath);
    const mtime = fileStat.mtimeMs;

    const fileChunks = chunkMarkdown(relPath, content);
    if (fileChunks.length === 0) return;

    // Embed in batches
    for (let i = 0; i < fileChunks.length; i += BATCH_SIZE) {
      const batch = fileChunks.slice(i, i + BATCH_SIZE);
      const texts = batch.map((c) => c.text);
      const vecs = await embedBatch(texts);

      for (let j = 0; j < batch.length; j++) {
        const chunk = batch[j];
        const record: ChunkRecord = {
          id: chunk.id,
          filePath: relPath,
          heading: chunk.heading,
          index: chunk.index,
          mtime,
          vec: vecs[j],
        };
        this.chunks.set(chunk.id, record);

        // Persist
        const line: ChunkLine = {
          id: chunk.id,
          filePath: relPath,
          heading: chunk.heading,
          index: chunk.index,
          mtime,
          v: Array.from(vecs[j]),
        };
        await appendBrainLine(this.embeddingsPath, JSON.stringify(line));
      }
    }

    this.fileMtimes.set(relPath, mtime);
    log.info(`Indexed ${relPath}: ${fileChunks.length} chunks`);
  }

  /** Semantic search: embed query, return top-k file chunks with scores. */
  async query(text: string, topK = 5): Promise<RAGResult[]> {
    if (this.chunks.size === 0) return [];

    const queryVec = await embed(text);
    const scored: Array<{ record: ChunkRecord; score: number }> = [];

    for (const record of this.chunks.values()) {
      const score = cosine(queryVec, record.vec);
      scored.push({ record, score });
    }

    scored.sort((a, b) => b.score - a.score);

    const topResults = scored.slice(0, topK);
    const results: RAGResult[] = [];

    for (const { record, score } of topResults) {
      if (score < 0.3) continue; // threshold

      const fullPath = join(BRAIN_DIR, record.filePath);

      // Option B: sibling listing
      const dir = dirname(fullPath);
      let siblings: string[] | undefined;
      try {
        const entries = await readdir(dir);
        const sibs = entries.filter((e) => e !== basename(record.filePath));
        if (sibs.length > 0) siblings = sibs;
      } catch { /* ignore */ }

      results.push({
        filePath: record.filePath,
        heading: record.heading,
        chunk: "", // caller reads full file; chunk text not persisted
        score,
        fullPath,
        siblings,
      });
    }

    // Deduplicate by filePath — keep highest score per file
    const byFile = new Map<string, RAGResult>();
    for (const r of results) {
      const existing = byFile.get(r.filePath);
      if (!existing || r.score > existing.score) {
        byFile.set(r.filePath, r);
      }
    }

    return Array.from(byFile.values()).sort((a, b) => b.score - a.score);
  }

  /** Force re-index: clear in-memory state and rebuild from files. */
  async reindex(): Promise<void> {
    this.chunks.clear();
    this.fileMtimes.clear();
    await this.indexAll();
  }

  // ── File collection ──────────────────────────────────────────────────────

  private async collectFiles(dir: string): Promise<Array<{ path: string; mtime: number }>> {
    const results: Array<{ path: string; mtime: number }> = [];

    const walk = async (d: string): Promise<void> => {
      let entries: string[];
      try { entries = await readdir(d); } catch { return; }
      for (const name of entries) {
        if (name.startsWith(".")) continue;
        if (SKIP_DIRS.has(name)) continue;
        const full = join(d, name);
        try {
          const s = await stat(full);
          if (s.isDirectory()) {
            await walk(full);
          } else {
            const ext = name.substring(name.lastIndexOf(".")).toLowerCase();
            if (SEARCHABLE_EXTS.has(ext) && s.size < MAX_FILE_SIZE) {
              results.push({ path: full, mtime: s.mtimeMs });
            }
          }
        } catch { continue; }
      }
    };

    await walk(dir);
    return results;
  }
}
