/**
 * Vector embedding index backed by Ollama (nomic-embed-text).
 * Stores embeddings in brain/memory/embeddings.jsonl (append-only).
 * Supports transparent encryption at rest when an encryption key is provided.
 * Pure TypeScript cosine similarity — no external vector DB.
 *
 * Embedding and similarity functions are shared via search/embedder.ts.
 */

import { join } from "node:path";
import { createLogger } from "../utils/logger.js";
import { readBrainLines, appendBrainLine } from "../lib/brain-io.js";
import {
  embed,
  embedBatch,
  isOllamaAvailable,
  cosine,
} from "../search/embedder.js";

const log = createLogger("vector-index");

const BATCH_SIZE = 10;
const EMBEDDINGS_FILE = "embeddings.jsonl";

interface EmbeddingLine {
  id: string;
  v: number[];
}

export class VectorIndex {
  private vectors = new Map<string, Float32Array>();
  private filePath: string;
  available = false;

  constructor(basePath: string, _encryptionKey?: Buffer) {
    // Encryption key param kept for API compat but encryption is now
    // handled centrally by brain-io using the key-store.
    this.filePath = join(basePath, EMBEDDINGS_FILE);
  }

  /** Load existing embeddings from disk; backfill missing entries in background. */
  async init(
    allEntries?: Array<{ id: string; content: string }>
  ): Promise<void> {
    await this.loadFromDisk();

    // Check Ollama reachability (1s timeout to avoid blocking startup)
    this.available = await isOllamaAvailable();
    if (!this.available) {
      log.info("Ollama unreachable, running keyword-only");
      return;
    }

    // Fire-and-forget backfill — never block startup for embedding generation
    if (allEntries && allEntries.length > 0) {
      const missing = allEntries.filter((e) => !this.vectors.has(e.id));
      if (missing.length > 0) {
        this.backfill(missing).catch((err) => {
          log.error("Background backfill failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    }
  }

  /** Check whether Ollama is reachable. Delegates to shared embedder. */
  async isAvailable(): Promise<boolean> {
    return isOllamaAvailable();
  }

  /** Embed a single text via Ollama. */
  async embed(text: string): Promise<Float32Array> {
    return embed(text);
  }

  /** Add a single entry: embed and persist. */
  async addEntry(id: string, content: string): Promise<void> {
    const vec = await embed(content);
    this.vectors.set(id, vec);
    await this.appendLine({ id, v: Array.from(vec) });
  }

  /** Batch-embed entries missing vectors (migration/backfill). */
  async backfill(
    entries: Array<{ id: string; content: string }>
  ): Promise<void> {
    const start = Date.now();
    let count = 0;

    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
      const batch = entries.slice(i, i + BATCH_SIZE);
      const texts = batch.map((e) => e.content);

      try {
        const vecs = await embedBatch(texts);

        for (let j = 0; j < batch.length; j++) {
          this.vectors.set(batch[j].id, vecs[j]);
          await appendBrainLine(
            this.filePath,
            JSON.stringify({ id: batch[j].id, v: Array.from(vecs[j]) }),
          );
        }

        count += batch.length;
      } catch (err) {
        log.error(`Backfill batch failed at offset ${i}`, { error: err instanceof Error ? err.message : String(err) });
        break;
      }
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    log.info(`Backfilled ${count}/${entries.length} entries (${elapsed}s)`);
  }

  /** Check if an entry has an embedding. */
  has(id: string): boolean {
    return this.vectors.has(id);
  }

  /** Search by pre-computed query vector. Returns ranked IDs with scores. */
  search(
    queryVec: Float32Array,
    topN: number
  ): Array<{ id: string; score: number }> {
    const results: Array<{ id: string; score: number }> = [];

    for (const [id, vec] of this.vectors) {
      const score = cosine(queryVec, vec);
      results.push({ id, score });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topN);
  }

  /** Convenience: embed query text then search. */
  async searchByText(
    query: string,
    topN: number
  ): Promise<Array<{ id: string; score: number }>> {
    const queryVec = await embed(query);
    return this.search(queryVec, topN);
  }

  /** Load embeddings.jsonl into memory. */
  private async loadFromDisk(): Promise<void> {
    const lines = await readBrainLines(this.filePath);
    if (lines.length === 0) return;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as EmbeddingLine;
        if (entry.id && entry.v) {
          this.vectors.set(entry.id, new Float32Array(entry.v));
        }
      } catch {
        continue;
      }
    }

    log.info(`Loaded ${this.vectors.size} embeddings from disk`);
  }

  /** Append a single embedding line to the JSONL file. */
  private async appendLine(entry: EmbeddingLine): Promise<void> {
    await appendBrainLine(this.filePath, JSON.stringify(entry));
  }
}
