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

const log = createLogger("llm");

export interface CompleteChatOptions {
  messages: ContextMessage[];
  model?: string;
  provider: ProviderName;
  /** Skip cache for this request. */
  noCache?: boolean;
  /** Override default TTL for this request (ms). */
  cacheTTLMs?: number;
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

/** Direct LLM call without caching — routes to the configured provider. */
async function completeChatUncached(options: CompleteChatOptions): Promise<string> {
  const provider = getProvider(options.provider);

  log.debug("Completion request", {
    provider: options.provider,
    model: options.model ?? "default",
    messageCount: options.messages.length,
  });

  try {
    const raw = await withRetry(
      () => {
        const timeout = AbortSignal.timeout(60_000);
        return provider.completeChat(options.messages, options.model, timeout);
      },
      { maxRetries: 3, baseDelayMs: 1_000, maxDelayMs: 30_000 },
    );
    return rehydrateResponse(raw);
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
        const fallbackRaw = await withRetry(
          () => {
            const fallbackTimeout = AbortSignal.timeout(120_000);
            return ollama.completeChat(options.messages, undefined, fallbackTimeout);
          },
          { maxRetries: 3, baseDelayMs: 1_000, maxDelayMs: 30_000 },
        );
        return rehydrateResponse(fallbackRaw);
      }
    }
    throw err;
  }
}
