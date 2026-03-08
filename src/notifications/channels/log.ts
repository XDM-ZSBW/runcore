/**
 * Log channel — writes notifications to the structured logger.
 *
 * Useful as a default/fallback channel, for development, and for
 * maintaining an audit trail of all dispatched notifications.
 */

import { createLogger } from "../../utils/logger.js";
import type { NotificationContext, NotificationPriority, SmartChannel } from "../types.js";

const logger = createLogger("notifications.log-channel");

export class LogChannel implements SmartChannel {
  readonly name = "log";
  enabled = true;
  readonly minPriority: NotificationPriority;

  constructor(minPriority: NotificationPriority = "low") {
    this.minPriority = minPriority;
  }

  async send(ctx: NotificationContext, priority: NotificationPriority): Promise<boolean> {
    logger.info("notification dispatched", {
      priority,
      source: ctx.source,
      eventType: ctx.eventType,
      gear: ctx.gear,
      tags: ctx.tags,
      actor: ctx.actor,
      message: ctx.payload["message"],
    });
    return true;
  }
}
