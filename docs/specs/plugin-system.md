# Plugin System Specification

> Extracted from existing integration patterns in Google, Slack, Linear, and Twilio/WhatsApp.
> This spec formalizes the shared architecture into a plugin interface for consistent
> future integration development and potential refactoring of existing code.

## 1. Observed Patterns

Every integration in the codebase follows the same four-layer architecture:

```
┌────────────────────────────────┐
│  1. Auth Provider              │  isConfigured() / isAuthenticated()
│     OAuth flow or API key      │  getAuthUrl() / exchangeCode()
├────────────────────────────────┤
│  2. Client Wrapper             │  Never-throws API calls
│     Raw fetch(), no SDKs       │  Returns { ok, data?, message }
├────────────────────────────────┤
│  3. Ingress (timers/webhooks)  │  Polling timers or webhook handlers
│     Background data collection │  Signature verification
├────────────────────────────────┤
│  4. Context Injection          │  formatForContext() helpers
│     Feed data into LLM turns   │  Keyword-triggered splice into messages
└────────────────────────────────┘
```

### 1.1 Auth Layer

| Integration | Auth Type | Config Source | Status Functions |
|-------------|-----------|---------------|------------------|
| Google | OAuth2 (refresh token) | Vault env vars | `isGoogleConfigured()`, `isGoogleAuthenticated()` |
| Slack | OAuth2 (bot token) | Vault env vars | `isSlackConfigured()`, `isSlackAuthenticated()` |
| Linear | API key | Vault env var | `process.env.LINEAR_API_KEY` check |
| Twilio | Auth token | Vault env var | `process.env.TWILIO_AUTH_TOKEN` check |

All auth modules share:
- `isConfigured(): boolean` — credentials exist in vault
- `isAuthenticated(): boolean` — tokens are valid/present
- Never throw — return `{ ok: boolean; message: string }` result objects
- In-memory token caching with auto-refresh (Google: 60s buffer before expiry; Slack: 5min TTL)

### 1.2 Client Layer

All API clients share:
- **No external SDKs** — raw `fetch()` with URL construction
- **Never-throws pattern** — every public method returns `{ ok: boolean; data?: T; message: string }`
- **Timeouts** — 15s default, 30s for attachment/upload operations
- **401 retry** — auto-clear cached token and retry once on auth failure (Google)
- **Lazy singleton** — single instance created on first use, recreated if credentials change (Slack)

### 1.3 Ingress Layer

Two ingress mechanisms exist:

**Polling Timers** (Google Calendar, Gmail, Tasks):
- Module-level state: timer handle + deduplication set
- `startXTimer(intervalMs?)` / `stopXTimer()` / `isXTimerRunning()`
- Idempotent start/stop — safe to call multiple times
- Notification dedup via ID tracking sets (auto-pruned)
- Push to `pushNotification()` on new data

**Webhook Handlers** (Slack, Linear, Twilio):
- Register via `WebhookProvider` interface in `src/webhooks/registry.ts`
- Each provider implements `verify()` + `process()`
- Factory helpers for common signature schemes: HMAC-SHA256 hex/base64, Slack v0, Twilio SHA1
- Wrapped in `safeHandler()` — never throws
- Stats tracking per provider (invocations, successes, failures)

### 1.4 Context Injection Layer

All integrations export `format*ForContext()` functions that produce delimited text blocks
injected into the LLM message array at position 1 (after system prompt, before history):

```typescript
ctx.messages.splice(1, 0, {
  role: "system",
  content: `--- Today's calendar (${date}) ---\n${formatted}\n--- End calendar ---`
});
```

Injection is triggered by keyword detection on the user's message:
- Calendar: `/(calendar|meeting|schedule|today)/i`
- Gmail: `/(email|mail|message|inbox)/i`
- Tasks: `/(task|todo|reminder|due)/i`
- Board: `/(issue|board|backlog|sprint)/i`

---

## 2. Plugin Lifecycle

A plugin progresses through these states:

```
         ┌──────────┐
         │  loaded   │  Module imported, manifest read
         └────┬─────┘
              │ init()
         ┌────▼─────┐
         │  ready    │  Config validated, dependencies checked
         └────┬─────┘
              │ authenticate()
         ┌────▼─────┐
         │  authed   │  Credentials valid, client operational
         └────┬─────┘
              │ start()
         ┌────▼─────┐
         │  active   │  Timers running, webhooks registered
         └────┬─────┘
              │ stop()
         ┌────▼─────┐
         │  stopped  │  Timers cleared, resources released
         └──────────┘
