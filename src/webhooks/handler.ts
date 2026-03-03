/**
 * Abstract WebhookHandler base class.
 *
 * Provides a class-based API on top of the existing interface-based webhook system.
 * Subclasses implement `verify()` and `handle()`, getting automatic registration,
 * retry logic, safe error handling, and activity logging for free.
 *
 * Usage:
 *   class MyHandler extends WebhookHandler {
 *     constructor() {
 *       super({
 *         name: "my-service",
 *         signatureHeader: "x-my-signature",
 *         secretEnvVar: "MY_WEBHOOK_SECRET",
 *       });
 *     }
 *     verify(ctx) { ... }
 *     protected handle(payload, ctx) { ... }
 *   }
 */

import { logActivity } from "../activity/log.js";
import { registerProvider } from "./registry.js";
import { withWebhookRetry } from "./retry.js";
import type {
  WebhookProvider,
  VerifyContext,
  WebhookResult,
  WebhookRetryOpts,
  SignatureAlgorithm,
} from "./types.js";

// ── Configuration ────────────────────────────────────────────────────────────

/** Options for constructing a WebhookHandler. */
export interface WebhookHandlerConfig {
  /** Unique provider name (e.g., "github", "stripe"). */
  name: string;
  /** Route path where this webhook receives events. Default: `/api/webhooks/{name}`. */
  path?: string;
  /** Header name containing the signature (lowercase). Default: "x-signature". */
  signatureHeader?: string;
  /** Header name containing the timestamp (lowercase). Optional. */
  timestampHeader?: string;
  /** Environment variable name for the webhook secret. */
  secretEnvVar?: string;
  /** Signature algorithm hint. Default: "custom". */
  algorithm?: SignatureAlgorithm;
  /** Retry options for transient failures. */
  retry?: WebhookRetryOpts;
  /** Whether to auto-register on construction. Default: true. */
  autoRegister?: boolean;
}

// ── Base class ───────────────────────────────────────────────────────────────

/**
 * Abstract base class for webhook handlers.
 * Implements WebhookProvider and auto-registers with the webhook registry.
 *
 * Subclasses must implement:
 * - `verify(ctx)` — Validate the webhook signature
 * - `handle(payload, ctx)` — Process the webhook payload
 *
 * The base class provides:
 * - Auto-registration with the webhook registry
 * - Safe error wrapping (process() never throws)
 * - Optional retry logic with exponential backoff
 * - Secret resolution from environment variables
 * - Activity logging
 */
export abstract class WebhookHandler implements WebhookProvider {
  readonly name: string;
  readonly path: string;
  readonly signatureHeader: string;
  readonly timestampHeader?: string;
  readonly secretEnvVar?: string;
  readonly algorithm: SignatureAlgorithm;
  readonly retryOpts: WebhookRetryOpts;

  constructor(config: WebhookHandlerConfig) {
    this.name = config.name;
    this.path = config.path ?? `/api/webhooks/${config.name}`;
    this.signatureHeader = config.signatureHeader ?? "x-signature";
    this.timestampHeader = config.timestampHeader;
    this.secretEnvVar = config.secretEnvVar;
    this.algorithm = config.algorithm ?? "custom";
    this.retryOpts = config.retry ?? {};

    if (config.autoRegister !== false) {
      registerProvider(this);
    }
  }

  /**
   * Verify the webhook signature. Must be implemented by subclasses.
   * Return true if the signature is valid.
   */
  abstract verify(ctx: VerifyContext): boolean;

  /**
   * Process the webhook payload. Must be implemented by subclasses.
   * May throw — the base class wraps this in safe error handling.
   */
  protected abstract handle(
    payload: unknown,
    ctx?: Record<string, unknown>,
  ): Promise<WebhookResult>;

  /**
   * Process a webhook payload with error handling and optional retry.
   * This is the WebhookProvider.process() implementation — callers use this.
   * Never throws.
   */
  async process(
    payload: unknown,
    ctx?: Record<string, unknown>,
  ): Promise<WebhookResult> {
    try {
      const maxAttempts = this.retryOpts.maxAttempts ?? 1;

      if (maxAttempts > 1) {
        return await withWebhookRetry(() => this.handle(payload, ctx), {
          label: this.name,
          ...this.retryOpts,
        });
      }

      return await this.handle(payload, ctx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logActivity({
        source: "system",
        summary: `Webhook handler error (${this.name}): ${msg}`,
      });
      return { handled: false, message: `Handler error: ${msg}` };
    }
  }

  /**
   * Resolve the webhook secret from the configured environment variable.
   * Returns undefined if no env var is configured or the var is not set.
   */
  getSecret(): string | undefined {
    if (this.secretEnvVar) {
      return process.env[this.secretEnvVar];
    }
    return undefined;
  }

  /**
   * Register this handler with the webhook registry.
   * Called automatically on construction unless autoRegister is false.
   */
  register(): void {
    registerProvider(this);
  }
}
