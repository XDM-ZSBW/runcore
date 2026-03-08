/**
 * Adapter that wraps legacy NotificationChannel (alert-based)
 * into the SmartChannel interface (context-based).
 *
 * This allows existing email, SMS, and webhook channels to work
 * with the smart notification engine without rewriting them.
 */

import type { Alert, NotificationChannel } from "../../health/alert-types.js";
import type { NotificationContext, NotificationPriority, SmartChannel } from "../types.js";

/** Map smart priority to alert severity for the legacy interface. */
function priorityToSeverity(priority: NotificationPriority): "warning" | "critical" {
  return priority === "critical" || priority === "high" ? "critical" : "warning";
}

/** Build a minimal Alert from a NotificationContext for legacy channels. */
function contextToAlert(ctx: NotificationContext, priority: NotificationPriority): Alert {
  const severity = priorityToSeverity(priority);
  return {
    id: `smart-${ctx.source}-${Date.now()}`,
    thresholdId: ctx.eventType,
    checkName: ctx.source,
    metric: ctx.eventType,
    severity,
    state: "firing",
    value: 0,
    threshold: 0,
    message: (ctx.payload["message"] as string) ?? `[${ctx.source}] ${ctx.eventType}`,
    firedAt: ctx.timestamp,
  };
}

/**
 * Wraps a legacy NotificationChannel as a SmartChannel.
 *
 * Usage:
 * ```ts
 * const legacyEmail = new EmailChannel(config);
 * const smartEmail = new LegacyChannelAdapter(legacyEmail, "normal");
 * engine.registerChannel(smartEmail);
 * ```
 */
export class LegacyChannelAdapter implements SmartChannel {
  readonly name: string;
  get enabled(): boolean {
    return this.inner.enabled;
  }
  readonly minPriority: NotificationPriority;

  constructor(
    private inner: NotificationChannel,
    minPriority: NotificationPriority = "normal",
  ) {
    this.name = inner.name;
    this.minPriority = minPriority;
  }

  async send(ctx: NotificationContext, priority: NotificationPriority): Promise<boolean> {
    const alert = contextToAlert(ctx, priority);
    return this.inner.send(alert);
  }
}
