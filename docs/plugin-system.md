# Plugin System Developer Guide

How to build integrations for Dash using the plugin interface.

For the full type-level specification, see [specs/plugin-system.md](specs/plugin-system.md).

---

## Implementation Status

| File | Purpose | Status |
|------|---------|--------|
| `src/types/plugin.ts` | All plugin interfaces and types | Implemented |
| `src/lib/BasePlugin.ts` | Abstract base class with lifecycle management | Implemented |
| `src/lib/PluginRegistry.ts` | Concrete registry with init/auth/start/stop orchestration | Implemented |
| `src/plugins/google-tasks/index.ts` | Proof-of-concept plugin wrapping existing Google Tasks facade | Implemented |
| Existing facades (`src/integrations/`) | Original integration code — still in use, not yet refactored | Stable |

The plugin system is **additive** — new integrations should use the plugin pattern, while existing facades continue to work unchanged. Migration of existing integrations is optional and incremental.

---

## Architecture Overview

Every Dash plugin follows the same four-layer pattern, extracted from the existing Google, Slack, Linear, and Twilio integrations:

```
┌────────────────────────────────┐
│  1. Auth Provider              │  isConfigured() / isAuthenticated()
│     OAuth flow or API key      │  getAuthUrl() / exchangeCode()
├────────────────────────────────┤
│  2. Client Wrapper             │  Never-throw API calls
│     Raw fetch(), no SDKs       │  Returns { ok, data?, message }
├────────────────────────────────┤
│  3. Ingress (timers/webhooks)  │  Polling timers or webhook handlers
│     Background data collection │  Signature verification
├────────────────────────────────┤
│  4. Context Injection          │  Keyword-triggered LLM context
│     Feed data into agent turns │  Priority-sorted insertion
└────────────────────────────────┘
```

## Plugin Lifecycle

```
loaded  ──init()──▶  ready  ──authenticate()──▶  authed  ──start()──▶  active
                                                                         │
                                                              stop()     │
                                                                         ▼
                                                                      stopped
```

- **loaded** — Module imported, manifest available.
- **ready** — `init()` completed. Config validated.
- **authed** — `authenticate()` succeeded. Client operational.
- **active** — `start()` completed. Timers/webhooks running.
- **stopped** — `stop()` completed. Resources released.

Any state can transition to **error** on unrecoverable failure.

## Quick Start

### 1. Create the plugin directory

```
src/plugins/github/
├── index.ts          # Plugin class (extends BasePlugin)
├── auth.ts           # PluginAuthProvider implementation
├── client.ts         # PluginClient implementation
├── webhooks.ts       # (optional) PluginWebhookProvider
└── context.ts        # (optional) PluginContextProvider
```

### 2. Define the manifest

```typescript
// src/plugins/github/index.ts
import { BasePlugin } from "../../lib/BasePlugin.js";
import type { PluginManifest } from "../../types/plugin.js";

const manifest: PluginManifest = {
  name: "github",
  version: "0.1.0",
  description: "GitHub issues, PRs, and notifications",
  authType: "oauth2",
  requiredConfig: ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"],
  optionalConfig: ["GITHUB_ACCESS_TOKEN"],
  scopes: ["repo", "notifications"],
  contextKeywords: /\b(github|pr|pull request|issue|repo)\b/i,
  capabilities: ["read", "write", "webhook", "context", "oauth"],
};
```

### 3. Implement the auth provider

```typescript
// src/plugins/github/auth.ts
import type { PluginAuthProvider, PluginResult, AuthResult } from "../../types/plugin.js";

export class GitHubAuth implements PluginAuthProvider {
  isConfigured(): boolean {
    return !!process.env.GITHUB_CLIENT_ID
        && !!process.env.GITHUB_CLIENT_SECRET;
  }

  isAuthenticated(): boolean {
    return this.isConfigured() && !!process.env.GITHUB_ACCESS_TOKEN;
  }

  getAuthUrl(redirectUri: string): PluginResult<string> {
    if (!this.isConfigured()) {
      return { ok: false, message: "Missing GITHUB_CLIENT_ID or GITHUB_CLIENT_SECRET" };
    }
    const params = new URLSearchParams({
      client_id: process.env.GITHUB_CLIENT_ID!,
      redirect_uri: redirectUri,
      scope: "repo notifications",
    });
    return {
      ok: true,
      data: `https://github.com/login/oauth/authorize?${params}`,
      message: "Auth URL generated",
    };
  }

  async exchangeCode(code: string, redirectUri: string): Promise<AuthResult> {
    const res = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: process.env.GITHUB_CLIENT_ID,
        client_secret: process.env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: redirectUri,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = await res.json() as { access_token?: string; error?: string };
    if (!data.access_token) {
      return { ok: false, message: data.error ?? "No access token returned" };
    }
    return {
      ok: true,
      message: "Authenticated",
      credentials: { GITHUB_ACCESS_TOKEN: data.access_token },
    };
  }

  clearCredentials(): void {
    // Token will be refreshed on next auth attempt
  }
}
```

### 4. Implement the client

```typescript
// src/plugins/github/client.ts
import type { PluginClient, PluginClientHealth, PluginResult } from "../../types/plugin.js";

