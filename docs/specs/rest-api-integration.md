# REST API Gateway × Auth Framework Integration Plan

> Status: **Draft**
> Created: 2026-02-27
> Scope: Consolidate Core's REST API gateway layer with its Authentication & Authorization framework into a unified, maintainable middleware pipeline.

---

## 1. Current State Analysis

### 1.1 Authentication Framework (`src/auth/`)

| Component | File | Role |
|-----------|------|------|
| Identity & Pairing | `src/auth/identity.ts` | 6-word pairing ceremony, safe-word auth, recovery flow |
| Crypto primitives | `src/auth/crypto.ts` | AES-256-GCM encryption, PBKDF2 key derivation (600k iterations), SHA-256 hashing |
| Vault | `src/vault/store.ts` | Encrypted API key storage, decrypted on auth and injected into `process.env` |
| Session management | In-memory maps in `src/server.ts` | `sessionKeys: Map<id, Buffer>`, `sessions: Map<id, Session>`, 24h TTL |

**Auth flow:** User pairs once (safe word + recovery Q/A) → on return visits, provides safe word → server derives session ID deterministically from safe word hash → PBKDF2 derives 256-bit session key → vault decrypted → session cached in memory and on disk at `brain/identity/.session-key`.

### 1.2 REST API Gateway (`src/server.ts`)

- **Framework:** Hono on Node.js, port 3577 (configurable via `DASH_PORT`)
- **Endpoints:** 50+ routes across auth, vault, chat, board, agents, Google OAuth, voice, health, ops
- **Rate limiting:** `src/rate-limit.ts` — per-IP, in-memory store, configurable window/max per route group
- **Health:** `src/health/` — Kubernetes-compatible probes (`/healthz`, `/readyz`, `/startupz`) + detailed `/api/health`
- **Session validation:** Repeated inline in every authenticated route handler (79+ occurrences of the same pattern)

### 1.3 Pain Points

1. **No auth middleware.** Every authenticated route manually extracts `sessionId` from query params and calls `validateSession()`. ~79 duplicated blocks.
2. **No route-level authorization.** All authenticated routes have identical access — there's no concept of scopes, roles, or permission levels.
3. **Session ID in query params only.** Works for SSE/downloads but precludes header-based auth for programmatic clients.
4. **Rate limits are coarse.** Only two tiers: auth endpoints (5–10/15min) and everything else (120/min). No per-session or per-endpoint granularity.
5. **No request/response lifecycle hooks.** Logging, tracing, and error formatting are ad-hoc per route.
6. **Ops dashboard is unprotected.** `/ops`, `/traces`, health endpoints have no auth — assumes localhost-only access but server binds `0.0.0.0`.

---

## 2. Integration Architecture

### 2.1 Design Principles

1. **Extract, don't rewrite.** Pull inline auth patterns into middleware; don't redesign the pairing/crypto layer.
2. **Layered middleware pipeline.** Each concern (logging, rate limit, auth, authz) is a distinct Hono middleware.
3. **Backward compatible.** Existing `?sessionId=` query param continues to work. Header-based auth is additive.
4. **Progressive security.** Public → rate-limited → authenticated → authorized — each layer adds protection.
5. **File-based config.** Authorization rules stored in `brain/settings.json` alongside other config.

### 2.2 Middleware Pipeline (ordered)

```
Request
  │
  ├─ 1. Request Logger          — method, path, IP, timing
  ├─ 2. Request ID              — X-Request-Id header (for tracing)
  ├─ 3. CORS                    — origin whitelist (localhost + configured origins)
  ├─ 4. Rate Limiter            — per-IP + per-session (tiered by route group)
  ├─ 5. Auth Resolver            — extract session from query OR header, attach to context
  ├─ 6. Route Guard              — per-route auth requirement enforcement
  ├─ 7. Error Boundary           — catch-all, normalize error responses
  │
  └─ Route Handler
```

---

## 3. Implementation Spec

### 3.1 Auth Resolver Middleware