```

### 2.1 Lifecycle Methods

```typescript
interface PluginLifecycle {
  /** Validate config, check dependencies. Called once on registration. */
  init(ctx: PluginContext): Promise<void>;

  /** Establish auth (OAuth exchange, API key validation, etc). */
  authenticate(ctx: PluginContext): Promise<AuthResult>;

  /** Start background work: polling timers, webhook listeners. */
  start(ctx: PluginContext): Promise<void>;

  /** Stop background work, release resources. Called on shutdown. */
  stop(): Promise<void>;
}
```

### 2.2 Plugin States

```
loaded  → init()          → ready
ready   → authenticate()  → authed | ready (auth optional)
authed  → start()         → active
active  → stop()          → stopped
*       → error           → (any state can transition to error)
```

---

## 3. Standard Interfaces

### 3.1 Plugin Manifest

Every plugin declares its identity and requirements:

```typescript
interface PluginManifest {
  /** Unique plugin identifier (e.g., "google", "slack", "linear"). */
  name: string;

  /** SemVer version string. */
  version: string;

  /** Human-readable description. */
  description: string;

  /** Auth mechanism used by this plugin. */
  authType: "oauth2" | "api_key" | "token" | "none";

  /** Vault keys this plugin requires (e.g., ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]). */
  requiredConfig: string[];

  /** Vault keys that are optional. */
  optionalConfig?: string[];

  /** OAuth2 scopes (only for authType: "oauth2"). */
  scopes?: string[];

  /** Keywords that trigger context injection for this plugin. */
  contextKeywords?: RegExp;

  /** Capabilities this plugin provides. */
  capabilities: PluginCapability[];
}

type PluginCapability =
  | "read"           // Can fetch/read external data
  | "write"          // Can create/modify external data
  | "notify"         // Can send notifications
  | "webhook"        // Can receive webhook events
  | "poll"           // Can poll for updates on a timer
  | "context"        // Can inject context into LLM turns
  | "oauth"          // Supports OAuth flow (auth/callback routes)
  ;
```

### 3.2 Auth Provider

```typescript
interface PluginAuthProvider {
  /** Check if required credentials exist in vault. */
  isConfigured(): boolean;

  /** Check if the plugin has valid auth (token exists and not expired). */
  isAuthenticated(): boolean;

  /** Build OAuth authorization URL (for OAuth plugins). Returns null for API-key plugins. */
  getAuthUrl?(redirectUri: string): { ok: boolean; url?: string; message: string };

  /** Exchange OAuth code for tokens (for OAuth plugins). */
  exchangeCode?(code: string, redirectUri: string): Promise<AuthResult>;

  /** Get a valid access token (handles refresh internally). */
  getAccessToken?(): Promise<{ ok: boolean; token?: string; message: string }>;

  /** Invalidate cached credentials (e.g., on 401). */
  clearCredentials(): void;
}

interface AuthResult {
  ok: boolean;
  message: string;
  /** Tokens or keys to persist in vault. */
  credentials?: Record<string, string>;
}
```

### 3.3 Client Wrapper

```typescript
/**
 * Standard result type used by all client methods.
 * Matches the existing { ok, data?, message } pattern used across
 * Google, Slack, and Linear clients.
 */
interface PluginResult<T = unknown> {
  ok: boolean;
  data?: T;
  message: string;
}

/**
 * Base interface for plugin API clients.
 * Each plugin extends this with service-specific methods.
 */
interface PluginClient {
  /** Plugin this client belongs to. */
  readonly pluginName: string;

  /** Whether the client is ready to make API calls. */
  isAvailable(): boolean;

  /** Health status of the client. */
  getHealth(): {
    available: boolean;
    lastError: string | null;
    lastErrorAt: string | null;
  };
}
```

### 3.4 Context Provider

```typescript
interface PluginContextProvider {
  /** Keywords that trigger context injection (tested against user message). */
  readonly contextKeywords: RegExp;

  /**
   * Fetch and format context data for injection into the LLM turn.
   * Called when contextKeywords matches the user's message.
   * Returns null if no relevant context is available.
   */
  getContext(userMessage: string): Promise<ContextInjection | null>;
}

