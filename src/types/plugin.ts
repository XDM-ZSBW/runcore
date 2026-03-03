/**
 * Plugin system type definitions.
 *
 * Formalizes the shared patterns across Google, Slack, Linear, and Twilio
 * integrations into a standard plugin interface.
 *
 * See docs/specs/plugin-system.md for the full specification.
 */

import type { WebhookProvider, WebhookResult } from "../webhooks/registry.js";

// ── Result Types ────────────────────────────────────────────────────────────

/**
 * Standard result returned by all plugin client methods.
 * Matches the existing { ok, data?, message } pattern used across all integrations.
 */
export interface PluginResult<T = unknown> {
  ok: boolean;
  data?: T;
  message: string;
}

// ── Capabilities ────────────────────────────────────────────────────────────

/** Capabilities a plugin can declare. */
export type PluginCapability =
  | "read"      // Can fetch/read external data
  | "write"     // Can create/modify external data
  | "notify"    // Can send notifications
  | "webhook"   // Can receive webhook events
  | "poll"      // Can poll for updates on a timer
  | "context"   // Can inject context into LLM turns
  | "oauth"     // Supports OAuth flow (auth/callback routes)
  ;

// ── Plugin Manifest ─────────────────────────────────────────────────────────

/** Static metadata describing a plugin's identity and requirements. */
export interface PluginManifest {
  /** Unique plugin identifier (e.g., "google", "slack", "linear"). */
  name: string;

  /** SemVer version string. */
  version: string;

  /** Human-readable description. */
  description: string;

  /** Auth mechanism used by this plugin. */
  authType: "oauth2" | "api_key" | "token" | "none";

  /** Vault keys this plugin requires (e.g., ["GOOGLE_CLIENT_ID"]). */
  requiredConfig: string[];

  /** Vault keys that are optional (e.g., ["GOOGLE_REFRESH_TOKEN"]). */
  optionalConfig?: string[];

  /** OAuth2 scopes (only relevant for authType: "oauth2"). */
  scopes?: string[];

  /** Keywords that trigger context injection for this plugin. */
  contextKeywords?: RegExp;

  /** Capabilities this plugin provides. */
  capabilities: PluginCapability[];
}

// ── Error Handling & Retry ──────────────────────────────────────────────────

/**
 * Error classification shared across all plugin API clients.
 * Determines retry strategy:
 * - "transient": retry with exponential backoff (network errors, 429, 5xx)
 * - "permanent": fail immediately (bad request, validation errors)
 * - "auth": fail immediately and prompt re-auth (401, 403, revoked tokens)
 *
 * See src/linear/retry.ts and src/slack/retry.ts for existing implementations.
 */
export type ErrorKind = "transient" | "permanent" | "auth";

/**
 * Standard retry configuration used by plugin API clients.
 * Backoff formula: delay = min(baseDelayMs × 2^(attempt-1), maxDelayMs) × jitter
 * where jitter is a random factor in [0.5, 1.0).
 */
export interface RetryOptions {
  /** Maximum number of attempts (including the first). Default: 3. */
  maxAttempts?: number;
  /** Base delay in ms before first retry. Default: 1000. */
  baseDelayMs?: number;
  /** Maximum delay in ms. Default: 30000. */
  maxDelayMs?: number;
  /** Label for log messages (e.g., "LinearAPI.listIssues"). */
  label?: string;
}

/**
 * Base interface for typed API errors thrown by plugin clients.
 * Each integration extends Error with these fields.
 *
 * Existing implementations:
 * - LinearApiError (src/linear/retry.ts)
 * - SlackApiError (src/slack/retry.ts)
 */
export interface PluginApiErrorFields {
  /** Error classification. */
  readonly kind: ErrorKind;
  /** HTTP status code, if applicable. */
  readonly statusCode?: number;
  /** Original error that caused this one. */
  readonly cause?: unknown;
}

// ── Auth Provider ───────────────────────────────────────────────────────────

/** Result of an authentication attempt. */
export interface AuthResult {
  ok: boolean;
  message: string;
  /** Tokens or keys to persist in vault (key → value). */
  credentials?: Record<string, string>;
}

/** Standard auth interface for plugins. */
export interface PluginAuthProvider {
  /** Check if required credentials exist in vault. */
  isConfigured(): boolean;

  /** Check if the plugin has valid auth (token exists and is not expired). */
  isAuthenticated(): boolean;

  /** Build OAuth authorization URL. Only for OAuth plugins. */
  getAuthUrl?(redirectUri: string): PluginResult<string>;

  /** Exchange OAuth code for tokens. Only for OAuth plugins. */
  exchangeCode?(code: string, redirectUri: string): Promise<AuthResult>;