export class GitHubClient implements PluginClient {
  readonly pluginName = "github";
  private lastError: string | null = null;
  private lastErrorAt: string | null = null;

  isAvailable(): boolean {
    return !!process.env.GITHUB_ACCESS_TOKEN;
  }

  getHealth(): PluginClientHealth {
    return {
      available: this.isAvailable(),
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt,
    };
  }

  async listPRs(repo: string): Promise<PluginResult<unknown[]>> {
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}/pulls`, {
        headers: {
          Authorization: `Bearer ${process.env.GITHUB_ACCESS_TOKEN}`,
          Accept: "application/vnd.github+json",
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const body = await res.text();
        this.lastError = `HTTP ${res.status}: ${body}`;
        this.lastErrorAt = new Date().toISOString();
        return { ok: false, message: this.lastError };
      }
      this.lastError = null;
      return { ok: true, data: await res.json(), message: "OK" };
    } catch (err: any) {
      this.lastError = err.message;
      this.lastErrorAt = new Date().toISOString();
      return { ok: false, message: err.message };
    }
  }
}
```

### 5. Wire it all up with BasePlugin

```typescript
// src/plugins/github/index.ts
import { BasePlugin } from "../../lib/BasePlugin.js";
import type { PluginManifest, PluginContext, AuthResult } from "../../types/plugin.js";
import { GitHubAuth } from "./auth.js";
import { GitHubClient } from "./client.js";

export class GitHubPlugin extends BasePlugin {
  readonly manifest: PluginManifest = {
    name: "github",
    version: "0.1.0",
    description: "GitHub issues, PRs, and notifications",
    authType: "oauth2",
    requiredConfig: ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"],
    optionalConfig: ["GITHUB_ACCESS_TOKEN"],
    scopes: ["repo", "notifications"],
    contextKeywords: /\b(github|pr|pull request|issue|repo)\b/i,
    capabilities: ["read", "write", "webhook", "context", "oauth"],
  };

  readonly auth = new GitHubAuth();
  readonly client = new GitHubClient();

  protected override async onAuthenticate(ctx: PluginContext): Promise<AuthResult> {
    if (this.auth.isAuthenticated()) {
      return { ok: true, message: "Token present" };
    }
    return { ok: false, message: "Run OAuth flow to authenticate" };
  }
}
```

### 6. Register with the server

```typescript
// In src/server.ts startup:
import { GitHubPlugin } from "./plugins/github/index.js";

const registry = new PluginRegistry();
await registry.register(new GitHubPlugin(), pluginCtx);
await registry.authenticateAll(pluginCtx);
await registry.startAll(pluginCtx);
```

## Design Rules

These rules are enforced by convention across all existing integrations:

### Never throw from public methods

Return `{ ok: boolean; data?: T; message: string }` from every client method. Callers should never need try-catch.

```typescript
// Good
async getUser(id: string): Promise<PluginResult<User>> {
  try {
    const res = await fetch(...);
    if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
    return { ok: true, data: await res.json(), message: "OK" };
  } catch (err: any) {
    return { ok: false, message: err.message };
  }
}

// Bad — forces callers to try-catch
async getUser(id: string): Promise<User> {
  const res = await fetch(...);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
```

### No external SDKs

Use raw `fetch()` for API calls. This keeps dependencies minimal, control explicit, and bundle size small. The Linear integration is the one exception (uses `@linear/sdk` because their GraphQL schema is complex).

### Idempotent lifecycle

`start()` when already started is a no-op. `stop()` when already stopped is a no-op. This makes retry and recovery safe.

### Vault-only secrets

All credentials go in the encrypted vault (`src/vault/store.ts`), exposed as `process.env.*` after `loadVault()`. Never hardcode secrets or store them in `settings.json`.

### Keyword-triggered context

Only fetch external data when the user's message signals relevance. Avoids unnecessary API calls on every turn.

## Auth Patterns

### OAuth 2.0 (Google, Slack)

1. Plugin declares `authType: "oauth2"` and lists scopes.
2. Server mounts `/api/{name}/auth` and `/api/{name}/callback` routes.
3. `getAuthUrl()` builds the consent URL.
4. `exchangeCode()` trades the authorization code for tokens.
5. Tokens are stored in vault via `ctx.setVaultKey()`.
6. Access tokens are cached in memory with auto-refresh (60s expiry buffer).

### API Key (Linear)

1. Plugin declares `authType: "api_key"`.
2. `isConfigured()` checks the vault key exists.
3. `isAuthenticated()` is the same as `isConfigured()` (no refresh flow).
4. Auth validation makes a lightweight API call (e.g., `viewer` query) and caches the result for 5 minutes.

### Token (Twilio)

1. Plugin declares `authType: "token"`.
2. Account SID + auth token from vault.
3. Used for HMAC signature verification on incoming webhooks.

## Error Handling & Retry

All plugins classify errors into three kinds:

| Kind | Retry? | Examples |
|------|--------|----------|
| `transient` | Yes (backoff) | Network errors, 429, 5xx |
| `permanent` | No | Bad request, validation errors |
| `auth` | No (prompt re-auth) | 401, 403, revoked tokens |

Retry formula: `delay = min(baseDelay × 2^(attempt-1), maxDelay) × jitter`

Default: 3 attempts, 1s base, 30s max, jitter in [0.5, 1.0).

See `src/slack/retry.ts` and `src/linear/retry.ts` for reference implementations.

## Context Injection

Plugins that inject context into the LLM implement `PluginContextProvider`:

```typescript
readonly context: PluginContextProvider = {
  contextKeywords: /\b(github|pr|pull request)\b/i,

  async getContext(userMessage: string): Promise<ContextInjection | null> {
    const prs = await this.client.listPRs("owner/repo");
    if (!prs.ok || !prs.data?.length) return null;

    return {
      label: "Open Pull Requests",
      content: prs.data.map(pr => `- #${pr.number}: ${pr.title}`).join("\n"),
      priority: 40, // lower = inserted earlier
    };
  },
};
```

Context is injected as a system message at position 1 (after system prompt, before history), wrapped in delimiters:

```
--- Open Pull Requests ---
- #42: Fix auth flow
- #43: Add dark mode
--- End Open Pull Requests ---
```

## Polling Timers

For plugins that poll external services:

```typescript
readonly timer: PluginTimerProvider = {
  private handle: ReturnType<typeof setInterval> | null = null;
  private seenIds = new Set<string>();

  startTimer(intervalMs = 300_000) {
    if (this.handle) return; // idempotent
    this.handle = setInterval(() => this.poll(), intervalMs);
  },

  stopTimer() {
    if (this.handle) clearInterval(this.handle);
    this.handle = null;
  },

  isTimerRunning() {
    return this.handle !== null;
  },
};
```

Timer rules:
- **Idempotent start/stop** — safe to call multiple times.
- **Deduplication** — track seen IDs in a Set, prune to prevent unbounded growth.
- **Never throws** — log errors via `logActivity()`, continue polling.
- **Dynamic backoff** — on consecutive failures, increase interval; reset on success.

## Webhooks

For plugins receiving external events, implement `PluginWebhookProvider`:

```typescript
readonly webhooks: PluginWebhookProvider = {
  getWebhookProviders() {
    return [{
      name: "github",
      verify(ctx) {
        // HMAC-SHA256 verification
        const expected = hmacSha256Hex(ctx.secret, ctx.rawBody);
        return timingSafeCompare(`sha256=${expected}`, ctx.signature);
      },
      async process(payload) {
        const event = payload as { action: string; /* ... */ };
        // Handle the event...
        return { handled: true, message: `Processed ${event.action}` };
      },
    }];
  },

  getRoutes() {
    return [{
      method: "POST" as const,
      path: "/api/github/webhooks",
      handler: async (req) => {
        // Route handling logic
        return { status: 200, body: { ok: true } };
      },
    }];
  },
};
```

Use the pre-built verification helpers from `src/webhooks/verify.ts`:
- `hmacSha256Hex()` — Linear-style
- `hmacSha256Base64()` — GitHub-style
- `timingSafeCompare()` — constant-time string comparison

## Existing Plugin Mapping

| Integration | Auth | Ingress | Context Keywords |
|-------------|------|---------|------------------|
| Google | OAuth2 (refresh token) | 3 polling timers (calendar, gmail, tasks) | calendar, meeting, email, task, todo |
| Slack | OAuth2 (bot token) | 3 webhook providers (events, commands, interactions) | — |
| Linear | API key | Webhook + polling timer | issue, board, backlog, sprint |
| Twilio | Auth token | Webhook (incoming messages) | — |

## Type Reference

All plugin types are defined in `src/types/plugin.ts`:

- `Plugin` — Complete plugin interface (extends `PluginLifecycle`)
- `PluginManifest` — Static metadata
- `PluginAuthProvider` — Credential management
- `PluginClient` — API client base
- `PluginContextProvider` — LLM context injection
- `PluginTimerProvider` — Polling timer
- `PluginWebhookProvider` — Webhook event handling
- `PluginContext` — Runtime environment passed to lifecycle methods
- `PluginResult<T>` — Standard `{ ok, data?, message }` return type
- `PluginState` / `PluginStatus` — Runtime state tracking
- `PluginRegistry` — Plugin manager interface (`src/lib/PluginRegistry.ts` for implementation)
- `BasePlugin` — Abstract base class (`src/lib/BasePlugin.ts`)

## Proof of Concept: Google Tasks Plugin

`src/plugins/google-tasks/index.ts` demonstrates how an existing integration maps to the plugin pattern. It wraps `src/google/auth.ts`, `src/google/tasks.ts`, and `src/google/tasks-timer.ts` into four composable pieces:

| Plugin Piece | Wraps | Methods |
|-------------|-------|---------|
| `GoogleTasksAuth` | `src/google/auth.ts` | `isConfigured()`, `isAuthenticated()`, `getAuthUrl()`, `exchangeCode()`, `clearCredentials()` |
| `GoogleTasksClient` | `src/google/tasks.ts` | `isAvailable()`, `getHealth()` |
| `GoogleTasksTimer` | `src/google/tasks-timer.ts` | `startTimer()`, `stopTimer()`, `isTimerRunning()` |
| `GoogleTasksContext` | `listTasks()` + `formatTasksForContext()` | `getContext()` triggered by `/task|todo|reminder|due/i` |

### Using with the registry

```typescript
import { PluginRegistry } from "./lib/PluginRegistry.js";
import { GoogleTasksPlugin } from "./plugins/google-tasks/index.js";

