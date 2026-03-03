/**
 * Retry utilities for Slack API calls.
 * Exponential backoff with jitter, error classification, and structured errors.
 * Mirrors src/linear/retry.ts pattern.
 */

import { createLogger } from "../utils/logger.js";

const log = createLogger("slack");

/** Classifies errors as transient (retry) or permanent (don't retry). */
export type ErrorKind = "transient" | "permanent" | "auth" | "rate_limit";

export class SlackApiError extends Error {
  constructor(
    message: string,
    public readonly kind: ErrorKind,
    public readonly statusCode?: number,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SlackApiError";
  }
}

/**
 * Classify a Slack API error.
 * - Auth tokens: invalid_auth, not_authed, token_revoked, account_inactive → auth (don't retry)
 * - Rate limits (429), server errors (5xx), network errors → transient (retry)
 * - Everything else → permanent (don't retry)
 */
export function classifyError(err: unknown): ErrorKind {
  if (err instanceof SlackApiError) return err.kind;

  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();

  // Auth failures — never retry
  if (
    lower.includes("invalid_auth") ||
    lower.includes("not_authed") ||
    lower.includes("token_revoked") ||
    lower.includes("token_expired") ||
    lower.includes("account_inactive") ||
    lower.includes("missing_scope") ||
    lower.includes("401") ||
    lower.includes("403")
  ) {
    return "auth";
  }

  // Rate-limited — retryable, but classified separately for logging
  if (lower.includes("429") || lower.includes("rate_limit") || lower.includes("ratelimited")) {
    return "rate_limit";
  }
  if (/\b50[0-4]\b/.test(msg)) return "transient";

  // Network errors — retry
  if (
    lower.includes("econnreset") ||
    lower.includes("etimedout") ||
    lower.includes("econnrefused") ||
    lower.includes("enotfound") ||
    lower.includes("fetch failed") ||
    lower.includes("network") ||
    lower.includes("socket hang up") ||
    lower.includes("aborted") ||
    lower.includes("request_timeout") ||
    lower.includes("service_unavailable")
  ) {
    return "transient";
  }

  return "permanent";
}

export interface RetryOpts {
  /** Maximum number of attempts (including the first). Default: 3. */
  maxAttempts?: number;
  /** Base delay in ms before first retry. Default: 1000. */
  baseDelayMs?: number;
  /** Maximum delay in ms. Default: 30000. */
  maxDelayMs?: number;
  /** Label for logging. */
  label?: string;
}

/**
 * Execute `fn` with exponential backoff + jitter.
 * Only retries transient errors. Auth and permanent errors fail immediately.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: RetryOpts,
): Promise<T> {
  const maxAttempts = opts?.maxAttempts ?? 3;
  const baseDelay = opts?.baseDelayMs ?? 1000;
  const maxDelay = opts?.maxDelayMs ?? 30_000;
  const label = opts?.label ?? "SlackAPI";

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const kind = classifyError(err);

      if (kind === "auth") {
        throw new SlackApiError(
          `${label}: authentication failed — check SLACK_BOT_TOKEN`,
          "auth",
          undefined,
          err,
        );
      }

      if (kind === "permanent") {
        throw new SlackApiError(
          `${label}: ${err instanceof Error ? err.message : String(err)}`,
          "permanent",
          undefined,
          err,
        );
      }

      // Transient or rate_limit — retry if we have attempts left
      if (attempt < maxAttempts) {
        const delay = Math.min(baseDelay * 2 ** (attempt - 1), maxDelay);
        const jitter = delay * (0.5 + Math.random() * 0.5);
        log.warn(`${label}: attempt ${attempt}/${maxAttempts} failed, retrying in ${Math.round(jitter)}ms`);
        await sleep(jitter);
      }
    }
  }

  throw new SlackApiError(
    `${label}: failed after ${maxAttempts} attempts`,
    "transient",
    undefined,
    lastError,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