  /** Get a valid access token (handles caching and refresh internally). */
  getAccessToken?(): Promise<PluginResult<string>>;

  /** Invalidate cached credentials (e.g., on 401 response). */
  clearCredentials(): void;
}

// ── Client ──────────────────────────────────────────────────────────────────

/** Client health snapshot. */
export interface PluginClientHealth {
  available: boolean;
  lastError: string | null;
  lastErrorAt: string | null;
}

/**
 * Base interface for plugin API clients.
 * Plugins extend this with service-specific methods.
 *
 * Design rules (from existing integrations):
 * - Never throw from public methods — return PluginResult
 * - No external SDKs — use raw fetch()
 * - 15s default timeout, 30s for uploads
 * - Auto-retry once on 401 with fresh token
 */
export interface PluginClient {
  /** Plugin this client belongs to. */
  readonly pluginName: string;

  /** Whether the client is ready to make API calls. */
  isAvailable(): boolean;

  /** Health status of the client. */
  getHealth(): PluginClientHealth;
}

// ── Context Injection ───────────────────────────────────────────────────────

/** A context block to inject into the LLM message array. */
export interface ContextInjection {
  /** Label for the context block (e.g., "Today's calendar"). */
  label: string;
  /** Formatted content string for injection. */
  content: string;
  /**
   * Insertion priority — lower numbers insert earlier in the message array.
   * Default: 50.
   */
  priority?: number;
}

/** Interface for plugins that inject context into LLM turns. */
export interface PluginContextProvider {
  /** Keywords that trigger context injection (tested against user message). */
  readonly contextKeywords: RegExp;

  /**
   * Fetch and format context data for injection.
   * Called when contextKeywords matches the user's message.
   * Returns null if no relevant context is available.
   */
  getContext(userMessage: string): Promise<ContextInjection | null>;
}

// ── Timer (Polling) ─────────────────────────────────────────────────────────

/**
 * Interface for plugins that poll external services on a timer.
 *
 * Design rules (from existing timers):
 * - Idempotent start/stop — safe to call multiple times
 * - Module-level state: timer handle + dedup set
 * - Never throws — logs errors via activity log
 * - Pushes via pushNotification() on new data
 * - Auto-prunes dedup sets to prevent unbounded growth
 */
export interface PluginTimerProvider {
  /** Start polling. No-op if already running. */
  startTimer(intervalMs?: number): void;
  /** Stop polling. No-op if already stopped. */
  stopTimer(): void;
  /** Whether the timer is currently running. */
  isTimerRunning(): boolean;
}

// ── Webhooks ────────────────────────────────────────────────────────────────

/** An HTTP route a plugin wants mounted on the server. */
export interface PluginRoute {
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  /** URL path (e.g., "/api/slack/events"). */
  path: string;
  /** Route handler. */
  handler: (req: PluginRequest) => Promise<PluginResponse>;
}

/** Normalized incoming HTTP request passed to plugin route handlers. */
export interface PluginRequest {
  /** Parsed JSON body (or null if not JSON). */
  body: unknown;
  /** Raw request body string. */
  rawBody: string;
  /** Request headers (lowercase keys). */
  headers: Record<string, string>;
  /** URL path parameters. */
  params: Record<string, string>;
  /** URL query parameters. */
  query: Record<string, string>;
}

/** Response from a plugin route handler. */
export interface PluginResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** Interface for plugins that receive webhook events. */
export interface PluginWebhookProvider {
  /** WebhookProvider(s) to register with the webhook registry. */
  getWebhookProviders(): WebhookProvider[];

  /** API routes this plugin needs mounted on the server. */
  getRoutes(): PluginRoute[];
}

// ── Timer Health ────────────────────────────────────────────────────────────

/**
 * Health snapshot for a polling timer with dynamic backoff.
 * Matches the pattern in src/queue/timer.ts.
 */
export interface PluginTimerHealth {
  /** Whether the timer is running (or paused waiting for auth). */
  running: boolean;
  /** Number of consecutive failures (resets on success). */
  consecutiveFailures: number;
  /** Total sync/poll cycles completed. */
  totalCycles: number;
  /** Total errors across all cycles. */
  totalErrors: number;
  /** Current interval in ms (may be backed off from base). */
  currentIntervalMs: number;
  /** ISO timestamp of last cycle, or null if never run. */
  lastCycleAt: string | null;
  /** Whether sync is paused due to auth failure. */
  authPaused: boolean;
}

// ── Plugin Context (Runtime Environment) ────────────────────────────────────

