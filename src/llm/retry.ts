/**
 * Retry with exponential backoff for LLM provider calls.
 * Retries only on recoverable (transient) errors: rate limits (429), server errors (5xx), timeouts.
 * Non-recoverable errors (auth, billing, bad request) are thrown immediately.
 */

import { LLMError } from "./errors.js";
import type { StreamOptions } from "./providers/types.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("llm.retry");

export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3). */
  maxRetries?: number;
  /** Initial delay in ms before first retry (default: 1000). */
  baseDelayMs?: number;
  /** Maximum delay cap in ms (default: 30000). */
  maxDelayMs?: number;
}

const DEFAULTS: Required<RetryOptions> = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
};

/** Returns true if the error is worth retrying. */
export function isRetryable(err: unknown): boolean {
  // LLMError with recoverable flag (429, 5xx)
  if (err instanceof LLMError) return err.recoverable;

  // Network errors / timeouts from fetch
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return (
      msg.includes("timeout") ||
      msg.includes("econnreset") ||
      msg.includes("econnrefused") ||
      msg.includes("fetch failed") ||
      msg.includes("network") ||
      msg.includes("socket hang up") ||
      err.name === "TimeoutError" ||
      err.name === "AbortError"
    );
  }

  return false;
}

/** Delay with jitter: base * 2^attempt + random jitter. */
function backoffDelay(attempt: number, baseMs: number, maxMs: number): number {
  const exponential = baseMs * Math.pow(2, attempt);
  const jitter = Math.random() * baseMs;
  return Math.min(exponential + jitter, maxMs);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute an async function with retry on transient failures.
 * Non-recoverable errors are thrown immediately without retry.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: RetryOptions,
): Promise<T> {
  const { maxRetries, baseDelayMs, maxDelayMs } = { ...DEFAULTS, ...opts };

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      // Don't retry non-recoverable errors
      if (!isRetryable(err)) throw err;

      // Don't retry if we've exhausted attempts
      if (attempt >= maxRetries) {
        log.warn("All retry attempts exhausted", {
          attempts: attempt + 1,
          error: err instanceof Error ? err.message : String(err),
        });
        break;
      }

      const delayMs = backoffDelay(attempt, baseDelayMs, maxDelayMs);
      log.info("Retrying after transient failure", {
        attempt: attempt + 1,
        maxRetries,
        delayMs: Math.round(delayMs),
        error: err instanceof Error ? err.message : String(err),
        statusCode: err instanceof LLMError ? err.statusCode : undefined,
      });

      await sleep(delayMs);
    }
  }

  throw lastError;
}

/**
 * Retry wrapper for streaming LLM calls.
 * Only retries when a retryable error occurs before any tokens have been emitted.
 * Once tokens start flowing, errors propagate to the original onError callback
 * to avoid sending duplicate tokens.
 */
export function withStreamRetry(
  streamFn: (options: StreamOptions) => Promise<void>,
  opts?: RetryOptions,
): (options: StreamOptions) => Promise<void> {
  const { maxRetries, baseDelayMs, maxDelayMs } = { ...DEFAULTS, ...opts };

  return (options: StreamOptions) => {
    let attempt = 0;

    function tryStream(): Promise<void> {
      let tokensSent = false;

      return new Promise<void>((resolve) => {
        const wrappedOptions: StreamOptions = {
          ...options,
          onToken: (token: string) => {
            tokensSent = true;
            options.onToken(token);
          },
          onToolCalls: options.onToolCalls
            ? (calls) => {
                options.onToolCalls!(calls);
                resolve();
              }
            : undefined,
          onDone: () => {
            options.onDone();
            resolve();
          },
          onError: async (err: Error) => {
            // Only retry if no tokens sent yet and error is retryable
            if (!tokensSent && attempt < maxRetries && isRetryable(err)) {
              attempt++;
              const delayMs = backoffDelay(attempt - 1, baseDelayMs, maxDelayMs);
              log.info("Retrying stream after transient failure", {
                attempt,
                maxRetries,
                delayMs: Math.round(delayMs),
                error: err.message,
                statusCode: err instanceof LLMError ? err.statusCode : undefined,
              });
              await sleep(delayMs);
              tryStream().then(resolve);
            } else {
              if (!tokensSent && attempt >= maxRetries) {
                log.warn("All stream retry attempts exhausted", {
                  attempts: attempt + 1,
                  error: err.message,
                });
              }
              options.onError(err);
              resolve();
            }
          },
        };

        streamFn(wrappedOptions).catch((err) => {
          // Handle rejected promise from streamFn (shouldn't normally happen
          // since providers catch internally, but be safe)
          wrappedOptions.onError(err instanceof Error ? err : new Error(String(err)));
        });
      });
    }

    return tryStream();
  };
}