interface ContextInjection {
  /** Label for the context block (e.g., "Today's calendar"). */
  label: string;
  /** Formatted content string for injection. */
  content: string;
  /** Insertion priority — lower numbers insert earlier. Default: 50. */
  priority?: number;
}
```

### 3.5 Ingress Provider

```typescript
/** For plugins that poll external services on a timer. */
interface PluginTimerProvider {
  /** Start polling. Idempotent — safe to call when already running. */
  startTimer(intervalMs?: number): void;
  /** Stop polling. Idempotent. */
  stopTimer(): void;
  /** Whether the timer is currently running. */
  isTimerRunning(): boolean;
}

/** For plugins that receive webhook events. */
interface PluginWebhookProvider {
  /** The WebhookProvider(s) to register with the webhook registry. */
  getWebhookProviders(): WebhookProvider[];

  /** API routes this plugin needs mounted on the server. */
  getRoutes(): PluginRoute[];
}

interface PluginRoute {
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  path: string;
  handler: (req: PluginRequest) => Promise<PluginResponse>;
}

interface PluginRequest {
  body: unknown;
  rawBody: string;
  headers: Record<string, string>;
  params: Record<string, string>;
  query: Record<string, string>;
}

interface PluginResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}
```

### 3.6 Complete Plugin Interface

```typescript
interface Plugin extends PluginLifecycle {
  /** Static manifest describing the plugin. */
  readonly manifest: PluginManifest;