**New file:** `src/auth/middleware.ts`

**Responsibility:** Extract and validate session credentials from the request. Attach result to Hono context. Does NOT reject requests — that's the route guard's job.

```typescript
// Pseudocode — actual implementation in Pass 2

interface AuthContext {
  sessionId: string | null;
  session: Session | null;
  sessionKey: Buffer | null;
}

function authResolver(): MiddlewareHandler {
  return async (c, next) => {
    // 1. Try Authorization header first: "Bearer <sessionId>"
    const authHeader = c.req.header("Authorization");
    let sessionId = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;

    // 2. Fall back to query param (backward compat)
    if (!sessionId) {
      sessionId = c.req.query("sessionId") ?? null;
    }

    // 3. Validate if present
    const session = sessionId ? validateSession(sessionId) : null;
    const sessionKey = sessionId ? sessionKeys.get(sessionId) ?? null : null;

    // 4. Attach to context (available to all downstream handlers)
    c.set("auth", { sessionId, session, sessionKey });

    await next();
  };
}
```

**Key decisions:**
- Header takes precedence over query param (prevents confusion if both sent).
- `Bearer <sessionId>` format — standard, works with HTTP clients and Postman.
- No rejection here — unauthenticated requests pass through (public routes need this).

### 3.2 Route Guard Middleware

**Same file:** `src/auth/middleware.ts`

**Responsibility:** Enforce authentication requirements on protected routes. Rejects unauthenticated requests with 401.

```typescript
type AuthLevel = "public" | "authenticated" | "operator";

function requireAuth(level: AuthLevel = "authenticated"): MiddlewareHandler {
  return async (c, next) => {
    if (level === "public") return next();

    const auth: AuthContext = c.get("auth");

    if (!auth.session) {
      return c.json({ error: "Authentication required" }, 401);
    }

    // "operator" level: future expansion for admin-only routes
    // For now, all authenticated sessions have equal access

    await next();
  };
}
```

### 3.3 Route Classification

All existing routes classified into protection levels:

| Level | Routes | Auth | Rate Limit |
|-------|--------|------|------------|
| **Public** | `GET /`, `GET /healthz`, `GET /readyz`, `GET /startupz`, `GET /api/status` | None | 120/min |
| **Auth** | `POST /api/pair`, `POST /api/auth`, `GET /api/recover`, `POST /api/recover` | None (these create sessions) | 10/15min |
| **Protected** | `GET /api/vault`, `PUT /api/vault/:name`, `DELETE /api/vault/:name` | Session required | 60/min |
| **Protected** | `POST /api/chat`, `GET /api/history`, `GET /api/activity` | Session required | 120/min |
| **Protected** | `GET/POST/PATCH /api/board/*` (except status) | Session required | 120/min |
| **Protected** | `GET/PUT /api/settings`, `GET/PUT /api/prompt` | Session required | 30/min |
| **Protected** | `POST /api/google/send-email`, `POST /api/agents/tasks` | Session required | 30/min |
| **Protected** | `/api/agents/*`, `/api/runtime/*` | Session required | 60/min |
| **Protected** | Voice endpoints (`/api/tts`, `/api/stt`, `/api/avatar/*`) | Session required | 60/min |
| **Operator** | `GET /ops`, `/api/ops/*`, `/traces*` | Localhost OR session | 60/min |
| **Semi-public** | `GET /api/board/status`, `GET /api/board/sync/health`, `GET /api/health` | None (diagnostic) | 30/min |
| **OAuth callback** | `GET /api/google/callback` | None (redirect target) | 10/15min |

### 3.4 Tiered Rate Limiting

**Enhancement to `src/rate-limit.ts`:**

Add per-session rate limiting in addition to per-IP. Authenticated users get their own bucket, preventing one user from exhausting the IP pool in shared-network scenarios.

```typescript
interface TieredRateLimitConfig {
  ip: { windowMs: number; max: number };       // per-IP (unauthenticated)
  session?: { windowMs: number; max: number };  // per-session (authenticated)
}
```

