/**
 * Non-streaming LLM completion for Core.
 * Used by background tasks (e.g. fact extraction) that need a full response, not a token stream.
 * Routes to the appropriate provider via the provider abstraction layer.
 * Includes an optional in-memory TTL cache to avoid redundant API calls.
 */

import type { ContextMessage } from "../types.js";
import type { ProviderName } from "./providers/types.js";
import { getProvider } from "./providers/index.js";
import { completeChatCached } from "./cache.js";
import { LLMError } from "./errors.js";
import { withRetry } from "./retry.js";
import { rehydrateResponse } from "./redact.js";
import { createLogger } from "../utils/logger.js";
import { recordLlmRequest } from "../metrics/collector.js";
import { logLlmCall } from "./call-log.js";

const log = createLogger("llm");

export interface CompleteChatOptions {
  messages: ContextMessage[];
  model?: string;
  provider: ProviderName;
  /** Skip cache for this request. */
  noCache?: boolean;
  /** Override default TTL for this request (ms). */
  cacheTTLMs?: number;
  /** How the provider/model was resolved (for call log). */
  routeSource?: string;
  /** Task type if routed via taskRoutes (for call log). */
  taskType?: string;
  /** Agent ID if called by a spawned agent (for call log). */
  agentId?: string;
}

/**
 * Non-streaming chat completion. Returns the full assistant response as a string.
 * Results are cached by default; pass `noCache: true` to bypass.
 * 60-second timeout to prevent hung calls.
 */
export async function completeChat(options: CompleteChatOptions): Promise<string> {
  if (options.noCache) return completeChatUncached(options);
  return completeChatCached(options, completeChatUncached, options.cacheTTLMs);
}

/** Estimate token count from text (chars / 4, consistent with context assembler). */
function estimateTokens(messages: ContextMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    if (m.content == null) continue;
    if (typeof m.content === "string") chars += m.content.length;
    else {
      for (const block of m.content) {
        if ("text" in block) chars += block.text.length;
      }
    }
  }
  return Math.ceil(chars / 4);
}

/** Direct LLM call without caching — routes to the configured provider. */
async function completeChatUncached(options: CompleteChatOptions): Promise<string> {
  const provider = getProvider(options.provider);
  const model = options.model ?? provider.defaultUtilityModel;

  log.debug("Completion request", {
    provider: options.provider,
    model: model,
    messageCount: options.messages.length,
  });

  const startMs = performance.now();
  const inputTokens = estimateTokens(options.messages);

  try {
    const raw = await withRetry(
      () => {
        const timeout = AbortSignal.timeout(60_000);
        return provider.completeChat(options.messages, options.model, timeout);
      },
      { maxRetries: 3, baseDelayMs: 1_000, maxDelayMs: 30_000 },
    );
    const result = rehydrateResponse(raw);
    const durationMs = Math.round(performance.now() - startMs);
    const outputTokens = Math.ceil(result.length / 4);
    recordLlmRequest(options.provider, model, durationMs, inputTokens, outputTokens, true);
    logLlmCall({
      ts: new Date().toISOString(), mode: "complete",
      provider: options.provider, model,
      routeSource: options.routeSource, taskType: options.taskType, agentId: options.agentId,
      durationMs, inputTokens, outputTokens, ok: true,
    });
    return result;
  } catch (err) {
    // On credit/billing errors from cloud providers, try Ollama as a fallback
    if (err instanceof LLMError && err.isCreditsError && options.provider !== "ollama") {
      const ollama = getProvider("ollama");
      const ollamaAvailable = await ollama.isAvailable();
      if (ollamaAvailable) {
        log.warn("Cloud provider credits exhausted, falling back to Ollama", {
          provider: options.provider,
          status: err.statusCode,
        });
        const fallbackStartMs = performance.now();
        const fallbackRaw = await withRetry(
          () => {
            const fallbackTimeout = AbortSignal.timeout(120_000);
            return ollama.completeChat(options.messages, undefined, fallbackTimeout);
          },
          { maxRetries: 3, baseDelayMs: 1_000, maxDelayMs: 30_000 },
        );
        const fallbackResult = rehydrateResponse(fallbackRaw);
        const fallbackDurationMs = Math.round(performance.now() - fallbackStartMs);
        const fallbackOutputTokens = Math.ceil(fallbackResult.length / 4);
        recordLlmRequest("ollama", ollama.defaultUtilityModel, fallbackDurationMs, inputTokens, fallbackOutputTokens, true);
        // Also record the original provider's failure
        const failDurationMs = Math.round(fallbackStartMs - startMs);
        recordLlmRequest(options.provider, model, failDurationMs, inputTokens, 0, false);
        // Log both: the failed cloud call and the successful fallback
        logLlmCall({
          ts: new Date().toISOString(), mode: "complete",
          provider: options.provider, model,
          routeSource: options.routeSource, taskType: options.taskType, agentId: options.agentId,
          durationMs: failDurationMs, inputTokens, ok: false, error: "credits_exhausted",
        });
        logLlmCall({
          ts: new Date().toISOString(), mode: "complete",
          provider: "ollama", model: ollama.defaultUtilityModel,
          routeSource: "fallback", taskType: options.taskType, agentId: options.agentId,
          durationMs: fallbackDurationMs, inputTokens, outputTokens: fallbackOutputTokens, ok: true,
        });
        return fallbackResult;
      }
    }
    const durationMs = Math.round(performance.now() - startMs);
    recordLlmRequest(options.provider, model, durationMs, inputTokens, 0, false);
    logLlmCall({
      ts: new Date().toISOString(), mode: "complete",
      provider: options.provider, model,
      routeSource: options.routeSource, taskType: options.taskType, agentId: options.agentId,
      durationMs, inputTokens, ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