  /** Auth provider (required for all plugins except authType: "none"). */
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
```

### 3.7 Error Handling & Retry

Every integration classifies API errors into one of three kinds and applies the same
retry strategy. This pattern is identical in `src/linear/retry.ts` and `src/slack/retry.ts`.

#### Error Classification

```typescript
/** Shared error classification used by all plugin API clients. */
type ErrorKind = "transient" | "permanent" | "auth";

// Classification rules (same across all integrations):
// 401, 403, token_revoked, unauthorized  → "auth"     (never retry, credential is bad)
// 429, 5xx, network errors, timeouts     → "transient" (retry with backoff)
// Everything else                         → "permanent" (don't retry, request is wrong)
```

Slack adds a fourth kind (`"rate_limit"`) for logging but treats it identically to
`"transient"` for retry purposes.

#### Retry Strategy

```typescript
interface RetryOptions {
  /** Maximum attempts including the first. Default: 3. */
  maxAttempts?: number;
  /** Base delay in ms. Default: 1000. */
  baseDelayMs?: number;
  /** Maximum delay in ms. Default: 30000. */
  maxDelayMs?: number;
  /** Label for log messages. */
  label?: string;
}

async function withRetry<T>(fn: () => Promise<T>, opts?: RetryOptions): Promise<T>;
```

Backoff formula: `delay = min(baseDelay × 2^(attempt-1), maxDelay) × jitter`
where jitter is a random factor in `[0.5, 1.0)`.

Behavior by error kind:
- `"auth"` → throw immediately (prompt re-auth, don't waste attempts)
- `"permanent"` → throw immediately (request won't succeed on retry)
- `"transient"` → retry up to `maxAttempts` with exponential backoff

#### Plugin API Error

Each integration defines a typed error class extending `Error` with `kind` and
optional `statusCode`. The base pattern:

```typescript
class PluginApiError extends Error {
  constructor(
    message: string,
    public readonly kind: ErrorKind,
    public readonly statusCode?: number,
    public readonly cause?: unknown,
  ) { super(message); }
}
```

Existing implementations: `LinearApiError` (`src/linear/retry.ts`),
`SlackApiError` (`src/slack/retry.ts`).

### 3.8 Webhook Handler Composition

The webhook subsystem (`src/webhooks/handlers.ts`) provides reusable building blocks
for processing webhook events. All integrations compose handlers from these primitives.

#### Safe Execution Wrapper

Every webhook handler is wrapped in `safeHandler()` — catches exceptions and returns
a structured `WebhookResult` instead of throwing:

```typescript
function safeHandler(
  source: string,
  fn: (payload: unknown, ctx?) => Promise<WebhookResult>,
): (payload: unknown, ctx?) => Promise<WebhookResult>;
```

#### Event Router

Routes payloads to type-specific handlers using a type extractor function:

```typescript
function createEventRouter<T>(opts: {
  source: string;
  typeExtractor: (payload: T) => string;
  handlers: Record<string, EventHandler<T>>;
  defaultHandler?: EventHandler<T>;
}): (payload: unknown, ctx?) => Promise<WebhookResult>;
```

Example: Slack routes `event.type` to `handleAppMention`, `handleMessage`, etc.

#### Provider Factories

Pre-built providers for common signature verification schemes:

| Factory | Scheme | Used By |
|---------|--------|---------|
| `registerHmacSha256HexProvider()` | HMAC-SHA256, hex digest | Linear |
| `registerHmacSha256Base64Provider()` | HMAC-SHA256, base64 (optional `sha256=` prefix) | GitHub |
| `registerSlackStyleProvider()` | `v0={HMAC-SHA256 of "v0:{ts}:{body}"}` + timestamp freshness | Slack |
| `registerTwilioStyleProvider()` | HMAC-SHA1 of URL + sorted POST params, base64 | Twilio |

Each factory creates a `WebhookProvider`, calls `registerProvider()`, and returns it.

#### Handler Decorators

Composable wrappers that add cross-cutting concerns:

```typescript
withRetryHandler(source, fn, retryOpts)  // Retry transient failures
withLogging(source, fn)                   // Log receipt + unhandled events
normalizeToEvent(source, payload, opts)   // Wrap in typed WebhookEvent envelope
```

### 3.9 Webhook Middleware Pipeline

The webhook registry supports a middleware pipeline for request-level processing
(`src/webhooks/registry.ts`). Middleware runs before signature verification and
payload processing.

```typescript
type WebhookMiddleware = (
  ctx: WebhookRequestContext,
  next: () => Promise<WebhookResult>,
) => Promise<WebhookResult>;

function composeMiddleware(...middlewares: WebhookMiddleware[]): WebhookMiddleware;
```

Built-in middleware:

**Request Validation** — Rejects requests with wrong method, missing headers, or empty body:
```typescript
validateRequest({ allowedMethods?: string[], requiredHeaders?: string[], minBodyLength?: number })
```

**Deduplication** — Prevents duplicate webhook deliveries using delivery ID tracking
with bounded LRU + TTL eviction:
```typescript
deduplicateRequests({ maxSize?: number, ttlMs?: number, idHeader?: string })
```

High-level routing composes middleware with signature verification:
```typescript
routeWebhookRequest(ctx, { secret, signatureHeader, middleware, processorCtx })
```

### 3.10 Timer Backoff Strategy

Polling timers use dynamic backoff tracked at the module level (`src/queue/timer.ts`).
This pattern should be adopted by all timer-based plugins.

```
Base interval (default: 5 min)
  │
  ├─ On success     → reset to base interval
  ├─ On failure     → interval = base × 2^consecutiveFailures (max 30 min)
  └─ On auth failure → pause entirely, resume when credentials change
```

Additional timer behaviors:
- **Idempotent start/stop** — `startTimer()` when running is a no-op
- **Immediate first fire** — runs sync on start, then schedules subsequent runs
- **Auto-compaction** — compact JSONL files when lines exceed threshold (200)
- **Periodic grooming** — every N cycles, check for stale/vague items

Health tracking per timer:
```typescript
interface SyncHealth {
  running: boolean;
  consecutiveFailures: number;
  totalSyncs: number;
  totalErrors: number;
  currentIntervalMs: number;
  lastSyncAt: string | null;
  lastResult: SyncResult | null;
  authPaused: boolean;
}
```

---

## 4. Plugin Discovery and Loading

### 4.1 Directory Convention

Plugins live in `src/plugins/<name>/` with a standard structure:

```
src/plugins/
├── google/
│   ├── index.ts          # Plugin class (default export)
│   ├── auth.ts           # PluginAuthProvider implementation
│   ├── client.ts         # PluginClient implementation
│   ├── calendar.ts       # Calendar-specific methods
│   ├── gmail.ts          # Gmail-specific methods
│   ├── tasks.ts          # Tasks-specific methods
│   ├── timers.ts         # PluginTimerProvider(s)
│   └── context.ts        # PluginContextProvider
├── slack/
│   ├── index.ts
│   ├── auth.ts
│   ├── client.ts
│   ├── webhooks.ts       # PluginWebhookProvider
│   └── context.ts
├── linear/
│   ├── index.ts
│   ├── auth.ts
│   ├── client.ts
│   ├── webhooks.ts
│   └── sync.ts           # Bidirectional sync logic
└── twilio/
    ├── index.ts
    ├── auth.ts
    ├── client.ts
    └── webhooks.ts
```

### 4.2 Plugin Registry

```typescript
class PluginRegistry {
  private plugins = new Map<string, Plugin>();

