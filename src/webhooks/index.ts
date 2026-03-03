/**
 * Webhook system — generic registry, handlers, and provider integrations.
 *
 * Usage:
 *   import { routeWebhook, listProviders } from "./webhooks/index.js";
 *
 * Providers export objects for deferred batch registration via registerProviders():
 *   import { githubProvider } from "../github/webhooks.js";
 *   import { slackEventsProvider, ... } from "../slack/webhooks.js";
 *   import { twilioProvider } from "./twilio.js";
 *   registerProviders([githubProvider, ...slackProviders, twilioProvider]);
 */

// ── Types (canonical source) ─────────────────────────────────────────────────

export type {
  WebhookResult,
  VerifyContext,
  WebhookRetryOpts,
  WebhookProvider,
  WebhookEvent,
  WebhookRequestContext,
  WebhookMiddleware,
  ProviderStats,
  ProviderHealth,
  ProviderHealthSummary,
  DeduplicationOpts,
  EventHandler,
  SignatureAlgorithm,
  WebhookProviderConfig,
  WebhookSystemConfig,
} from "./types.js";

// ── Registry ─────────────────────────────────────────────────────────────────

export {
  registerProvider,
  registerProviders,
  getProvider,
  listProviders,
  removeProvider,
  recordSuccess,
  recordFailure,
  getProviderStats,
  getAllProviderStats,
  resetProviderStats,
  getProviderHealth,
  getAllProviderHealth,
} from "./registry.js";

// ── Signature verification ───────────────────────────────────────────────────

export {
  hmacSha256Hex,
  hmacSha256Base64,
  hmacSha1Base64,
  timingSafeCompare,
  isTimestampFresh,
  verifyHmacSha256Hex,
  verifyHmacSha256Base64,
  verifySlackV0,
  verifyTwilio,
} from "./verify.js";

// ── Routing & dispatching ────────────────────────────────────────────────────

export {
  routeWebhook,
  routeWebhookRequest,
  composeMiddleware,
  validateRequest,
  deduplicateRequests,
  rateLimitRequests,
  createWebhookEvent,
  createEventRouter,
  normalizeToEvent,
} from "./router.js";

// ── Retry & error handling ───────────────────────────────────────────────────

export {
  withWebhookRetry,
  classifyError,
  createWebhookError,
  DeadLetterQueue,
  withRetryHandler,
} from "./retry.js";

export type { WebhookErrorKind, WebhookError, DeadLetterEntry } from "./retry.js";

// ── Configuration management ─────────────────────────────────────────────────

export {
  getConfig,
  setConfig,
  getProviderConfig,
  setProviderConfig,
  setProviderConfigs,
  removeProviderConfig,
  listConfiguredProviders,
  resolveSecret,
  getProviderSecret,
  getProviderRetryOpts,
  isProviderEnabled,
  validateProviderConfig,
  validateConfig,
  loadConfigFromFile,
  saveConfigToFile,
} from "./config.js";

// ── Handler utilities ────────────────────────────────────────────────────────

export {
  safeHandler,
  createHmacSha256HexProvider,
  createHmacSha256Base64Provider,
  createSlackStyleProvider,
  createTwilioStyleProvider,
  registerHmacSha256HexProvider,
  registerHmacSha256Base64Provider,
  registerSlackStyleProvider,
  registerTwilioStyleProvider,
  withLogging,
} from "./handlers.js";

// ── Base class ──────────────────────────────────────────────────────────────

export { WebhookHandler } from "./handler.js";
export type { WebhookHandlerConfig } from "./handler.js";

// ── Route mounting & admin ──────────────────────────────────────────────────

export {
  mountWebhookAdmin,
  createWebhookRoute,
  verifyWebhookRequest,
  processVerifiedWebhook,
  getDeadLetterQueue,
} from "./mount.js";

export type { WebhookRouteOpts } from "./mount.js";

// ── Relay verification ──────────────────────────────────────────────────────

export { verifyRelaySignature } from "./relay.js";
export type { RelayVerifyResult } from "./relay.js";

// ── Event log (debugging) ────────────────────────────────────────────────────

export {
  logWebhookEvent,
  startEventTimer,
  getRecentEvents,
  getEventLogSummary,
  clearEventLog,
  setEventLogMaxSize,
  getEventLogMaxSize,
} from "./event-log.js";

export type {
  WebhookEventLogEntry,
  EventLogFilter,
  EventLogSummary,
} from "./event-log.js";
