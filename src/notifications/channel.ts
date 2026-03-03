/**
 * Base notification channel types and utilities.
 *
 * Re-exports the NotificationChannel interface and provides
 * a channel registry for managing multiple delivery channels.
 */

import type { Alert, NotificationChannel } from "../health/alert-types.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("notifications");

export type { NotificationChannel } from "../health/alert-types.js";

/** Registry that dispatches alerts to multiple channels. */
export class NotificationDispatcher {
  private channels = new Map<string, NotificationChannel>();

  /** Register a notification channel. */
  add(channel: NotificationChannel): void {
    this.channels.set(channel.name, channel);
  }

  /** Remove a channel by name. */
  remove(name: string): void {
    this.channels.delete(name);
  }

  /** Get a channel by name. */
  get(name: string): NotificationChannel | undefined {
    return this.channels.get(name);
  }

  /** List all registered channel names. */
  list(): string[] {
    return [...this.channels.keys()];
  }

  /** Send an alert to a specific channel. */
  async sendTo(channelName: string, alert: Alert): Promise<boolean> {
    const channel = this.channels.get(channelName);
    if (!channel || !channel.enabled) {
      log.warn("channel send skipped — channel not found or disabled", { channelName, alertId: alert.id });
      return false;
    }
    try {
      const result = await channel.send(alert);
      if (result) {
        log.info("channel send succeeded", { channelName, alertId: alert.id, severity: alert.severity });
      } else {
        log.warn("channel send returned false", { channelName, alertId: alert.id });
      }
      return result;
    } catch (err) {
      log.error("channel send threw an error", { channelName, alertId: alert.id, error: String(err) });
      return false;
    }
  }

  /** Send an alert to all enabled channels. Returns map of channel → success. */
  async broadcast(alert: Alert): Promise<Record<string, boolean>> {
    const results: Record<string, boolean> = {};
    const entries = [...this.channels.entries()];
    log.info("broadcast dispatching alert to channels", {
      alertId: alert.id,
      severity: alert.severity,
      channelCount: entries.length,
    });
    const promises = entries.map(async ([name, channel]) => {
      if (!channel.enabled) {
        log.debug("broadcast skipping disabled channel", { channel: name, alertId: alert.id });
        results[name] = false;
        return;
      }
      try {
        results[name] = await channel.send(alert);
        if (results[name]) {
          log.info("broadcast channel send succeeded", { channel: name, alertId: alert.id });
        } else {
          log.warn("broadcast channel send returned false", { channel: name, alertId: alert.id });
        }
      } catch (err) {
        log.error("broadcast channel send threw an error", { channel: name, alertId: alert.id, error: String(err) });
        results[name] = false;
      }
    });
    await Promise.allSettled(promises);
    return results;
  }
}