  /** Register a plugin. Calls init(). */
  async register(plugin: Plugin, ctx: PluginContext): Promise<void>;

  /** Get a registered plugin by name. */
  get(name: string): Plugin | undefined;

  /** List all registered plugin names. */
  list(): string[];

  /** Remove and stop a plugin. */
  async unregister(name: string): Promise<void>;

  /** Authenticate all registered plugins that have credentials. */
  async authenticateAll(ctx: PluginContext): Promise<Map<string, AuthResult>>;

  /** Start all authenticated plugins. */
  async startAll(ctx: PluginContext): Promise<void>;

  /** Stop all active plugins. Called on server shutdown. */
  async stopAll(): Promise<void>;

  /** Get all context providers for LLM context injection. */
  getContextProviders(): Array<{ name: string; provider: PluginContextProvider }>;

  /** Get status summary for all plugins. */
  getStatus(): PluginStatusMap;
}

type PluginState = "loaded" | "ready" | "authed" | "active" | "stopped" | "error";

interface PluginStatus {
  name: string;
  state: PluginState;
  configured: boolean;
  authenticated: boolean;
  capabilities: PluginCapability[];
  error?: string;
  health?: { available: boolean; lastError: string | null };
}

type PluginStatusMap = Record<string, PluginStatus>;
```

### 4.3 Plugin Context

Shared context object passed to plugin lifecycle methods:

```typescript
interface PluginContext {
  /** Brain directory path (for file-based plugins). */
  brainDir: string;

  /** Activity logger. */
  logActivity: (opts: { source: string; summary: string; detail?: string }) => void;

  /** Push a user-visible notification. */
  pushNotification: (opts: { timestamp: string; source: string; message: string }) => void;

  /** Read a vault key. */
  getVaultKey: (key: string) => string | undefined;

  /** Write a vault key (persists across restarts). */
  setVaultKey: (key: string, value: string) => Promise<void>;

  /** Webhook provider registry (for registering webhook handlers). */
  registerWebhookProvider: (provider: WebhookProvider) => void;
}
```

---

## 5. Configuration Management

### 5.1 Vault-Based Credentials

All secrets are stored in the encrypted vault (`src/vault/store.ts`) and exposed as
`process.env.*` after `loadVault()`. Plugins declare required keys in their manifest:

```typescript
// Google plugin manifest (example)
{
  requiredConfig: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
  optionalConfig: ["GOOGLE_REFRESH_TOKEN"],
}
```

The plugin registry validates required keys are present before calling `init()`.

### 5.2 Plugin Settings

Runtime settings stored in `brain/settings.json` under a `plugins` key:

```json
{
  "plugins": {
    "google": {
      "enabled": true,
      "calendarTimerMs": 300000,
      "gmailTimerMs": 300000,
      "tasksTimerMs": 900000
    },
    "slack": {
      "enabled": true,
      "notifyChannel": "#general"
    },
    "linear": {
      "enabled": true,
      "syncTimerMs": 300000,
      "teamId": "DASH"
    }
  }
}
```

### 5.3 Feature Detection

Plugins advertise capabilities; the server checks before calling optional methods:

```typescript
function hasCapability(plugin: Plugin, cap: PluginCapability): boolean {
  return plugin.manifest.capabilities.includes(cap);
}

// Usage
if (hasCapability(googlePlugin, "poll")) {
  googlePlugin.timer?.startTimer();
}

if (hasCapability(slackPlugin, "webhook")) {
  for (const provider of slackPlugin.webhooks!.getWebhookProviders()) {
    ctx.registerWebhookProvider(provider);
  }
}
```

---

## 6. Server Integration

### 6.1 Initialization Flow

```typescript
// In src/server.ts startup sequence:

// 1. Create plugin context
const pluginCtx: PluginContext = {
  brainDir: BRAIN_DIR,
  logActivity,
  pushNotification,
  getVaultKey: (key) => process.env[key],
  setVaultKey: async (key, value) => { await setVaultKey(key, value); },
  registerWebhookProvider: registerProvider,
};

// 2. Register plugins
const registry = new PluginRegistry();
await registry.register(new GooglePlugin(), pluginCtx);
await registry.register(new SlackPlugin(), pluginCtx);
await registry.register(new LinearPlugin(), pluginCtx);
await registry.register(new TwilioPlugin(), pluginCtx);

// 3. Authenticate and start
await registry.authenticateAll(pluginCtx);
await registry.startAll(pluginCtx);

// 4. Mount plugin routes
for (const plugin of registry.list()) {
  const p = registry.get(plugin)!;
  if (p.webhooks) {
    for (const route of p.webhooks.getRoutes()) {
      app[route.method.toLowerCase()](route.path, async (c) => {
        const result = await route.handler({
          body: await c.req.json().catch(() => null),
          rawBody: await c.req.text(),
          headers: Object.fromEntries(c.req.raw.headers),
          params: c.req.param() as Record<string, string>,
          query: Object.fromEntries(new URL(c.req.url).searchParams),
        });
        return c.json(result.body, result.status as any);
      });
    }
  }
}
```

### 6.2 Context Injection in Chat Loop

```typescript
// In POST /api/chat handler, after Brain.getContextForTurn():

const providers = registry.getContextProviders();
const injections: ContextInjection[] = [];

for (const { name, provider } of providers) {
  if (provider.contextKeywords.test(chatMessage)) {
    const injection = await provider.getContext(chatMessage);
    if (injection) injections.push(injection);
  }
}

// Sort by priority (lower = earlier)
injections.sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50));

