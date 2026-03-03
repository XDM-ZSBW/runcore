/**
 * Shared types for the webhook system.
 *
 * All interfaces used across registry, verification, routing, retry,
 * and configuration live here to avoid circular dependencies.
 */

// ── Core Result ──────────────────────────────────────────────────────────────

/** Standard result returned by all webhook handlers. */
export interface WebhookResult {
  handled: boolean;
  message: string;
  /** Optional extra data (e.g., Slack challenge response). */
  data?: Record<string, unknown>;
}

// ── Signature Verification ───────────────────────────────────────────────────

/** Signature verification context passed to providers. */
export interface VerifyContext {
  /** Raw request body (string). */
  rawBody: string;
  /** Signature header value. */
  signature: string;
  /** Secret/token used for verification. */
  secret: string;
  /** Additional headers that some providers need (e.g., Slack timestamp). */
  headers?: Record<string, string>;
  /** Full webhook URL (needed by Twilio). */
  url?: string;
  /** Parsed form params (needed by Twilio). */
  params?: Record<string, string>;
}

// ── Provider ─────────────────────────────────────────────────────────────────

/** A registered webhook provider. */
export interface WebhookProvider {
  /** Unique provider name (e.g., "slack", "linear", "twilio"). */
  name: string;
  /** Verify a webhook signature. Return true if valid. */
  verify(ctx: VerifyContext): boolean;
  /** Process a webhook payload. Called after verification. */
  process(
    payload: unknown,
    ctx?: Record<string, unknown>,
  ): Promise<WebhookResult>;
}

// ── Event Envelope ───────────────────────────────────────────────────────────

/** Generic typed envelope that normalizes events across providers. */
export interface WebhookEvent<T = unknown> {
  /** Provider name (e.g., "slack", "linear", "twilio"). */
  source: string;
  /** ISO 8601 timestamp when the event was received. */
  receivedAt: string;
  /** The raw payload from the provider. */
  payload: T;
  /** Event type string extracted from the payload. */
  eventType?: string;
  /** Delivery/request ID for deduplication. */
  deliveryId?: string;
}

// ── Retry ────────────────────────────────────────────────────────────────────

/** Retry options for webhook handler execution. */
export interface WebhookRetryOpts {
  /** Maximum number of attempts (including first). Default: 3. */
  maxAttempts?: number;
  /** Base delay in ms before first retry. Default: 500. */
  baseDelayMs?: number;
  /** Maximum delay in ms. Default: 10000. */
  maxDelayMs?: number;
  /** Called when all retry attempts are exhausted. Receives the final error. */
  onExhausted?: (error: unknown, attempts: number) => void;
}

// ── Middleware & Request Context ──────────────────────────────────────────────

/** Represents an incoming HTTP-like webhook request. */
export interface WebhookRequestContext {
  /** HTTP method (POST, GET, etc.). */
  method: string;
  /** Full request URL. */
  url: string;
  /** Request headers (lowercase keys). */
  headers: Record<string, string>;
  /** Raw request body as string. */
  body: string;
  /** Parsed body (JSON or form data). */
  parsed?: unknown;
  /** Provider name to route to. */
  provider: string;
}

/** Middleware function that can inspect/modify context before processing. */
export type WebhookMiddleware = (
  ctx: WebhookRequestContext,
  next: () => Promise<WebhookResult>,
) => Promise<WebhookResult>;

// ── Provider Stats & Health ──────────────────────────────────────────────────

/** Runtime stats for a webhook provider. */
export interface ProviderStats {
  name: string;
  invocations: number;
  successes: number;
  failures: number;
  lastInvokedAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
}

/** Health classification for a provider. */
export type ProviderHealth = "healthy" | "degraded" | "unknown";

/** Aggregate health summary for a webhook provider. */
export interface ProviderHealthSummary {
  name: string;
  health: ProviderHealth;
  failureRate: number;
  stats: ProviderStats;
}

// ── Deduplication ────────────────────────────────────────────────────────────

/** Options for the deduplication middleware. */
export interface DeduplicationOpts {
  /** Maximum number of delivery IDs to track. Default: 1000. */
  maxSize?: number;
  /** Time-to-live in ms for tracked IDs. Default: 300_000 (5 minutes). */
  ttlMs?: number;
}

// ── Handler Types ────────────────────────────────────────────────────────────

/** Handler function for a specific event type. */
export type EventHandler<T = unknown> = (
  data: T,
  ctx?: Record<string, unknown>,
) => Promise<WebhookResult>;

// ── Configuration ────────────────────────────────────────────────────────────

/** Signature verification algorithm. */
export type SignatureAlgorithm =
  | "hmac-sha256-hex"
  | "hmac-sha256-base64"
  | "hmac-sha1-base64"
  | "slack-v0"
  | "twilio"
  | "custom";

/** Configuration for a webhook provider. */
export interface WebhookProviderConfig {
  /** Provider name (must match the registered provider name). */
  name: string;
  /** Whether this provider is enabled. Default: true. */
  enabled?: boolean;
  /** Environment variable name or literal secret for signature verification. */
  secret?: string;
  /** Header name containing the signature (lowercase). */
  signatureHeader?: string;
  /** Signature algorithm used by this provider. */
  algorithm?: SignatureAlgorithm;
  /** URL path where this provider's webhooks are received. */
  path?: string;
  /** Maximum timestamp age in seconds for replay protection. */
  maxTimestampAge?: number;
  /** Retry options for this provider's handlers. */
  retry?: WebhookRetryOpts;
  /** Provider-specific extra configuration. */
  metadata?: Record<string, unknown>;
}

/** Top-level webhook system configuration. */
export interface WebhookSystemConfig {
  /** Global defaults applied to all providers unless overridden. */
  defaults?: {
    /** Default retry options. */
    retry?: WebhookRetryOpts;
    /** Default max timestamp age in seconds. */
    maxTimestampAge?: number;
  };
  /** Per-provider configurations. */
  providers: Record<string, WebhookProviderConfig>;
}
