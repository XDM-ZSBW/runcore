/**
 * Phone (voice call) notification channel.
 *
 * Places a Twilio voice call for critical alerts using the existing
 * makeCall() function. Designed for last-resort escalation only.
 */

import type { Alert, NotificationChannel } from "../health/alert-types.js";
import { getInstanceName } from "../instance.js";
import { makeCall } from "../twilio/call.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("notifications.phone");

export class PhoneChannel implements NotificationChannel {
  readonly name = "phone";
  enabled: boolean;

  constructor(opts?: { enabled?: boolean }) {
    this.enabled = opts?.enabled ?? true;
  }

  async send(alert: Alert): Promise<boolean> {
    const message = formatAlertVoice(alert);

    log.info("placing critical alert voice call", {
      alertId: alert.id,
      severity: alert.severity,
      checkName: alert.checkName,
    });

    const result = await makeCall({ message });

    if (result.ok) {
      log.info("voice call initiated", { alertId: alert.id, sid: result.sid });
    } else {
      log.error("voice call failed", { alertId: alert.id, error: result.message });
    }

    return result.ok;
  }
}

function formatAlertVoice(alert: Alert): string {
  // Parse dollar amounts from the detail string for richer speech
  const remainingMatch = alert.message.match(/\$(\d+\.?\d*)\s+remaining/);
  const remaining = remainingMatch ? remainingMatch[1] : null;

  const parts = [
    `${getInstanceName()} critical alert.`,
    `${alert.checkName.replace(/_/g, " ")} at ${alert.value} percent used.`,
  ];

  if (remaining) {
    parts.push(`Only $${remaining} remaining.`);
  }

  parts.push(`Please take action immediately.`);

  return parts.join(" ");
}