Rate limit key strategy:
- Unauthenticated: IP address (current behavior)
- Authenticated: `session:<sessionId>` (new)

### 3.5 Operator Access for Ops Routes

Currently `/ops`, `/traces`, and `/api/ops/*` are completely unprotected. Since the server binds `0.0.0.0`, this is a security gap.

**Solution:** Operator-level middleware that allows access if:
1. Request comes from loopback (`127.0.0.1`, `::1`), OR
2. Request carries a valid session

```typescript
function operatorGuard(): MiddlewareHandler {
  return async (c, next) => {
    const ip = c.req.header("x-forwarded-for") || c.env?.remoteAddress;
    const isLocal = ip === "127.0.0.1" || ip === "::1" || ip === "localhost";

    if (isLocal) return next();

    const auth: AuthContext = c.get("auth");
    if (auth.session) return next();

    return c.json({ error: "Operator access required" }, 403);
  };
}
```

### 3.6 Request ID & Tracing Integration

**New middleware** linking HTTP requests to the existing tracing system (`src/tracing/tracer.ts`):

```typescript
function requestId(): MiddlewareHandler {
  return async (c, next) => {
    const id = c.req.header("X-Request-Id") || crypto.randomUUID();
    c.set("requestId", id);
    c.header("X-Request-Id", id);
    await next();
  };
}
```

Traces logged by `src/tracing/tracer.ts` should include the request ID for correlation.

### 3.7 Unified Error Boundary

Catch unhandled errors at the top of the middleware stack. Normalize into consistent response format.

```typescript
function errorBoundary(): MiddlewareHandler {
  return async (c, next) => {
    try {
      await next();
    } catch (err) {
      const requestId = c.get("requestId");
      console.error(`[${requestId}] Unhandled error:`, err);

      const status = err instanceof HTTPException ? err.status : 500;
      return c.json({
        error: status === 500 ? "Internal server error" : err.message,
        requestId,
      }, status);
    }
  };
}
```

---

## 4. Server Integration

### 4.1 Middleware Registration in `src/server.ts`

Replace the current ad-hoc pattern with a clean pipeline at the top of the app setup:

```typescript
// Global middleware (all routes)
app.use("*", requestId());
app.use("*", errorBoundary());
app.use("*", authResolver());

// Rate limits by route group
app.use("/api/pair", rateLimit({ windowMs: 15 * 60_000, max: 10 }));
app.use("/api/auth", rateLimit({ windowMs: 15 * 60_000, max: 10 }));
app.use("/api/recover", rateLimit({ windowMs: 15 * 60_000, max: 5 }));
app.use("/api/*", rateLimit({ windowMs: 60_000, max: 120 }));

// Auth guards by route group
app.use("/api/vault/*", requireAuth("authenticated"));
app.use("/api/chat", requireAuth("authenticated"));
app.use("/api/history", requireAuth("authenticated"));
app.use("/api/board/teams", requireAuth("authenticated"));
app.use("/api/board/issues*", requireAuth("authenticated"));
app.use("/api/settings", requireAuth("authenticated"));
app.use("/api/prompt", requireAuth("authenticated"));
app.use("/api/agents/*", requireAuth("authenticated"));
app.use("/api/runtime/*", requireAuth("authenticated"));
app.use("/api/google/send-email", requireAuth("authenticated"));
app.use("/api/tts", requireAuth("authenticated"));
app.use("/api/stt", requireAuth("authenticated"));
app.use("/api/avatar/*", requireAuth("authenticated"));
app.use("/ops*", operatorGuard());
app.use("/traces*", operatorGuard());
app.use("/api/ops/*", operatorGuard());
```

### 4.2 Route Handler Cleanup

After middleware handles auth, route handlers access the pre-validated session from context instead of inline validation:

**Before (current, repeated 79× times):**
```typescript
app.get("/api/vault", async (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);
  const session = validateSession(sessionId);
  if (!session) return c.json({ error: "Invalid or expired session" }, 401);
  // ... handler logic
});
```

