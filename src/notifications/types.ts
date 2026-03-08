/**
 * Smart notification system types.
 *
 * Defines rule-based notification routing with priority,
 * context awareness, and channel preferences.
 */

// ─── Priority ───────────────────────────────────────────────────────────────

/** Notification priority levels, highest to lowest. */
export type NotificationPriority = "critical" | "high" | "normal" | "low";

/** Priority ordering for comparison. */
export const PRIORITY_ORDER: Record<NotificationPriority, number> = {
  critical: 4,
  high: 3,
  normal: 2,
  low: 1,
};

// ─── Context ────────────────────────────────────────────────────────────────

/** Context available when evaluating notification rules. */
export interface NotificationContext {
  /** Current gear: calm or crisis. */
  gear: "calm" | "crisis";
  /** ISO timestamp of the event. */
  timestamp: string;
  /** Source system that produced the event (e.g., "health", "board", "agent"). */
  source: string;
  /** Event type identifier (e.g., "alert.fired", "task.completed", "agent.error"). */
  eventType: string;
  /** Arbitrary event payload — shape depends on source/eventType. */
  payload: Record<string, unknown>;
  /** Tags for rule matching (e.g., ["ops", "memory", "critical"]). */
  tags: string[];
  /** Optional user/agent ID this event is associated with. */
  actor?: string;
}

// ─── Rule conditions ────────────────────────────────────────────────────────

/** A single condition within a rule. All conditions in a rule must match (AND). */
export interface RuleCondition {
  /** The field path to evaluate (dot notation into NotificationContext). */
  field: string;
  /** Comparison operator. */
  operator: "eq" | "neq" | "in" | "not_in" | "contains" | "gt" | "lt" | "exists";
  /** Value to compare against. Type depends on operator. */
  value: unknown;
}

// ─── Notification rules ─────────────────────────────────────────────────────

/** Delivery preferences when a rule matches. */
export interface RuleAction {
  /** Which channels to deliver through. Empty = use defaults. */
  channels: string[];
  /** Priority override. If omitted, derived from context. */
  priority?: NotificationPriority;
  /** Minimum seconds between repeat notifications for the same rule+source. */
  cooldownSeconds?: number;
  /** Whether to aggregate similar notifications. */
  aggregate?: boolean;
  /** Template name for message formatting. */
  template?: string;
}

/** A notification rule: when conditions match, perform the action. */
export interface NotificationRule {
  /** Unique rule identifier. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Whether this rule is active. */
  enabled: boolean;
  /** Conditions that must ALL match for this rule to fire (AND logic). */
  conditions: RuleCondition[];
  /** What to do when the rule matches. */
  action: RuleAction;
  /** Higher weight rules are evaluated first and can short-circuit. */
  weight: number;
  /** Optional: stop evaluating further rules if this one matches. */
  terminal?: boolean;
}

// ─── Engine types ───────────────────────────────────────────────────────────

/** Result of evaluating a single rule against a context. */
export interface RuleMatch {
  rule: NotificationRule;
  /** Whether all conditions passed. */
  matched: boolean;
}

/** Result of the full engine evaluation. */
export interface EvaluationResult {
  /** The context that was evaluated. */
  context: NotificationContext;
  /** Rules that matched, in evaluation order. */
  matchedRules: NotificationRule[];
  /** Resolved priority (highest from matched rules, or derived from context). */
  priority: NotificationPriority;
  /** Channels to deliver to (union of all matched rule channels, deduplicated). */
  channels: string[];
  /** Whether delivery should proceed (false if all rules were suppressed by cooldown). */
  shouldDeliver: boolean;
}

// ─── Smart channel ──────────────────────────────────────────────────────────

/** Extended channel interface for smart notifications. */
export interface SmartChannel {
  /** Channel identifier. */
  name: string;
  /** Whether this channel is enabled. */
  enabled: boolean;
  /** Minimum priority this channel accepts. Messages below are dropped. */
  minPriority: NotificationPriority;
  /** Send a notification. Returns true on success. */
  send(context: NotificationContext, priority: NotificationPriority): Promise<boolean>;
}
