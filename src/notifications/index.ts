/**
 * Notification channels for the Core alerting system.
 *
 * Provides email, SMS, and webhook delivery channels plus a
 * dispatcher that routes alerts to the appropriate channels.
 */

export { NotificationDispatcher } from "./channel.js";
export type { NotificationChannel } from "./channel.js";

export { EmailChannel } from "./email.js";
export type { EmailChannelConfig } from "./email.js";

export { SmsChannel } from "./sms.js";
export type { SmsChannelConfig } from "./sms.js";

export { WebhookChannel } from "./webhook.js";
export type { WebhookChannelConfig } from "./webhook.js";

export { PhoneChannel } from "./phone.js";