/** Shared runtime context passed to plugin lifecycle methods. */
export interface PluginContext {
  /** Brain directory path. */
  brainDir: string;

  /** Log an activity entry. */
  logActivity: (opts: {
    source: string;
    summary: string;
    detail?: string;
  }) => void;

  /** Push a user-visible notification. */
  pushNotification: (opts: {
    timestamp: string;
    source: string;
    message: string;
  }) => void;

  /** Read a vault key (returns undefined if not set). */
  getVaultKey: (key: string) => string | undefined;

  /** Write a vault key (persists across restarts). */
  setVaultKey: (key: string, value: string) => Promise<void>;

  /** Register a webhook provider with the central registry. */
  registerWebhookProvider: (provider: WebhookProvider) => void;
}

// ── Plugin Lifecycle ────────────────────────────────────────────────────────

/** Plugin lifecycle methods. */
export interface PluginLifecycle {
  /**
   * Validate config, check dependencies.
   * Called once when the plugin is registered with the registry.
   */
  init(ctx: PluginContext): Promise<void>;

  /**
   * Establish auth (OAuth exchange, API key validation, etc).
   * May be called multiple times (e.g., after re-auth).
   */
  authenticate(ctx: PluginContext): Promise<AuthResult>;

  /**
   * Start background work: polling timers, webhook listeners.
   * Called after successful authentication.
   */
  start(ctx: PluginContext): Promise<void>;

  /**
   * Stop background work, release resources.
   * Called on server shutdown. Must be idempotent.
   */
  stop(): Promise<void>;
}

// ── Complete Plugin Interface ───────────────────────────────────────────────

/** State a plugin can be in. */
export type PluginState =
  | "loaded"    // Module imported, manifest read
  | "ready"     // init() completed, config validated
  | "authed"    // authenticate() succeeded, client operational
  | "active"    // start() completed, timers/webhooks running
  | "stopped"   // stop() completed, resources released
  | "error"     // Fatal error in any lifecycle phase
  ;

/** Runtime status snapshot for a plugin. */
export interface PluginStatus {
  name: string;
  state: PluginState;
  configured: boolean;
  authenticated: boolean;
  capabilities: PluginCapability[];
  error?: string;
  health?: PluginClientHealth;
}

/** Map of plugin name → status. */
export type PluginStatusMap = Record<string, PluginStatus>;

/**
 * Complete plugin interface.
 *
 * A plugin is the composition of:
 * - Manifest (identity + requirements)
 * - Auth provider (credential management)
 * - Client (API wrapper)
 * - Optional: context provider, timer provider, webhook provider
 *
 * All methods follow the never-throw / { ok, data?, message } pattern
 * established by the existing Google and Slack integrations.
 */
export interface Plugin extends PluginLifecycle {
  /** Static manifest describing the plugin. */
  readonly manifest: PluginManifest;

  /** Auth provider. Required for all plugins except authType: "none". */
  readonly auth: PluginAuthProvider;

  /** API client instance. Available after authenticate(). */
  readonly client: PluginClient;

  /** Context provider (optional — for plugins that inject LLM context). */
  readonly context?: PluginContextProvider;

  /** Timer provider (optional — for plugins that poll). */
  readonly timer?: PluginTimerProvider;

  /** Webhook provider (optional — for plugins that receive events). */
  readonly webhooks?: PluginWebhookProvider;
}

// ── Plugin Registry ─────────────────────────────────────────────────────────

/**
 * Registry for managing plugin lifecycle.
 *
 * Responsibilities:
 * - Track registered plugins and their states
 * - Orchestrate init → authenticate → start lifecycle
 * - Provide context providers to the chat loop
 * - Graceful shutdown of all plugins
 */
export interface PluginRegistry {
  /** Register a plugin. Validates config and calls init(). */
  register(plugin: Plugin, ctx: PluginContext): Promise<void>;

  /** Get a registered plugin by name. */
  get(name: string): Plugin | undefined;

  /** List all registered plugin names. */
  list(): string[];

  /** Remove and stop a plugin. */
  unregister(name: string): Promise<void>;

  /** Authenticate all registered plugins that have credentials. */
  authenticateAll(ctx: PluginContext): Promise<Map<string, AuthResult>>;

  /** Start all authenticated plugins. */
  startAll(ctx: PluginContext): Promise<void>;

  /** Stop all active plugins. Called on server shutdown. */
  stopAll(): Promise<void>;

  /** Get all context providers for LLM context injection. */
  getContextProviders(): Array<{ name: string; provider: PluginContextProvider }>;

  /** Get status summary for all plugins. */
  getStatus(): PluginStatusMap;
}
