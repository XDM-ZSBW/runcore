/**
 * SMS notification channel.
 *
 * Sends alert notifications via Twilio SMS API.
 */

import type { Alert, NotificationChannel } from "../health/alert-types.js";
import { getInstanceName } from "../instance.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("notifications.sms");

export interface SmsChannelConfig {
  /** Twilio Account SID. */
  accountSid: string;
  /** Twilio Auth Token. */
  authToken: string;
  /** Twilio phone number (sender). */
  from: string;
  /** Recipient phone numbers. */
  to: string[];
  /** Whether this channel is enabled. Default: true. */
  enabled?: boolean;
}

export class SmsChannel implements NotificationChannel {
  readonly name = "sms";
  enabled: boolean;
  private config: SmsChannelConfig;

  constructor(config: SmsChannelConfig) {
    this.config = config;
    this.enabled = config.enabled ?? true;
  }

  async send(alert: Alert): Promise<boolean> {
    const message = formatAlertSms(alert);
    const url = `https://api.twilio.com/2010-04-01/Accounts/${this.config.accountSid}/Messages.json`;
    const auth = Buffer.from(
      `${this.config.accountSid}:${this.config.authToken}`,
    ).toString("base64");

    log.info("sending SMS notification", {
      alertId: alert.id,
      severity: alert.severity,
      recipientCount: this.config.to.length,
    });

    const results = await Promise.allSettled(
      this.config.to.map(async (to) => {
        log.debug("sending SMS to recipient", { alertId: alert.id, to });
        const body = new URLSearchParams({
          From: this.config.from,
          To: to,
          Body: message,
        });
        const res = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Basic ${auth}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: body.toString(),
        });
        if (res.ok) {
          log.info("SMS sent successfully", { alertId: alert.id, to });
        } else {
          log.error("Twilio SMS API error", { alertId: alert.id, to, status: res.status });
        }
        return res.ok;
      }),
    );

    const anySuccess = results.some(
      (r) => r.status === "fulfilled" && r.value === true,
    );
    if (!anySuccess) {
      log.warn("all SMS sends failed", { alertId: alert.id, recipientCount: this.config.to.length });
    }
    return anySuccess;
  }
}

function formatAlertSms(alert: Alert): string {
  const icon = alert.severity === "critical" ? "🚨" : "⚠️";
  return [
    `${icon} ${getInstanceName()} ${alert.severity.toUpperCase()}`,
    `${alert.checkName}: ${alert.message}`,
    `Value: ${alert.value} (limit: ${alert.threshold})`,
    `At: ${alert.firedAt}`,
  ].join("\n");
}