**After (with middleware):**
```typescript
app.get("/api/vault", async (c) => {
  const { session, sessionKey } = c.get("auth");
  // session is guaranteed non-null — guard middleware already rejected 401
  // ... handler logic
});
```

This removes ~79 duplicated auth blocks, reducing `server.ts` by approximately 240 lines.

---

## 5. Auth Header Support

### 5.1 Dual-Mode Session Passing

The auth resolver accepts session ID from two sources:

| Method | Format | Use Case |
|--------|--------|----------|
| Query param | `?sessionId=abc123` | Browser SSE, file downloads, simple GETs |
| Auth header | `Authorization: Bearer abc123` | Programmatic clients, fetch API, cURL |

Both are equivalent. Header takes precedence if both are present.

### 5.2 Client Migration

No breaking changes. Existing frontend code using `?sessionId=` continues to work. New integrations can use headers. The `/api/auth` response should document both methods:

```json
{
  "sessionId": "abc123def...",
  "name": "User",
  "hint": "Pass sessionId as query param (?sessionId=...) or Authorization: Bearer header"
}
```

---

## 6. Security Hardening

### 6.1 Session Key Isolation

Currently `sessionKeys` (encryption keys) and `sessions` (session metadata) live in separate top-level Maps in `server.ts`. These should be encapsulated:

**New file:** `src/auth/session-store.ts`

```typescript
class SessionStore {
  private sessions: Map<string, Session>;
  private keys: Map<string, Buffer>;

  validate(sessionId: string): Session | null { ... }
  getKey(sessionId: string): Buffer | null { ... }
  register(sessionId: string, session: Session, key: Buffer): void { ... }
  revoke(sessionId: string): void { ... }  // for logout / recovery
}
```

Benefits:
- Single source of truth for session state
- Revocation support (needed for recovery flow — currently sessions linger after password reset)
- TTL enforcement in one place
- Testable in isolation

### 6.2 Sensitive Header Stripping

Strip `Authorization` header from logged request data. The request logger middleware must sanitize before writing to traces.

### 6.3 CORS Policy

Add explicit CORS middleware. Currently absent — browser requests from any origin are accepted.

```typescript
app.use("*", cors({
  origin: ["http://localhost:3577", "http://127.0.0.1:3577"],
  allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  allowHeaders: ["Authorization", "Content-Type"],
  credentials: true,
}));
```

Additional origins configurable via `brain/settings.json`:

```json
{
  "cors": {
    "allowedOrigins": ["https://dash.example.com"]
  }
}
```

### 6.4 Rate Limit Bypass Prevention

Current rate limiting keys on IP only. Behind a reverse proxy, all traffic appears from the proxy IP. Add `X-Forwarded-For` trust configuration:

```json
{
  "server": {
    "trustProxy": false
  }
}
```

When `trustProxy` is `true`, rate limiter uses `X-Forwarded-For` header. Default `false` for security.

---

## 7. Health Check Integration

### 7.1 Auth-Aware Health Checks

Register a new health check for the auth subsystem:

```typescript
health.register("auth", async () => {
  const paired = await isPaired();
  const activeSessions = sessionStore.activeCount();

  return {
    status: paired ? "pass" : "warn",
    output: paired
      ? `Paired, ${activeSessions} active session(s)`
      : "Not yet paired — awaiting pairing ceremony",
  };
}, { critical: false });
```

This surfaces auth health in `/api/health` and `/readyz` without making it a hard dependency (unpaired state is valid during initial setup).

### 7.2 Rate Limit Monitoring

Expose rate limit stats in `/api/ops/health`:

```json
{
  "rateLimiting": {
    "activeWindows": 12,
    "nearLimitClients": 2,
    "blockedInLastHour": 0
  }
}
```

---

## 8. Implementation Roadmap

### Phase 1: Auth Middleware Extraction (low risk)

