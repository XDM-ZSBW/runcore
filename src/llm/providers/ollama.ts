/**
 * Ollama (local) LLM provider for Dash.
 * Wraps the existing Ollama streaming + completion logic behind the LLMProvider interface.
 */

import type { ContextMessage } from "../../types.js";
import type { LLMProvider, StreamOptions } from "./types.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("llm.provider.ollama");

const DEFAULT_CHAT_MODEL = "llama3.2:3b";
const DEFAULT_UTILITY_MODEL = "llama3.2:3b";

// Models ranked by quality for chat (best first). Auto picks the best available.
const CHAT_MODEL_RANK = [
  "qwen2.5-coder:7b",
  "llama3.2:3b",
  "gemma3:4b",
  "phi3:latest",
  "qwen3:8b",
  "llama3.1:8b",
  "llama3:latest",
  "llama3.2:1b",
  "tinyllama:latest",
];

// Models ranked for coding/agent tasks (best first). Used by bestLocalCodingModel().
const CODING_MODEL_RANK = [
  "qwen2.5-coder:32b",
  "qwen2.5-coder:14b",
  "qwen2.5-coder:7b",
  "qwen2.5-coder:3b",
  "deepseek-coder-v2:16b",
  "deepseek-coder:6.7b",
  "codellama:34b",
  "codellama:13b",
  "codellama:7b",
  "qwen3:8b",
  "llama3.1:8b",
];

// Embedding/utility models to exclude from chat selection
const NON_CHAT_MODELS = new Set(["nomic-embed-text:latest"]);

function getBaseUrl(): string {
  return process.env.OLLAMA_URL ?? "http://localhost:11434";
}

/** Cached best model — refreshed on each call to bestLocalModel() */
let _cachedBestModel: string | null = null;
let _cachedAt = 0;
const CACHE_TTL = 3_600_000; // 1 hour — benchmark is expensive, cache aggressively

/**
 * Benchmark a single model: send a short prompt, measure time to completion.
 * Returns tokens/sec or null if the model fails/times out.
 */
async function benchmarkModel(baseUrl: string, model: string): Promise<{ tokPerSec: number } | null> {
  try {
    const start = Date.now();
    const res = await fetch(`${baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: "Say hello in one sentence.", stream: false, options: { num_predict: 20 } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { eval_count?: number; eval_duration?: number };
    const elapsed = Date.now() - start;
    // Ollama returns eval_duration in nanoseconds
    if (data.eval_count && data.eval_duration) {
      const tokPerSec = data.eval_count / (data.eval_duration / 1e9);
      return { tokPerSec };
    }
    // Fallback: estimate from wall time
    return { tokPerSec: 20 / (elapsed / 1000) };
  } catch {
    return null;
  }
}

/**
 * Query Ollama for available models and pick the best chat model.
 * On first run, benchmarks available ranked models and picks the fastest.
 * Results are cached for the session.
 */
export async function bestLocalModel(): Promise<string> {
  if (_cachedBestModel && Date.now() - _cachedAt < CACHE_TTL) return _cachedBestModel;

  const baseUrl = getBaseUrl();
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return DEFAULT_CHAT_MODEL;

    const data = (await res.json()) as { models: Array<{ name: string; size: number }> };
    const available = new Set(data.models.map((m) => m.name));

    // Find which ranked models are available
    const candidates = CHAT_MODEL_RANK.filter((m) => available.has(m));

    if (candidates.length === 1) {
      _cachedBestModel = candidates[0];
      _cachedAt = Date.now();
      log.info("Auto-selected local model", { model: _cachedBestModel, method: "only-candidate" });
      return _cachedBestModel;
    }

    if (candidates.length > 1) {
      // Benchmark each candidate — pick fastest
      log.info("Benchmarking local models", { candidates });
      let bestModel = candidates[0];
      let bestTps = 0;

      for (const model of candidates) {
        const result = await benchmarkModel(baseUrl, model);
        if (result && result.tokPerSec > bestTps) {
          bestTps = result.tokPerSec;
          bestModel = model;
        }
        log.info("Benchmark result", { model, tokPerSec: result?.tokPerSec ?? 0 });
      }

      _cachedBestModel = bestModel;
      _cachedAt = Date.now();
      log.info("Auto-selected local model", { model: bestModel, method: "benchmark", tokPerSec: bestTps.toFixed(1) });
      return bestModel;
    }

    // No ranked models found — pick the largest non-embedding model
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

/**
 * Pick the best available local coding model from Ollama.
 * Prefers purpose-built coding models over general-purpose ones.
 */
export async function bestLocalCodingModel(): Promise<string> {
  const baseUrl = getBaseUrl();
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return "qwen2.5-coder:7b";

    const data = (await res.json()) as { models: Array<{ name: string; size: number }> };
    const available = new Set(data.models.map((m) => m.name));

    // Find the best coding model that's actually pulled
    for (const model of CODING_MODEL_RANK) {
      if (available.has(model)) {
        log.info("Auto-selected local coding model", { model });
        return model;
      }
    }

    // Fallback: any model with "coder" in the name
    const coderModel = data.models.find((m) => m.name.includes("coder"));
    if (coderModel) {
      log.info("Auto-selected local coding model (by name)", { model: coderModel.name });
      return coderModel.name;
    }
  } catch {
    // Ollama unreachable
  }
  return "qwen2.5-coder:7b";
}

function formatMessages(messages: ContextMessage[]) {
  return messages.map((m) => {
    const msg: Record<string, unknown> = { role: m.role, content: m.content };
    if (m.tool_calls) msg.tool_calls = m.tool_calls;
    if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
    return msg;
  });
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
      const body: Record<string, unknown> = {
        model,
        messages: formatMessages(options.messages),
        stream: true,
      };
      if (options.tools && options.tools.length > 0) {
        body.tools = options.tools;
      }
      response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
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
              // Ollama returns tool_calls in the final message when done
              const toolCalls = parsed.message?.tool_calls;
              if (toolCalls && toolCalls.length > 0 && options.onToolCalls) {
                const formatted = toolCalls.map(
                  (tc: { function: { name: string; arguments: Record<string, unknown> } }, i: number) => ({
                    id: `ollama-tc-${Date.now()}-${i}`,
                    function: {
                      name: tc.function.name,
                      arguments: JSON.stringify(tc.function.arguments),
                    },
                  }),
                );
                options.onToolCalls(formatted);
              } else {
                options.onDone();
              }
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