// Inject into message array
for (const inj of injections) {
  ctx.messages.splice(1, 0, {
    role: "system",
    content: `--- ${inj.label} ---\n${inj.content}\n--- End ${inj.label} ---`,
  });
}
```

### 6.3 Plugin Status Endpoint

```typescript
// GET /api/plugins/status
app.get("/api/plugins/status", (c) => {
  return c.json(registry.getStatus());
});
```

### 6.4 Shutdown

```typescript
// On SIGTERM/SIGINT:
await registry.stopAll();
```

---

## 7. Existing Integration Mapping

How each existing integration maps to the plugin interface:

### 7.1 Google Plugin

```
Manifest:
  name: "google"
  authType: "oauth2"
  requiredConfig: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]
  optionalConfig: ["GOOGLE_REFRESH_TOKEN"]
  scopes: [gmail.modify, calendar.events, drive.file, tasks]
  contextKeywords: /(calendar|meeting|schedule|today|email|mail|message|inbox|task|todo|reminder|due)/i
  capabilities: ["read", "write", "notify", "poll", "context", "oauth"]

Auth (src/google/auth.ts):
  → PluginAuthProvider
  isConfigured()       → checks GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET
  isAuthenticated()    → checks GOOGLE_REFRESH_TOKEN
  getAuthUrl()         → builds consent URL
  exchangeCode()       → trades code for refresh token
  getAccessToken()     → cached token with auto-refresh
  clearCredentials()   → clears cachedAccessToken

Client (src/google/calendar.ts, gmail.ts, tasks.ts, docs.ts):
  → PluginClient (composite — exposes calendar, gmail, tasks, docs sub-clients)
  isAvailable()        → isGoogleAuthenticated()
  getHealth()          → based on recent API call success/failure

Timer (src/google/calendar-timer.ts, gmail-timer.ts, tasks-timer.ts):
  → PluginTimerProvider (composite — 3 independent timers)
  startTimer()         → starts calendar (5min), gmail (5min), tasks (15min)
  stopTimer()          → stops all three
  isTimerRunning()     → any of three is running

Context (inline in src/server.ts):
  → PluginContextProvider
  contextKeywords      → calendar|meeting|schedule|email|mail|task|todo etc
  getContext()         → fetches schedule/inbox/tasks, calls format*ForContext()
```

### 7.2 Slack Plugin

```
Manifest:
  name: "slack"
  authType: "oauth2"
  requiredConfig: ["SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET"]
  optionalConfig: ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"]
  scopes: [app_mentions:read, chat:write, channels:read, ...]
  capabilities: ["read", "write", "notify", "webhook", "oauth"]

Auth (src/slack/client.ts):
  → PluginAuthProvider
  isConfigured()       → checks SLACK_CLIENT_ID + SLACK_CLIENT_SECRET
  isAuthenticated()    → checks SLACK_BOT_TOKEN
  getAuthUrl()         → builds "Add to Slack" URL
  exchangeCode()       → trades code for bot token

Client (src/slack/client.ts, channels.ts):
  → PluginClient
  Lazy singleton SlackClient
  sendMessage(), sendDm(), addReaction(), etc
  Retry with exponential backoff (src/slack/retry.ts)

