/**
 * Retry utilities for GitHub API calls.
 * Exponential backoff with jitter, error classification, and structured errors.
 * Mirrors the Linear retry pattern with GitHub-specific error handling.
 */

import { traceApiCall } from "../tracing/instrument.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("github");

/** Classifies errors as transient (retry) or permanent (don't retry). */
export type ErrorKind = "transient" | "permanent" | "auth";

export class GitHubApiError extends Error {
  constructor(
    message: string,
    public readonly kind: ErrorKind,
    public readonly statusCode?: number,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

/**
 * Classify an error from the GitHub API.
 * - 401/403 → auth (don't retry, token is bad or insufficient scope)
 * - 429, 500, 502, 503, 504 → transient (retry)
 * - Network errors → transient
 * - Everything else → permanent
 */
export function classifyError(err: unknown): ErrorKind {
  if (err instanceof GitHubApiError) return err.kind;

  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();

  // Auth failures
  if (lower.includes("401") || lower.includes("403") || lower.includes("unauthorized") || lower.includes("forbidden") || lower.includes("bad credentials")) {
    return "auth";
  }

  // Rate-limited or server errors
  if (lower.includes("429") || lower.includes("rate limit") || lower.includes("secondary rate limit") || lower.includes("abuse detection")) {
    return "transient";
  }
  if (/\b50[0-4]\b/.test(msg)) return "transient";

  // Network errors
  if (
    lower.includes("econnreset") ||
    lower.includes("etimedout") ||
    lower.includes("econnrefused") ||
    lower.includes("enotfound") ||
    lower.includes("fetch failed") ||
    lower.includes("network") ||
    lower.includes("socket hang up") ||
    lower.includes("aborted")
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
  /** Per-attempt timeout in ms. Default: 15000. */
  timeoutMs?: number;
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
  const label = opts?.label ?? "GitHubAPI";
  const timeoutMs = opts?.timeoutMs ?? 15_000;

  return traceApiCall("github", label, async (span) => {
    span.setAttribute("retry.max_attempts", maxAttempts);
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await withTimeout(fn(), timeoutMs, label);
        span.setAttribute("retry.attempts", attempt);
        return result;
      } catch (err) {
        lastError = err;
        const kind = classifyError(err);
        span.addEvent("retry.attempt_failed", {
          attempt,
          "error.kind": kind,
          "error.message": err instanceof Error ? err.message : String(err),
        });

        if (kind === "auth") {
          throw new GitHubApiError(
            `${label}: authentication failed — check GITHUB_TOKEN`,
            "auth",
            undefined,
            err,
          );
        }

        if (kind === "permanent") {
          throw new GitHubApiError(
            `${label}: ${err instanceof Error ? err.message : String(err)}`,
            "permanent",
            undefined,
            err,
          );
        }

        if (attempt < maxAttempts) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const isRateLimited = errMsg.includes("429") || errMsg.toLowerCase().includes("rate limit");
          const effectiveBase = isRateLimited ? Math.max(baseDelay, 5_000) : baseDelay;
          const delay = Math.min(effectiveBase * 2 ** (attempt - 1), maxDelay);
          const jitter = delay * (0.5 + Math.random() * 0.5);
          log.warn(`${label}: attempt ${attempt}/${maxAttempts} failed${isRateLimited ? " (rate limited)" : ""}, retrying in ${Math.round(jitter)}ms`);
          await sleep(jitter);
        }
      }
    }

    span.setAttribute("retry.attempts", maxAttempts);
    throw new GitHubApiError(
      `${label}: failed after ${maxAttempts} attempts`,
      "transient",
      undefined,
      lastError,
    );
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  if (ms <= 0 || !Number.isFinite(ms)) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new GitHubApiError(
        `${label}: timed out after ${ms}ms`,
        "transient",
      ));
    }, ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