const registry = new PluginRegistry();

// 1. Register (calls init → validates config)
await registry.register(new GoogleTasksPlugin(), pluginCtx);

// 2. Authenticate (checks OAuth tokens)
await registry.authenticateAll(pluginCtx);

// 3. Start (begins polling timer)
await registry.startAll(pluginCtx);

// 4. Use in chat loop
for (const { name, provider } of registry.getContextProviders()) {
  if (provider.contextKeywords.test(userMessage)) {
    const injection = await provider.getContext(userMessage);
    if (injection) { /* inject into LLM messages */ }
  }
}

// 5. Shutdown
await registry.stopAll();
```

## Migration Guide

To migrate an existing integration to the plugin pattern:

1. **Create** `src/plugins/<name>/index.ts` with a class extending `BasePlugin`
2. **Wrap** existing auth functions into a `PluginAuthProvider`
3. **Wrap** existing client into a `PluginClient` (just `isAvailable()` + `getHealth()`)
4. **Wrap** existing timer functions into a `PluginTimerProvider` (if applicable)
5. **Wrap** existing context/summary functions into a `PluginContextProvider` (if applicable)
6. **Test** by registering with `PluginRegistry` alongside the existing facade
7. **Migrate** server.ts callers incrementally — both patterns can coexist

The plugin wrapper delegates to the same underlying modules, so there is no duplication of logic. The existing facades (`src/integrations/*.ts`) remain functional and can be removed only after all callers have migrated.
