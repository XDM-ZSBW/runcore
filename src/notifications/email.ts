/**
 * Email notification channel.
 *
 * Sends alert notifications via HTTP POST to an email service endpoint.
 * Designed to work with Resend, SendGrid, or any REST-based email API.
 */

import type { Alert, NotificationChannel } from "../health/alert-types.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("notifications.email");

export interface EmailChannelConfig {
  /** Email service API endpoint URL. */
  endpoint: string;
  /** API key or bearer token for the email service. */
  apiKey: string;
  /** Sender address. */
  from: string;
  /** Recipient addresses. */
  to: string[];
  /** Whether this channel is enabled. Default: true. */
  enabled?: boolean;
}

export class EmailChannel implements NotificationChannel {
  readonly name = "email";
  enabled: boolean;
  private config: EmailChannelConfig;

  constructor(config: EmailChannelConfig) {
    this.config = config;
    this.enabled = config.enabled ?? true;
  }

  async send(alert: Alert): Promise<boolean> {
    const subject = `[${alert.severity.toUpperCase()}] ${alert.message}`;
    const body = formatAlertEmail(alert);

    log.info("sending email notification", {
      alertId: alert.id,
      severity: alert.severity,
      recipients: this.config.to.length,
      subject,
    });

    try {
      const res = await fetch(this.config.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          from: this.config.from,
          to: this.config.to,
          subject,
          html: body,
        }),
      });
      if (res.ok) {
        log.info("email sent successfully", { alertId: alert.id, status: res.status });
      } else {
        log.error("email API returned error", { alertId: alert.id, status: res.status, statusText: res.statusText });
      }
      return res.ok;
    } catch (err) {
      log.error("email send failed with exception", { alertId: alert.id, error: String(err) });
      return false;
    }
  }
}

function formatAlertEmail(alert: Alert): string {
  const stateColor =
    alert.severity === "critical" ? "#dc2626" : "#f59e0b";
  return `
<div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
  <div style="background: ${stateColor}; color: white; padding: 16px; border-radius: 8px 8px 0 0;">
    <h2 style="margin: 0;">${alert.severity.toUpperCase()} Alert</h2>
  </div>
  <div style="border: 1px solid #e5e7eb; border-top: none; padding: 16px; border-radius: 0 0 8px 8px;">
    <p><strong>Check:</strong> ${alert.checkName}</p>
    <p><strong>Metric:</strong> ${alert.metric}</p>
    <p><strong>Value:</strong> ${alert.value} (threshold: ${alert.threshold})</p>
    <p><strong>Message:</strong> ${alert.message}</p>
    <p><strong>State:</strong> ${alert.state}</p>
    <p><strong>Fired at:</strong> ${alert.firedAt}</p>
    <p style="color: #6b7280; font-size: 12px;">Alert ID: ${alert.id}</p>
  </div>
</div>`.trim();
}
