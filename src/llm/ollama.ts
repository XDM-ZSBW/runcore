/**
 * Streaming Ollama client for Core.
 * Local-first language processing — private, no cloud, no API key.
 * Default model: llama3.2:3b (fits 3060 12GB comfortably).
 */

import type { ContextMessage } from "../types.js";
import type { StreamOptions } from "./openrouter.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("llm.ollama");

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const DEFAULT_MODEL = "llama3.2:3b";

/**
 * Check if Ollama is reachable and the model is available.
 * Returns { available, model, error? }.
 */
export async function checkOllama(model?: string): Promise<{ available: boolean; model: string; error?: string }> {
  const m = model ?? process.env.OLLAMA_MODEL ?? DEFAULT_MODEL;
  try {
    // Check if Ollama is running
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { available: false, model: m, error: "Ollama not responding" };

    const data = await res.json() as { models?: Array<{ name: string }> };
    const models = data.models ?? [];
    const found = models.some((entry) => entry.name === m || entry.name.startsWith(m + ":"));

    if (!found) {
      return { available: false, model: m, error: `Model "${m}" not found. Run: ollama pull ${m}` };
    }

    return { available: true, model: m };
  } catch {
    log.warn("Ollama not reachable", { url: OLLAMA_URL, model: m });
    return { available: false, model: m, error: "Ollama not reachable at " + OLLAMA_URL };
  }
}

/**
 * Warm up: preload model into Ollama's memory so first chat is instant.
 * Sends a minimal request that loads weights without generating much.
 */
export async function warmupOllama(model?: string): Promise<void> {
  const m = model ?? process.env.OLLAMA_MODEL ?? DEFAULT_MODEL;
  try {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: m, prompt: "hi", stream: false, options: { num_predict: 1 } }),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.ok) {
      log.info("Model warmed up", { model: m });
    }
  } catch {
    // Non-fatal — model will load on first real request
  }
}

/**
 * Stream a chat completion from Ollama (local).
 * Same interface as OpenRouter's streamChat — drop-in swap.
 */
export async function streamChatLocal(options: StreamOptions): Promise<void> {
  const model = options.model ?? process.env.OLLAMA_MODEL ?? DEFAULT_MODEL;
  log.debug("Ollama streaming chat request", { model, messageCount: options.messages.length });

  const body = {
    model,
    messages: options.messages.map((m) => ({
      role: m.role,
      content: m.content, // string or ContentBlock[] — Ollama handles both
    })),
    stream: true,
  };

  let response: Response;
  try {
    response = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: options.signal,
    });
  } catch (err) {
    log.error("Ollama stream connection failed", { model, error: (err instanceof Error ? err : new Error(String(err))).message });
    options.onError(err instanceof Error ? err : new Error(String(err)));
    return;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "unknown error");
    log.error("Ollama stream API error", { status: response.status, body: text, model });
    options.onError(new Error(`Ollama ${response.status}: ${text}`));
    return;
  }

  const reader = response.body?.getReader();
  if (!reader) {
    options.onError(new Error("No response body"));
    return;
  }

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const parsed = JSON.parse(line);
          // Ollama format: { message: { content: "..." }, done: false }
          const content = parsed.message?.content;
          if (content) {
            options.onToken(content);
          }
          if (parsed.done) {
            options.onDone();
            return;
          }
        } catch {
          // Skip malformed lines
        }
      }
    }
    // Stream ended without done:true
    options.onDone();
  } catch (err) {
    if (options.signal?.aborted) return;
    options.onError(err instanceof Error ? err : new Error(String(err)));
  } finally {
    reader.releaseLock();
  }
}
