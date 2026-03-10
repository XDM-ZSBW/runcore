/**
 * Shared Ollama embedding client.
 * Used by both VectorIndex (memory) and BrainRAG (files).
 * Circuit breaker prevents hammering a dead Ollama instance.
 */

import { createLogger } from "../utils/logger.js";

const log = createLogger("embedder");

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const MODEL = process.env.EMBED_MODEL ?? "nomic-embed-text";
const BATCH_SIZE = 10;

// ── Circuit breaker ──────────────────────────────────────────────────────────

const AVAIL_CACHE_MS = 30_000;
const CIRCUIT_BREAKER_FAILURES = 3;
const CIRCUIT_BREAKER_COOLDOWN_MS = 5 * 60 * 1000;

let lastAvailCheck = 0;
let lastAvailResult = false;
let consecutiveFailures = 0;
let circuitOpenUntil = 0;

function recordFailure(): void {
  consecutiveFailures++;
  if (consecutiveFailures >= CIRCUIT_BREAKER_FAILURES) {
    circuitOpenUntil = Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS;
    log.warn(`Circuit breaker open: ${consecutiveFailures} failures — disabled for ${CIRCUIT_BREAKER_COOLDOWN_MS / 1000}s`);
  }
}

/** Check whether Ollama is reachable. Cached for 30s with circuit breaker. */
export async function isOllamaAvailable(): Promise<boolean> {
  const now = Date.now();
  if (now < circuitOpenUntil) return false;
  if (now - lastAvailCheck < AVAIL_CACHE_MS) return lastAvailResult;

  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, {
      signal: AbortSignal.timeout(1000),
    });
    lastAvailCheck = now;
    lastAvailResult = res.ok;
    if (res.ok) {
      if (consecutiveFailures > 0) log.info("Ollama connectivity restored");
      consecutiveFailures = 0;
    } else {
      recordFailure();
    }
    return res.ok;
  } catch {
    lastAvailCheck = now;
    lastAvailResult = false;
    recordFailure();
    return false;
  }
}

// ── Embedding ────────────────────────────────────────────────────────────────

/** Embed a single text. Returns Float32Array. */
export async function embed(text: string): Promise<Float32Array> {
  const res = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, input: text }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Ollama embed failed: ${res.status}`);
  const data = (await res.json()) as { embeddings: number[][] };
  return new Float32Array(data.embeddings[0]);
}

/** Embed a batch of texts. Returns array of Float32Array. */
export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  const res = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, input: texts }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Ollama batch embed failed: ${res.status}`);
  const data = (await res.json()) as { embeddings: number[][] };
  return data.embeddings.map((v) => new Float32Array(v));
}

/** Embed in batches of BATCH_SIZE, calling onBatch after each. */
export async function embedInBatches(
  texts: string[],
  onBatch?: (startIndex: number, vecs: Float32Array[]) => Promise<void>,
): Promise<Float32Array[]> {
  const all: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const vecs = await embedBatch(batch);
    all.push(...vecs);
    if (onBatch) await onBatch(i, vecs);
  }
  return all;
}

/** Cosine similarity between two vectors. */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
