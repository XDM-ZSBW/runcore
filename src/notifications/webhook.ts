/**
 * Webhook notification channel.
 *
 * Sends alert notifications as JSON payloads to configurable HTTP endpoints.
 * Compatible with Slack incoming webhooks, Discord webhooks, or custom endpoints.
 */

import type { Alert, NotificationChannel } from "../health/alert-types.js";

export interface WebhookChannelConfig {
  /** Webhook endpoint URL. */
  url: string;
  /** Optional secret for HMAC signing of payloads. */
  secret?: string;
  /** Optional custom headers to include. */
  headers?: Record<string, string>;
  /** Request timeout in ms. Default: 10_000. */
  timeoutMs?: number;
  /** Whether this channel is enabled. Default: true. */
  enabled?: boolean;
}

export class WebhookChannel implements NotificationChannel {
  readonly name = "webhook";
  enabled: boolean;
  private config: WebhookChannelConfig;

  constructor(config: WebhookChannelConfig) {
    this.config = config;
    this.enabled = config.enabled ?? true;
  }

  async send(alert: Alert): Promise<boolean> {
    const payload = {
      event: "alert",
      timestamp: new Date().toISOString(),
      alert: {
        id: alert.id,
        checkName: alert.checkName,
        metric: alert.metric,
        severity: alert.severity,
        state: alert.state,
        value: alert.value,
        threshold: alert.threshold,
        message: alert.message,
        firedAt: alert.firedAt,
        acknowledgedAt: alert.acknowledgedAt,
        resolvedAt: alert.resolvedAt,
      },
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.config.headers,
    };

    if (this.config.secret) {
      const signature = await this.sign(JSON.stringify(payload));
      headers["X-Signature-256"] = signature;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        this.config.timeoutMs ?? 10_000,
      );

      const res = await fetch(this.config.url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeout);
      return res.ok;
    } catch {
      return false;
    }
  }

  private async sign(payload: string): Promise<string> {
    const { createHmac } = await import("node:crypto");
    return (
      "sha256=" +
      createHmac("sha256", this.config.secret!)
        .update(payload)
        .digest("hex")
    );
  }
}
