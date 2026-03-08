/**
 * Notification system — legacy alert channels + smart rule-based engine.
 *
 * Two layers:
 * - Legacy: NotificationDispatcher broadcasts Alert objects to channels
 * - Smart: NotificationEngine evaluates rules against context, routes to SmartChannels
 *
 * LegacyChannelAdapter bridges them — existing email/SMS/webhook channels
 * work with both layers without rewriting.
 */

// ─── Legacy alert-based dispatch ─────────────────────────────────────────────
export { NotificationDispatcher } from "./channel.js";
export type { NotificationChannel } from "./channel.js";

// ─── Concrete channels (legacy interface) ────────────────────────────────────
export { EmailChannel } from "./email.js";
export type { EmailChannelConfig } from "./email.js";

export { SmsChannel } from "./sms.js";
export type { SmsChannelConfig } from "./sms.js";

export { WebhookChannel } from "./webhook.js";
export type { WebhookChannelConfig } from "./webhook.js";

export { PhoneChannel } from "./phone.js";

// ─── Smart rule-based engine ─────────────────────────────────────────────────
export {
  NotificationEngine,
  evaluateCondition,
  matchRule,
  derivePriority,
} from "./engine.js";

export type {
  NotificationPriority,
  NotificationContext,
  NotificationRule,
  RuleCondition,
  RuleAction,
  RuleMatch,
  EvaluationResult,
  SmartChannel,
} from "./types.js";

export { PRIORITY_ORDER } from "./types.js";

// ─── Smart channel adapters ──────────────────────────────────────────────────
export { LegacyChannelAdapter } from "./channels/adapter.js";
export { LogChannel } from "./channels/log.js";
