/**
 * LLM call log — append-only JSONL receipt for every LLM call.
 *
 * Records the mechanical state of each call: which provider, which model,
 * how it was resolved, how long it took. No prompts, no responses, no content.
 * Just the state of the machine at the time of the turn.
 *
 * Writes to brain/memory/llm-calls.jsonl (data lives in brain, not code).
 */

import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BRAIN_DIR } from "../lib/paths.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("llm.call-log");

const LOG_PATH = join(BRAIN_DIR, "memory", "llm-calls.jsonl");
let ensuredDir = false;

export interface LlmCallEntry {
  /** ISO timestamp */
  ts: string;
  /** "stream" or "complete" */
  mode: "stream" | "complete";
  /** Provider that actually handled the call */
  provider: string;
  /** Model that was actually used */
  model: string;
  /** How the provider was resolved: "settings", "env", "taskRoute", "fallback", "privateMode" */
  routeSource?: string;
  /** Task type if routed via taskRoutes */
  taskType?: string;
  /** Agent ID if this call was made by a spawned agent */
  agentId?: string;
  /** Duration in ms */
  durationMs: number;
  /** Estimated input tokens (chars/4) */
  inputTokens?: number;
  /** Estimated output tokens (chars/4) */
  outputTokens?: number;
  /** Whether the call succeeded */
  ok: boolean;
  /** Error message on failure (no stack traces) */
  error?: string;
}

/**
 * Append a call receipt to the log. Fire-and-forget — never throws.
 */
export async function logLlmCall(entry: LlmCallEntry): Promise<void> {
  try {
    if (!ensuredDir) {
      await mkdir(join(BRAIN_DIR, "memory"), { recursive: true });
      ensuredDir = true;
    }
    const line = JSON.stringify(entry) + "\n";
    await appendFile(LOG_PATH, line, "utf-8");
  } catch (err) {
    log.warn("Failed to write call log", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