Webhooks (src/slack/webhooks.ts):
  → PluginWebhookProvider
  3 providers: slack-events, slack-commands, slack-interactions
  Slack v0 signature verification
  Event routing via handler map

Routes:
  POST /api/slack/events      → Events API
  POST /api/slack/commands    → Slash commands
  POST /api/slack/interactions → Button clicks
  GET  /api/slack/auth        → OAuth initiation
  GET  /api/slack/callback    → OAuth callback
  POST /api/slack/send        → Send message
  POST /api/slack/dm          → Send DM
  GET  /api/slack/channels    → List channels
```

### 7.3 Linear Plugin

```
Manifest:
  name: "linear"
  authType: "api_key"
  requiredConfig: ["LINEAR_API_KEY"]
  optionalConfig: ["LINEAR_WEBHOOK_SECRET"]
  contextKeywords: /(issue|board|backlog|sprint|task|linear)/i
  capabilities: ["read", "write", "webhook", "poll", "context"]

Auth:
  → PluginAuthProvider
  isConfigured()       → checks LINEAR_API_KEY
  isAuthenticated()    → same as isConfigured (no refresh flow)

Client (src/linear/client.ts → QueueBoardProvider):
  → PluginClient
  GraphQL API via fetch
  listIssues(), createIssue(), updateIssue()

Timer (src/queue/timer.ts):
  → PluginTimerProvider
  Bidirectional sync with Linear (5min default)

Webhooks (src/linear/webhooks.ts):
  → PluginWebhookProvider
  HMAC-SHA256 hex verification
  Processes issue create/update/remove events

Context (inline in src/server.ts):
  → PluginContextProvider
  Injects current board issues when keywords match
```

### 7.4 Twilio/WhatsApp Plugin

```
Manifest:
  name: "twilio"
  authType: "token"
  requiredConfig: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"]
  optionalConfig: ["TWILIO_PHONE_NUMBER"]
  capabilities: ["read", "write", "webhook", "notify"]

Auth:
  → PluginAuthProvider
  isConfigured()       → checks TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN
  isAuthenticated()    → same as isConfigured

Client (src/twilio/call.ts):
  → PluginClient
  sendWhatsApp(), makeCall()
  Never-throws pattern

Webhooks (src/webhooks/twilio.ts):
  → PluginWebhookProvider
  HMAC-SHA1 signature verification (URL + sorted params)
  Processes incoming WhatsApp messages
  Returns TwiML responses
```

---

## 8. Design Principles

These principles are extracted from the existing codebase and must be preserved:

1. **Never throw from public methods.** Return `{ ok: boolean; data?: T; message: string }`.
   The caller should never need try-catch for plugin operations.

2. **No external SDKs.** Use raw `fetch()` with URL construction. Keeps dependencies minimal
   and control explicit.

3. **Idempotent lifecycle methods.** `start()` when already started is a no-op.
   `stop()` when already stopped is a no-op. Safe for retry and recovery.

4. **Activity logging for audit.** Every external operation logs via
   `logActivity({ source: pluginName, summary, detail? })`.

5. **Append-only data.** Any data persisted to `brain/` follows JSONL append-only rules.
   Use `status: "archived"` to deprecate — never delete.

6. **Graceful degradation.** If a plugin's auth fails or service is down, the system
   continues without it. No integration is required for the core brain to function.

7. **Vault-only secrets.** Credentials live in the encrypted vault, exposed as `process.env.*`
   after `loadVault()`. Never hardcode secrets or store them in settings.json.

8. **Keyword-triggered context.** Context injection is lazy — only fetch external data
   when the user's message signals relevance. Avoids unnecessary API calls.

---

## 9. Future Considerations

### 9.1 Plugin Hot-Reload
Currently all plugins are registered at server startup. A future enhancement could
support dynamic loading/unloading without server restart.

### 9.2 Plugin Marketplace
As the plugin count grows, a manifest registry (`brain/plugins.json`) could track
enabled/disabled state and per-plugin settings.

### 9.3 Inter-Plugin Communication
Some integrations already interact (Linear sync writes to QueueStore, which is used by
board context injection). A formal event bus between plugins could make this explicit.

### 9.4 Plugin Testing Harness
A `PluginTestContext` with in-memory vault, mock activity log, and mock notification
channel would simplify plugin development.
