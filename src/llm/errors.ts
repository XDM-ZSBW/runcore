/**
 * Structured LLM error types for Core.
 * Replaces generic Error objects with errors that carry HTTP status,
 * recoverability, and provider info — enabling smarter retry/fallback decisions.
 */

/** Error thrown by LLM providers when an API call fails. */
export class LLMError extends Error {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly statusCode: number | null,
    public readonly recoverable: boolean,
  ) {
    super(message);
    this.name = "LLMError";
  }

  /** True when the error is due to insufficient credits or billing issues. */
  get isCreditsError(): boolean {
    return this.statusCode === 402 || /credits|afford|payment.required|billing/i.test(this.message);
  }

  /** True when the error is due to rate limiting. */
  get isRateLimited(): boolean {
    return this.statusCode === 429 || /rate.limit/i.test(this.message);
  }

  /** True when the error is an authentication/authorization failure. */
  get isAuthError(): boolean {
    return this.statusCode === 401 || this.statusCode === 403
      || /unauthorized|forbidden|invalid.*key|authentication/i.test(this.message);
  }

  /** True when the error is a timeout. */
  get isTimeout(): boolean {
    return /timeout|timed.out/i.test(this.message) || this.statusCode === 408;
  }

  /** Human-readable error message suitable for displaying to the user. */
  get userMessage(): string {
    if (this.isCreditsError) {
      return `${this.provider} credits are exhausted or billing is inactive. Please top up your account or switch providers.`;
    }
    if (this.isRateLimited) {
      return `${this.provider} is rate-limiting requests. Retrying automatically — this may take a moment.`;
    }
    if (this.isAuthError) {
      return `${this.provider} API key is missing or invalid. Please check your credentials.`;
    }
    if (this.isTimeout) {
      return `${this.provider} took too long to respond. The service may be overloaded — try again shortly.`;
    }
    if (this.statusCode && this.statusCode >= 500) {
      return `${this.provider} is experiencing server issues (${this.statusCode}). This is usually temporary.`;
    }
    return `${this.provider} returned an error. ${this.recoverable ? "Retrying…" : "Please check your configuration."}`;
  }
}

/**
 * Classify an HTTP status code + response body into a structured LLMError.
 * Used by all providers to convert API error responses consistently.
 */
export function classifyApiError(
  provider: string,
  status: number,
  body: string,
  model?: string,
): LLMError {
  const msg = `${provider} ${status}: ${body}`;

  // Non-recoverable: auth, billing, bad request
  if (status === 401 || status === 403) {
    return new LLMError(msg, provider, status, false);
  }
  if (status === 402) {
    return new LLMError(msg, provider, status, false);
  }
  if (status === 400 || status === 404 || status === 422) {
    return new LLMError(msg, provider, status, false);
  }

  // Recoverable: rate limits (retry after backoff)
  if (status === 429) {
    return new LLMError(msg, provider, status, true);
  }

  // Recoverable: server errors (transient)
  if (status >= 500) {
    return new LLMError(msg, provider, status, true);
  }

  // Unknown status — assume non-recoverable
  return new LLMError(msg, provider, status, false);
}
