/**
 * Smart notification engine.
 *
 * Evaluates notification rules against event context,
 * resolves priority and channels, and dispatches through
 * registered smart channels with cooldown tracking.
 */

import { createLogger } from "../utils/logger.js";
import type {
  EvaluationResult,
  NotificationContext,
  NotificationPriority,
  NotificationRule,
  RuleCondition,
  SmartChannel,
} from "./types.js";
import { PRIORITY_ORDER } from "./types.js";

const log = createLogger("notifications.engine");

// ─── Condition evaluation ───────────────────────────────────────────────────

/** Resolve a dot-separated field path from a NotificationContext. */
function resolveField(ctx: NotificationContext, field: string): unknown {
  const parts = field.split(".");
  let current: unknown = ctx;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Evaluate a single condition against a context. */
export function evaluateCondition(
  ctx: NotificationContext,
  condition: RuleCondition,
): boolean {
  const actual = resolveField(ctx, condition.field);

  switch (condition.operator) {
    case "eq":
      return actual === condition.value;
    case "neq":
      return actual !== condition.value;
    case "in":
      return Array.isArray(condition.value) && condition.value.includes(actual);
    case "not_in":
      return Array.isArray(condition.value) && !condition.value.includes(actual);
    case "contains":
      return Array.isArray(actual) && actual.includes(condition.value);
    case "gt":
      return typeof actual === "number" && typeof condition.value === "number" && actual > condition.value;
    case "lt":
      return typeof actual === "number" && typeof condition.value === "number" && actual < condition.value;
    case "exists":
      return condition.value ? actual !== undefined : actual === undefined;
    default:
      return false;
  }
}

/** Check if all conditions of a rule match the context. */
export function matchRule(
  ctx: NotificationContext,
  rule: NotificationRule,
): boolean {
  if (!rule.enabled) return false;
  return rule.conditions.every((c) => evaluateCondition(ctx, c));
}

// ─── Priority derivation ────────────────────────────────────────────────────

/** Derive a default priority from context when no rule overrides it. */
export function derivePriority(ctx: NotificationContext): NotificationPriority {
  if (ctx.gear === "crisis") return "critical";
  if (ctx.tags.includes("critical")) return "critical";
  if (ctx.tags.includes("high")) return "high";
  if (ctx.tags.includes("low")) return "low";
  return "normal";
}

// ─── Engine ─────────────────────────────────────────────────────────────────

export class NotificationEngine {
  private rules: NotificationRule[] = [];
  private channels = new Map<string, SmartChannel>();
  /** Tracks last send time per cooldown key (ruleId:source). */
  private cooldowns = new Map<string, number>();

  /** Add or replace a rule. */
  addRule(rule: NotificationRule): void {
    const idx = this.rules.findIndex((r) => r.id === rule.id);
    if (idx >= 0) {
      this.rules[idx] = rule;
    } else {
      this.rules.push(rule);
    }
    // Keep sorted by weight descending so highest-weight rules evaluate first.
    this.rules.sort((a, b) => b.weight - a.weight);
  }

  /** Remove a rule by id. */
  removeRule(id: string): void {
    this.rules = this.rules.filter((r) => r.id !== id);
  }

  /** Get all registered rules. */
  getRules(): readonly NotificationRule[] {
    return this.rules;
  }

  /** Register a smart channel. */
  registerChannel(channel: SmartChannel): void {
    this.channels.set(channel.name, channel);
  }

  /** Unregister a channel by name. */
  unregisterChannel(name: string): void {
    this.channels.delete(name);
  }

  /** Evaluate all rules against a context and return the result. */
  evaluate(ctx: NotificationContext): EvaluationResult {
    const matchedRules: NotificationRule[] = [];
    const now = Date.now();

    for (const rule of this.rules) {
      if (!matchRule(ctx, rule)) continue;

      // Cooldown check
      if (rule.action.cooldownSeconds) {
        const key = `${rule.id}:${ctx.source}`;
        const lastSent = this.cooldowns.get(key);
        if (lastSent && now - lastSent < rule.action.cooldownSeconds * 1000) {
          log.debug("rule skipped by cooldown", { ruleId: rule.id, source: ctx.source });
          continue;
        }
      }

      matchedRules.push(rule);

      if (rule.terminal) break;
    }

    // Resolve priority: highest from matched rules, falling back to context-derived
    let priority = derivePriority(ctx);
    for (const rule of matchedRules) {
      if (rule.action.priority && PRIORITY_ORDER[rule.action.priority] > PRIORITY_ORDER[priority]) {
        priority = rule.action.priority;
      }
    }

    // Collect channels from matched rules (deduplicated)
    const channelSet = new Set<string>();
    for (const rule of matchedRules) {
      for (const ch of rule.action.channels) {
        channelSet.add(ch);
      }
    }
    const channels = [...channelSet];

    return {
      context: ctx,
      matchedRules,
      priority,
      channels,
      shouldDeliver: matchedRules.length > 0,
    };
  }

  /** Evaluate and dispatch a notification. Returns per-channel success map. */
  async dispatch(ctx: NotificationContext): Promise<Record<string, boolean>> {
    const result = this.evaluate(ctx);
    const outcomes: Record<string, boolean> = {};

    if (!result.shouldDeliver) {
      log.debug("no rules matched, skipping dispatch", { source: ctx.source, eventType: ctx.eventType });
      return outcomes;
    }

    log.info("dispatching notification", {
      matchedRules: result.matchedRules.length,
      priority: result.priority,
      channels: result.channels,
      eventType: ctx.eventType,
    });

    const now = Date.now();

    // Update cooldowns for matched rules
    for (const rule of result.matchedRules) {
      if (rule.action.cooldownSeconds) {
        this.cooldowns.set(`${rule.id}:${ctx.source}`, now);
      }
    }

    // Dispatch to each resolved channel
    const sends = result.channels.map(async (chName) => {
      const channel = this.channels.get(chName);
      if (!channel || !channel.enabled) {
        log.warn("channel unavailable or disabled", { channel: chName });
        outcomes[chName] = false;
        return;
      }

      // Check channel's minimum priority
      if (PRIORITY_ORDER[result.priority] < PRIORITY_ORDER[channel.minPriority]) {
        log.debug("notification below channel min priority", {
          channel: chName,
          priority: result.priority,
          minPriority: channel.minPriority,
        });
        outcomes[chName] = false;
        return;
      }

      try {
        outcomes[chName] = await channel.send(ctx, result.priority);
      } catch (err) {
        log.error("channel send failed", { channel: chName, error: String(err) });
        outcomes[chName] = false;
      }
    });

    await Promise.allSettled(sends);
    return outcomes;
  }

  /** Clear all cooldown state (useful for testing). */
  clearCooldowns(): void {
    this.cooldowns.clear();
  }
}
