/**
 * Ollama (local) LLM provider for Dash.
 * Wraps the existing Ollama streaming + completion logic behind the LLMProvider interface.
 */

import type { ContextMessage } from "../../types.js";
import type { LLMProvider, StreamOptions } from "./types.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("llm.provider.ollama");

const DEFAULT_CHAT_MODEL = "llama3.1:8b";
const DEFAULT_UTILITY_MODEL = "llama3.1:8b";

// Models ranked by quality for chat (best first). Auto picks the largest one available.
const CHAT_MODEL_RANK = [
  "qwen3:8b",
  "llama3.1:8b",
  "llama3:latest",
  "gemma3:4b",
  "phi3:latest",
  "llama3.2:3b",
  "llama3.2:1b",
  "tinyllama:latest",
];

// Embedding/utility models to exclude from chat selection
const NON_CHAT_MODELS = new Set(["nomic-embed-text:latest"]);

function getBaseUrl(): string {
  return process.env.OLLAMA_URL ?? "http://localhost:11434";
}

/** Cached best model — refreshed on each call to bestLocalModel() */
let _cachedBestModel: string | null = null;
let _cachedAt = 0;
const CACHE_TTL = 60_000; // 1 minute

/**
 * Query Ollama for available models and pick the best chat model.
 * Prefers models in CHAT_MODEL_RANK order. Falls back to the largest
 * non-embedding model if none match the ranking.
 */
export async function bestLocalModel(): Promise<string> {
  if (_cachedBestModel && Date.now() - _cachedAt < CACHE_TTL) return _cachedBestModel;

  const baseUrl = getBaseUrl();
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return DEFAULT_CHAT_MODEL;

    const data = (await res.json()) as { models: Array<{ name: string; size: number }> };
    const available = new Set(data.models.map((m) => m.name));

    // First: try ranked models in preference order
    for (const model of CHAT_MODEL_RANK) {
      if (available.has(model)) {
        _cachedBestModel = model;
        _cachedAt = Date.now();
        log.info("Auto-selected local model", { model, method: "ranked" });
        return model;
      }
    }

    // Fallback: pick the largest non-embedding model
    const chatModels = data.models
      .filter((m) => !NON_CHAT_MODELS.has(m.name))
      .sort((a, b) => b.size - a.size);

    if (chatModels.length > 0) {
      _cachedBestModel = chatModels[0].name;
      _cachedAt = Date.now();
      log.info("Auto-selected local model", { model: _cachedBestModel, method: "largest" });
      return _cachedBestModel;
    }
  } catch {
    // Ollama unreachable
  }
  return DEFAULT_CHAT_MODEL;
}

function formatMessages(messages: ContextMessage[]) {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

export const ollamaProvider: LLMProvider = {
  name: "ollama",
  defaultChatModel: DEFAULT_CHAT_MODEL,
  defaultUtilityModel: DEFAULT_UTILITY_MODEL,

  async streamChat(options: StreamOptions): Promise<void> {
    const baseUrl = getBaseUrl();
    const model = options.model ?? process.env.OLLAMA_MODEL ?? DEFAULT_CHAT_MODEL;
    log.debug("Streaming chat request", { model, messageCount: options.messages.length });

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: formatMessages(options.messages),
          stream: true,
        }),
        signal: options.signal,
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.error("Stream connection failed", { model, error: error.message });
      options.onError(error);
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
            const content = parsed.message?.content;
            if (content) options.onToken(content);
            if (parsed.done) {
              options.onDone();
              return;
            }
          } catch {
            // Skip malformed lines
          }
        }
      }
      options.onDone();
    } catch (err) {
      if (options.signal?.aborted) return;
      options.onError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      reader.releaseLock();
    }
  },

  async completeChat(
    messages: ContextMessage[],
    model?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const baseUrl = getBaseUrl();
    const resolvedModel = model ?? process.env.OLLAMA_MODEL ?? DEFAULT_UTILITY_MODEL;
    log.debug("Completion request", { model: resolvedModel, messageCount: messages.length });

    const response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: resolvedModel,
        messages: formatMessages(messages),
        stream: false,
      }),
      signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "unknown error");
      log.error("Ollama API error", { status: response.status, body: text, model: resolvedModel });
      throw new Error(`Ollama ${response.status}: ${text}`);
    }

    const data = (await response.json()) as {
      message?: { content?: string };
    };

    const content = data.message?.content;
    if (!content) throw new Error("No content in Ollama response");
    log.debug("Completion received", { model: resolvedModel, responseLength: content.length });
    return content;
  },

  async isAvailable(): Promise<boolean> {
    const baseUrl = getBaseUrl();
    try {
      const res = await fetch(`${baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      return res.ok;
    } catch {
      return false;
    }
  },
};