| Step | File | Change |
|------|------|--------|
| 1a | Create `src/auth/middleware.ts` | `authResolver()`, `requireAuth()`, `operatorGuard()` |
| 1b | Create `src/auth/session-store.ts` | `SessionStore` class encapsulating Maps |
| 1c | Update `src/server.ts` | Register middleware, remove inline auth blocks from each route |
| 1d | Test | Verify all routes return same responses as before via manual testing |

**Risk:** Low. Functionally equivalent — same validation logic, just extracted.
**Estimated LOC change:** +150 (new files), -240 (removed duplication) = net -90.

### Phase 2: Header Auth + CORS (low risk)

| Step | File | Change |
|------|------|--------|
| 2a | Update `src/auth/middleware.ts` | Add `Authorization: Bearer` support to `authResolver()` |
| 2b | Add CORS middleware | `cors()` with configurable origin list |
| 2c | Update `brain/settings.json` schema | Add `cors.allowedOrigins` and `server.trustProxy` |
| 2d | Update `POST /api/auth` response | Include auth method hint in response body |

**Risk:** Low. Additive — no existing behavior changes.

### Phase 3: Operator Guard + Ops Security (medium risk)

| Step | File | Change |
|------|------|--------|
| 3a | Apply `operatorGuard()` to `/ops*`, `/traces*`, `/api/ops/*` | |
| 3b | Test remote access is blocked | Verify 403 from non-loopback without session |

**Risk:** Medium. Could lock out legitimate remote ops access if reverse proxy setup isn't considered. Mitigate with clear docs and `trustProxy` setting.

### Phase 4: Tiered Rate Limiting (low risk)

| Step | File | Change |
|------|------|--------|
| 4a | Update `src/rate-limit.ts` | Add per-session bucket support |
| 4b | Update rate limit registration in `server.ts` | Apply per-endpoint granularity per the table in §3.3 |
| 4c | Add rate limit stats to ops health | Expose in `/api/ops/health` |

**Risk:** Low. More granular limits — strictly tighter, never looser.

### Phase 5: Request Lifecycle (low risk)

| Step | File | Change |
|------|------|--------|
| 5a | Add `requestId()` middleware | Generate/propagate `X-Request-Id` |
| 5b | Add `errorBoundary()` middleware | Catch-all with consistent error shape |
| 5c | Integrate request ID with `src/tracing/tracer.ts` | Correlate HTTP requests to trace spans |
| 5d | Add auth health check | Register in `src/health/checks.ts` |

**Risk:** Low. Observability improvement, no behavior change.

---

## 9. Files Affected

| File | Action | Phase |
|------|--------|-------|
| `src/auth/middleware.ts` | **Create** | 1 |
| `src/auth/session-store.ts` | **Create** | 1 |
| `src/server.ts` | **Edit** — middleware registration, remove inline auth | 1–5 |
| `src/rate-limit.ts` | **Edit** — add session-based keying | 4 |
| `src/tracing/tracer.ts` | **Edit** — accept request ID | 5 |
| `src/health/checks.ts` | **Edit** — add auth health check | 5 |
| `brain/settings.json` | **Edit** — add `cors`, `server` sections | 2 |
| `src/types.ts` | **Edit** — add `AuthContext` type, extend Hono context | 1 |

---

## 10. What This Plan Does NOT Cover

- **Multi-user / role-based authorization.** Core is single-user by design. The `"operator"` level is a placeholder for future expansion, not a full RBAC system.
- **OAuth2 / JWT tokens.** The safe-word pairing model is intentional. External OAuth (Google) exists but is for service integration, not user authentication.
- **API versioning.** All routes remain unversioned (`/api/...`). Versioning can be added later if needed.
- **WebSocket auth.** Not currently used. If added (e.g., for real-time chat), the `authResolver` pattern would extend to WS upgrade headers.
- **Reverse proxy configuration.** Nginx/Caddy setup is a deployment concern, not an application concern. The `trustProxy` setting is the integration point.
