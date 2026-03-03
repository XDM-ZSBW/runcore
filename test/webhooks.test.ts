/**
 * Tests for the generic webhook system.
 *
 * Covers: types, verify, retry, router, registry, config, and handlers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Stub activity log before importing modules ──────────────────────────────

vi.mock("../src/activity/log.js", () => ({
  logActivity: vi.fn(),
}));

import {
  // Verify
  hmacSha256Hex,
  hmacSha256Base64,
  hmacSha1Base64,
  timingSafeCompare,
  isTimestampFresh,
  verifyHmacSha256Hex,
  verifyHmacSha256Base64,
  verifySlackV0,
  verifyTwilio,
  // Registry
  registerProvider,
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
  // Router
  routeWebhook,
  routeWebhookRequest,
  composeMiddleware,
  validateRequest,
  deduplicateRequests,
  rateLimitRequests,
  createWebhookEvent,
  createEventRouter,
  normalizeToEvent,
  // Retry
  withWebhookRetry,
  classifyError,
  createWebhookError,
  DeadLetterQueue,
  withRetryHandler,
  // Config
  getConfig,
  setConfig,
  getProviderConfig,
  setProviderConfig,
  removeProviderConfig,
  listConfiguredProviders,
  resolveSecret,
  getProviderSecret,
  getProviderRetryOpts,
  isProviderEnabled,
  validateProviderConfig,
  validateConfig,
  // Handlers
  safeHandler,
  registerHmacSha256HexProvider,
  registerSlackStyleProvider,
  registerTwilioStyleProvider,
  withLogging,
} from "../src/webhooks/index.js";

import type {
  WebhookProvider,
  WebhookResult,
  VerifyContext,
  WebhookRequestContext,
} from "../src/webhooks/index.js";

// ═══════════════════════════════════════════════════════════════════════════════
// verify.ts
// ═══════════════════════════════════════════════════════════════════════════════

describe("verify", () => {
  describe("hmacSha256Hex", () => {
    it("produces a deterministic hex digest", () => {
      const a = hmacSha256Hex("hello", "secret");
      const b = hmacSha256Hex("hello", "secret");
      expect(a).toBe(b);
      expect(a).toMatch(/^[0-9a-f]{64}$/);
    });

    it("changes with different data", () => {
      expect(hmacSha256Hex("a", "s")).not.toBe(hmacSha256Hex("b", "s"));
    });

    it("changes with different secret", () => {
      expect(hmacSha256Hex("a", "s1")).not.toBe(hmacSha256Hex("a", "s2"));
    });
  });

  describe("hmacSha256Base64", () => {
    it("produces base64 output", () => {
      const sig = hmacSha256Base64("data", "key");
      expect(sig).toMatch(/^[A-Za-z0-9+/]+=*$/);
    });
  });

  describe("hmacSha1Base64", () => {
    it("produces base64 output", () => {
      const sig = hmacSha1Base64("data", "key");
      expect(sig).toMatch(/^[A-Za-z0-9+/]+=*$/);
    });
  });

  describe("timingSafeCompare", () => {
    it("returns true for equal strings", () => {
      expect(timingSafeCompare("abc", "abc")).toBe(true);
    });

    it("returns false for different strings", () => {
      expect(timingSafeCompare("abc", "xyz")).toBe(false);
    });

    it("returns false for different lengths", () => {
      expect(timingSafeCompare("short", "a much longer string")).toBe(false);
    });
  });

  describe("isTimestampFresh", () => {
    it("returns true for current timestamp", () => {
      const now = Math.floor(Date.now() / 1000);
      expect(isTimestampFresh(now)).toBe(true);
    });

    it("returns false for old timestamp", () => {
      const old = Math.floor(Date.now() / 1000) - 600;
      expect(isTimestampFresh(old, 300)).toBe(false);
    });

    it("returns false for NaN", () => {
      expect(isTimestampFresh(NaN)).toBe(false);
    });
  });

  describe("verifyHmacSha256Hex", () => {
    it("verifies correct signature", () => {
      const body = '{"test":true}';
      const secret = "my-secret";
      const sig = hmacSha256Hex(body, secret);
      expect(
        verifyHmacSha256Hex({ rawBody: body, signature: sig, secret }),
      ).toBe(true);
    });

    it("rejects wrong signature", () => {
      expect(
        verifyHmacSha256Hex({
          rawBody: "body",
          signature: "wrong",
          secret: "secret",
        }),
      ).toBe(false);
    });
  });

  describe("verifyHmacSha256Base64", () => {
    it("verifies correct signature", () => {
      const body = "data";
      const secret = "key";
      const sig = hmacSha256Base64(body, secret);
      expect(
        verifyHmacSha256Base64({ rawBody: body, signature: sig, secret }),
      ).toBe(true);
    });

    it("strips sha256= prefix when requested", () => {
      const body = "data";
      const secret = "key";
      const sig = `sha256=${hmacSha256Base64(body, secret)}`;
      expect(
        verifyHmacSha256Base64(
          { rawBody: body, signature: sig, secret },
          true,
        ),
      ).toBe(true);
    });
  });

  describe("verifySlackV0", () => {
    it("verifies a valid Slack signature", () => {
      const body = '{"type":"url_verification"}';
      const secret = "slack-signing-secret";
      const timestamp = String(Math.floor(Date.now() / 1000));
      const baseString = `v0:${timestamp}:${body}`;
      const sig = `v0=${hmacSha256Hex(baseString, secret)}`;

      expect(
        verifySlackV0({
          rawBody: body,
          signature: sig,
          secret,
          headers: { timestamp },
        }),
      ).toBe(true);
    });

    it("rejects stale timestamp", () => {
      const body = "body";
      const secret = "secret";
      const staleTs = String(Math.floor(Date.now() / 1000) - 600);
      expect(
        verifySlackV0({
          rawBody: body,
          signature: "v0=abc",
          secret,
          headers: { timestamp: staleTs },
        }),
      ).toBe(false);
    });
  });

  describe("verifyTwilio", () => {
    it("verifies a valid Twilio signature", () => {
      const url = "https://example.com/api/twilio/whatsapp";
      const params: Record<string, string> = {
        Body: "Hello",
        From: "whatsapp:+1234567890",
        To: "whatsapp:+0987654321",
      };
      const secret = "twilio-auth-token";

      const sortedKeys = Object.keys(params).sort();
      let data = url;
      for (const key of sortedKeys) data += key + params[key];
      const sig = hmacSha1Base64(data, secret);

      expect(
        verifyTwilio({
          rawBody: "",
          signature: sig,
          secret,
          url,
          params,
        }),
      ).toBe(true);
    });

    it("returns false when url is missing", () => {
      expect(
        verifyTwilio({ rawBody: "", signature: "sig", secret: "s" }),
      ).toBe(false);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// registry.ts
// ═══════════════════════════════════════════════════════════════════════════════

describe("registry", () => {
  const testProvider: WebhookProvider = {
    name: "test-provider",
    verify: () => true,
    process: async () => ({ handled: true, message: "ok" }),
  };

  beforeEach(() => {
    // Clean slate for registry tests
    removeProvider("test-provider");
    removeProvider("test-a");
    removeProvider("test-b");
    resetProviderStats();
  });

  it("registers and retrieves a provider", () => {
    registerProvider(testProvider);
    expect(getProvider("test-provider")).toBe(testProvider);
  });

  it("lists registered providers", () => {
    registerProvider(testProvider);
    expect(listProviders()).toContain("test-provider");
  });

  it("removes a provider", () => {
    registerProvider(testProvider);
    expect(removeProvider("test-provider")).toBe(true);
    expect(getProvider("test-provider")).toBeUndefined();
  });

  it("returns false when removing non-existent provider", () => {
    expect(removeProvider("nonexistent")).toBe(false);
  });

  describe("stats", () => {
    it("tracks successes", () => {
      recordSuccess("test-a");
      recordSuccess("test-a");
      const stats = getProviderStats("test-a");
      expect(stats?.successes).toBe(2);
      expect(stats?.invocations).toBe(2);
      expect(stats?.failures).toBe(0);
    });

    it("tracks failures", () => {
      recordFailure("test-a", "oops");
      const stats = getProviderStats("test-a");
      expect(stats?.failures).toBe(1);
      expect(stats?.lastError).toBe("oops");
    });

    it("resets stats for one provider", () => {
      recordSuccess("test-a");
      recordSuccess("test-b");
      resetProviderStats("test-a");
      expect(getProviderStats("test-a")).toBeUndefined();
      expect(getProviderStats("test-b")).toBeDefined();
    });

    it("resets all stats", () => {
      recordSuccess("test-a");
      recordSuccess("test-b");
      resetProviderStats();
      expect(getAllProviderStats()).toEqual([]);
    });
  });

  describe("health", () => {
    it("returns unknown for no invocations", () => {
      registerProvider({ ...testProvider, name: "test-a" });
      const health = getProviderHealth("test-a");
      // No invocations recorded — stats don't exist yet
      expect(health).toBeUndefined();
    });

    it("returns healthy for low failure rate", () => {
      registerProvider({ ...testProvider, name: "test-a" });
      recordSuccess("test-a");
      recordSuccess("test-a");
      recordSuccess("test-a");
      recordFailure("test-a", "one fail");
      const health = getProviderHealth("test-a");
      expect(health?.health).toBe("healthy");
      expect(health?.failureRate).toBe(0.25);
    });

    it("returns degraded for high failure rate", () => {
      registerProvider({ ...testProvider, name: "test-a" });
      recordFailure("test-a", "err");
      recordFailure("test-a", "err");
      recordSuccess("test-a");
      const health = getProviderHealth("test-a");
      expect(health?.health).toBe("degraded");
    });

    it("getAllProviderHealth returns summaries for all registered", () => {
      registerProvider({ ...testProvider, name: "test-a" });
      registerProvider({ ...testProvider, name: "test-b" });
      const all = getAllProviderHealth();
      const names = all.map((h) => h.name);
      expect(names).toContain("test-a");
      expect(names).toContain("test-b");
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// router.ts
// ═══════════════════════════════════════════════════════════════════════════════

describe("router", () => {
  beforeEach(() => {
    removeProvider("route-test");
    resetProviderStats();
  });

  describe("routeWebhook", () => {
    it("returns error for unknown provider", async () => {
      const result = await routeWebhook("nonexistent", {});
      expect(result.handled).toBe(false);
      expect(result.message).toContain("Unknown");
    });

    it("routes to a registered provider", async () => {
      registerProvider({
        name: "route-test",
        verify: () => true,
        process: async () => ({ handled: true, message: "routed" }),
      });
      const result = await routeWebhook("route-test", { data: 1 });
      expect(result.handled).toBe(true);
      expect(result.message).toBe("routed");
    });

    it("rejects on failed signature verification", async () => {
      registerProvider({
        name: "route-test",
        verify: () => false,
        process: async () => ({ handled: true, message: "should not reach" }),
      });
      const result = await routeWebhook("route-test", {}, {
        rawBody: "body",
        signature: "bad",
        secret: "secret",
      });
      expect(result.handled).toBe(false);
      expect(result.message).toContain("Invalid");
    });

    it("catches thrown errors from process", async () => {
      registerProvider({
        name: "route-test",
        verify: () => true,
        process: async () => {
          throw new Error("boom");
        },
      });
      const result = await routeWebhook("route-test", {});
      expect(result.handled).toBe(false);
      expect(result.message).toContain("boom");
    });
  });

  describe("routeWebhookRequest", () => {
    it("routes a full request context", async () => {
      registerProvider({
        name: "route-test",
        verify: () => true,
        process: async (payload) => ({
          handled: true,
          message: `got ${(payload as any).x}`,
        }),
      });

      const ctx: WebhookRequestContext = {
        method: "POST",
        url: "https://example.com/hook",
        headers: {},
        body: '{"x":42}',
        parsed: { x: 42 },
        provider: "route-test",
      };

      const result = await routeWebhookRequest(ctx);
      expect(result.handled).toBe(true);
      expect(result.message).toBe("got 42");
    });

    it("applies middleware before processing", async () => {
      registerProvider({
        name: "route-test",
        verify: () => true,
        process: async () => ({ handled: true, message: "processed" }),
      });

      const log: string[] = [];
      const result = await routeWebhookRequest(
        {
          method: "POST",
          url: "https://example.com/hook",
          headers: {},
          body: "data",
          provider: "route-test",
        },
        {
          middleware: [
            async (ctx, next) => {
              log.push("before");
              const res = await next();
              log.push("after");
              return res;
            },
          ],
        },
      );

      expect(result.handled).toBe(true);
      expect(log).toEqual(["before", "after"]);
    });
  });

  describe("composeMiddleware", () => {
    it("chains middleware in order", async () => {
      const order: string[] = [];
      const mw1 = composeMiddleware(
        async (_ctx, next) => {
          order.push("a");
          return next();
        },
        async (_ctx, next) => {
          order.push("b");
          return next();
        },
      );

      const ctx: WebhookRequestContext = {
        method: "POST",
        url: "",
        headers: {},
        body: "x",
        provider: "test",
      };
      await mw1(ctx, async () => {
        order.push("final");
        return { handled: true, message: "done" };
      });

      expect(order).toEqual(["a", "b", "final"]);
    });
  });

  describe("validateRequest", () => {
    const ctx: WebhookRequestContext = {
      method: "POST",
      url: "",
      headers: { "content-type": "application/json" },
      body: "data",
      provider: "test",
    };

    it("passes valid requests", async () => {
      const mw = validateRequest();
      const result = await mw(ctx, async () => ({
        handled: true,
        message: "ok",
      }));
      expect(result.handled).toBe(true);
    });

    it("rejects wrong method", async () => {
      const mw = validateRequest({ allowedMethods: ["PUT"] });
      const result = await mw(ctx, async () => ({
        handled: true,
        message: "ok",
      }));
      expect(result.handled).toBe(false);
      expect(result.message).toContain("not allowed");
    });

    it("rejects empty body", async () => {
      const mw = validateRequest();
      const result = await mw({ ...ctx, body: "" }, async () => ({
        handled: true,
        message: "ok",
      }));
      expect(result.handled).toBe(false);
      expect(result.message).toContain("Empty");
    });

    it("rejects missing required headers", async () => {
      const mw = validateRequest({
        requiredHeaders: ["x-custom-header"],
      });
      const result = await mw(ctx, async () => ({
        handled: true,
        message: "ok",
      }));
      expect(result.handled).toBe(false);
      expect(result.message).toContain("Missing required header");
    });
  });

  describe("deduplicateRequests", () => {
    it("passes first request through", async () => {
      const mw = deduplicateRequests();
      const ctx: WebhookRequestContext = {
        method: "POST",
        url: "",
        headers: { "x-request-id": "abc-123" },
        body: "data",
        provider: "test",
      };

      const result = await mw(ctx, async () => ({
        handled: true,
        message: "first",
      }));
      expect(result.message).toBe("first");
    });

    it("rejects duplicate delivery ID", async () => {
      const mw = deduplicateRequests();
      const ctx: WebhookRequestContext = {
        method: "POST",
        url: "",
        headers: { "x-request-id": "dup-id" },
        body: "data",
        provider: "test",
      };

      await mw(ctx, async () => ({ handled: true, message: "first" }));
      const result = await mw(ctx, async () => ({
        handled: true,
        message: "second",
      }));
      expect(result.message).toContain("Duplicate");
    });

    it("passes through when no ID header", async () => {
      const mw = deduplicateRequests();
      const ctx: WebhookRequestContext = {
        method: "POST",
        url: "",
        headers: {},
        body: "data",
        provider: "test",
      };
      const result = await mw(ctx, async () => ({
        handled: true,
        message: "no-id",
      }));
      expect(result.message).toBe("no-id");
    });
  });

  describe("rateLimitRequests", () => {
    it("allows requests within limit", async () => {
      const mw = rateLimitRequests({ maxRequests: 5, windowMs: 60_000 });
      const ctx: WebhookRequestContext = {
        method: "POST",
        url: "",
        headers: {},
        body: "data",
        provider: "test",
      };

      for (let i = 0; i < 5; i++) {
        const result = await mw(ctx, async () => ({
          handled: true,
          message: "ok",
        }));
        expect(result.handled).toBe(true);
      }
    });

    it("rejects requests over limit", async () => {
      const mw = rateLimitRequests({ maxRequests: 2, windowMs: 60_000 });
      const ctx: WebhookRequestContext = {
        method: "POST",
        url: "",
        headers: {},
        body: "data",
        provider: "test",
      };

      await mw(ctx, async () => ({ handled: true, message: "ok" }));
      await mw(ctx, async () => ({ handled: true, message: "ok" }));
      const result = await mw(ctx, async () => ({
        handled: true,
        message: "ok",
      }));
      expect(result.handled).toBe(false);
      expect(result.message).toContain("Rate limit");
    });
  });

  describe("createWebhookEvent", () => {
    it("creates an event envelope", () => {
      const event = createWebhookEvent("slack", { text: "hi" }, {
        eventType: "message",
        deliveryId: "d-1",
      });
      expect(event.source).toBe("slack");
      expect(event.payload).toEqual({ text: "hi" });
      expect(event.eventType).toBe("message");
      expect(event.deliveryId).toBe("d-1");
      expect(event.receivedAt).toBeTruthy();
    });
  });

  describe("createEventRouter", () => {
    it("routes to the correct handler", async () => {
      const router = createEventRouter<{ action: string }>({
        source: "test",
        typeExtractor: (p) => p.action,
        handlers: {
          create: async (data) => ({
            handled: true,
            message: `created: ${data.action}`,
          }),
          update: async (data) => ({
            handled: true,
            message: `updated: ${data.action}`,
          }),
        },
      });

      const result = await router({ action: "create" });
      expect(result.handled).toBe(true);
      expect(result.message).toContain("created");
    });

    it("calls default handler for unknown types", async () => {
      const router = createEventRouter<{ type: string }>({
        source: "test",
        typeExtractor: (p) => p.type,
        handlers: {},
        defaultHandler: async (data) => ({
          handled: true,
          message: `default: ${data.type}`,
        }),
      });

      const result = await router({ type: "unknown" });
      expect(result.handled).toBe(true);
      expect(result.message).toContain("default");
    });

    it("returns unhandled for missing type without default", async () => {
      const router = createEventRouter<{ type: string }>({
        source: "test",
        typeExtractor: (p) => p.type,
        handlers: {},
      });

      const result = await router({ type: "missing" });
      expect(result.handled).toBe(false);
    });
  });

  describe("normalizeToEvent", () => {
    it("wraps payload into event with extractors", () => {
      const event = normalizeToEvent(
        "linear",
        { action: "create", id: "123" },
        {
          typeExtractor: (p) => (p as any).action,
          idExtractor: (p) => (p as any).id,
        },
      );
      expect(event.source).toBe("linear");
      expect(event.eventType).toBe("create");
      expect(event.deliveryId).toBe("123");
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// retry.ts
// ═══════════════════════════════════════════════════════════════════════════════

describe("retry", () => {
  describe("withWebhookRetry", () => {
    it("returns result on first success", async () => {
      const result = await withWebhookRetry(async () => "ok", {
        maxAttempts: 3,
      });
      expect(result).toBe("ok");
    });

    it("retries on failure and succeeds", async () => {
      let attempt = 0;
      const result = await withWebhookRetry(
        async () => {
          attempt++;
          if (attempt < 3) throw new Error("transient");
          return "recovered";
        },
        { maxAttempts: 3, baseDelayMs: 1 },
      );
      expect(result).toBe("recovered");
      expect(attempt).toBe(3);
    });

    it("throws after exhausting retries", async () => {
      await expect(
        withWebhookRetry(
          async () => {
            throw new Error("permanent");
          },
          { maxAttempts: 2, baseDelayMs: 1 },
        ),
      ).rejects.toThrow("permanent");
    });

    it("calls onExhausted when retries are exhausted", async () => {
      const exhaustedFn = vi.fn();
      await expect(
        withWebhookRetry(
          async () => {
            throw new Error("fail");
          },
          { maxAttempts: 1, baseDelayMs: 1, onExhausted: exhaustedFn },
        ),
      ).rejects.toThrow();
      expect(exhaustedFn).toHaveBeenCalledWith(expect.any(Error), 1);
    });
  });

  describe("classifyError", () => {
    it("classifies timeout as transient", () => {
      expect(classifyError(new Error("Connection timeout"))).toBe("transient");
    });

    it("classifies 401 as auth", () => {
      expect(classifyError(new Error("401 Unauthorized"))).toBe("auth");
    });

    it("classifies unknown errors as permanent", () => {
      expect(classifyError(new Error("bad input"))).toBe("permanent");
    });

    it("classifies non-Error as permanent", () => {
      expect(classifyError("some string")).toBe("permanent");
    });
  });

  describe("createWebhookError", () => {
    it("creates a structured error", () => {
      const err = createWebhookError(new Error("fail"), "linear", 2);
      expect(err.provider).toBe("linear");
      expect(err.attempt).toBe(2);
      expect(err.kind).toBe("permanent");
      expect(err.timestamp).toBeTruthy();
    });
  });

  describe("DeadLetterQueue", () => {
    it("adds and lists entries", () => {
      const dlq = new DeadLetterQueue();
      dlq.add({
        provider: "test",
        payload: { x: 1 },
        error: {
          kind: "permanent",
          message: "bad",
          provider: "test",
          timestamp: new Date().toISOString(),
        },
        receivedAt: new Date().toISOString(),
        attempts: 3,
      });
      expect(dlq.size).toBe(1);
      expect(dlq.list()[0].provider).toBe("test");
    });

    it("filters by provider", () => {
      const dlq = new DeadLetterQueue();
      dlq.add({
        provider: "a",
        payload: {},
        error: {
          kind: "permanent",
          message: "x",
          provider: "a",
          timestamp: new Date().toISOString(),
        },
        receivedAt: new Date().toISOString(),
        attempts: 1,
      });
      dlq.add({
        provider: "b",
        payload: {},
        error: {
          kind: "permanent",
          message: "x",
          provider: "b",
          timestamp: new Date().toISOString(),
        },
        receivedAt: new Date().toISOString(),
        attempts: 1,
      });
      expect(dlq.list("a")).toHaveLength(1);
      expect(dlq.list("b")).toHaveLength(1);
    });

    it("removes entries by ID", () => {
      const dlq = new DeadLetterQueue();
      dlq.add({
        provider: "test",
        payload: {},
        error: {
          kind: "permanent",
          message: "x",
          provider: "test",
          timestamp: new Date().toISOString(),
        },
        receivedAt: new Date().toISOString(),
        attempts: 1,
      });
      const id = dlq.list()[0].id;
      expect(dlq.remove(id)).toBe(true);
      expect(dlq.size).toBe(0);
    });

    it("clears all entries", () => {
      const dlq = new DeadLetterQueue();
      for (let i = 0; i < 5; i++) {
        dlq.add({
          provider: "test",
          payload: {},
          error: {
            kind: "permanent",
            message: "x",
            provider: "test",
            timestamp: new Date().toISOString(),
          },
          receivedAt: new Date().toISOString(),
          attempts: 1,
        });
      }
      const cleared = dlq.clear();
      expect(cleared).toBe(5);
      expect(dlq.size).toBe(0);
    });

    it("evicts oldest when over capacity", () => {
      const dlq = new DeadLetterQueue(3);
      for (let i = 0; i < 5; i++) {
        dlq.add({
          provider: `p${i}`,
          payload: {},
          error: {
            kind: "permanent",
            message: "x",
            provider: `p${i}`,
            timestamp: new Date().toISOString(),
          },
          receivedAt: new Date().toISOString(),
          attempts: 1,
        });
      }
      expect(dlq.size).toBe(3);
    });
  });

  describe("withRetryHandler", () => {
    it("wraps a handler with retry", async () => {
      let calls = 0;
      const handler = withRetryHandler(
        "test",
        async () => {
          calls++;
          if (calls < 2) throw new Error("transient");
          return { handled: true, message: "ok" };
        },
        { maxAttempts: 3, baseDelayMs: 1 },
      );

      const result = await handler({});
      expect(result.handled).toBe(true);
      expect(calls).toBe(2);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// config.ts
// ═══════════════════════════════════════════════════════════════════════════════

describe("config", () => {
  beforeEach(() => {
    setConfig({ providers: {} });
    // Clean up any test providers from registry
    removeProvider("cfg-test");
  });

  describe("provider config CRUD", () => {
    it("sets and gets provider config", () => {
      setProviderConfig({ name: "cfg-test", secret: "MY_SECRET" });
      const cfg = getProviderConfig("cfg-test");
      expect(cfg?.secret).toBe("MY_SECRET");
    });

    it("merges with existing config", () => {
      setProviderConfig({ name: "cfg-test", secret: "A", path: "/hook" });
      setProviderConfig({ name: "cfg-test", secret: "B" });
      const cfg = getProviderConfig("cfg-test");
      expect(cfg?.secret).toBe("B");
      expect(cfg?.path).toBe("/hook");
    });

    it("removes provider config", () => {
      setProviderConfig({ name: "cfg-test" });
      expect(removeProviderConfig("cfg-test")).toBe(true);
      expect(getProviderConfig("cfg-test")).toBeUndefined();
    });

    it("returns false removing non-existent config", () => {
      expect(removeProviderConfig("nonexistent")).toBe(false);
    });

    it("lists configured providers", () => {
      setProviderConfig({ name: "a" });
      setProviderConfig({ name: "b" });
      expect(listConfiguredProviders()).toContain("a");
      expect(listConfiguredProviders()).toContain("b");
    });
  });

  describe("resolveSecret", () => {
    it("reads env var for uppercase pattern", () => {
      process.env.TEST_WEBHOOK_SECRET = "from-env";
      expect(resolveSecret("TEST_WEBHOOK_SECRET")).toBe("from-env");
      delete process.env.TEST_WEBHOOK_SECRET;
    });

    it("returns literal for non-env-var pattern", () => {
      expect(resolveSecret("my-literal-secret")).toBe("my-literal-secret");
    });

    it("returns undefined for unset env var", () => {
      expect(resolveSecret("NONEXISTENT_VAR_XYZ")).toBeUndefined();
    });
  });

  describe("getProviderSecret", () => {
    it("resolves configured secret", () => {
      process.env.LINEAR_WEBHOOK_SECRET = "linear-secret";
      setProviderConfig({ name: "cfg-test", secret: "LINEAR_WEBHOOK_SECRET" });
      expect(getProviderSecret("cfg-test")).toBe("linear-secret");
      delete process.env.LINEAR_WEBHOOK_SECRET;
    });

    it("returns undefined for unconfigured provider", () => {
      expect(getProviderSecret("nonexistent")).toBeUndefined();
    });
  });

  describe("getProviderRetryOpts", () => {
    it("merges defaults with provider overrides", () => {
      setConfig({
        defaults: { retry: { maxAttempts: 5, baseDelayMs: 1000 } },
        providers: {
          "cfg-test": {
            name: "cfg-test",
            retry: { maxAttempts: 2 },
          },
        },
      });
      const opts = getProviderRetryOpts("cfg-test");
      expect(opts.maxAttempts).toBe(2); // Provider override
      expect(opts.baseDelayMs).toBe(1000); // From defaults
    });
  });

  describe("isProviderEnabled", () => {
    it("returns true by default", () => {
      expect(isProviderEnabled("unconfigured")).toBe(true);
    });

    it("respects explicit disabled flag", () => {
      setProviderConfig({ name: "cfg-test", enabled: false });
      expect(isProviderEnabled("cfg-test")).toBe(false);
    });
  });

  describe("validateConfig", () => {
    it("reports missing env var secrets", () => {
      setProviderConfig({ name: "cfg-test", secret: "MISSING_ENV_VAR_XYZ" });
      registerProvider({
        name: "cfg-test",
        verify: () => true,
        process: async () => ({ handled: true, message: "ok" }),
      });
      const issues = validateProviderConfig("cfg-test");
      expect(issues.some((i) => i.includes("not set"))).toBe(true);
    });

    it("reports configured but unregistered providers", () => {
      setProviderConfig({ name: "ghost" });
      const issues = validateProviderConfig("ghost");
      expect(issues.some((i) => i.includes("not registered"))).toBe(true);
    });

    it("validates entire config", () => {
      setProviderConfig({ name: "ghost" });
      registerProvider({
        name: "orphan",
        verify: () => true,
        process: async () => ({ handled: true, message: "ok" }),
      });
      const allIssues = validateConfig();
      expect(allIssues["ghost"]).toBeDefined();
      expect(allIssues["orphan"]).toBeDefined();
      // cleanup
      removeProvider("orphan");
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// handlers.ts
// ═══════════════════════════════════════════════════════════════════════════════

describe("handlers", () => {
  beforeEach(() => {
    removeProvider("htest");
    removeProvider("htest-sha256-hex");
    removeProvider("htest-slack");
    removeProvider("htest-twilio");
    resetProviderStats();
  });

  describe("safeHandler", () => {
    it("returns result on success", async () => {
      const handler = safeHandler("test", async () => ({
        handled: true,
        message: "ok",
      }));
      const result = await handler({});
      expect(result.handled).toBe(true);
    });

    it("catches thrown errors", async () => {
      const handler = safeHandler("test", async () => {
        throw new Error("boom");
      });
      const result = await handler({});
      expect(result.handled).toBe(false);
      expect(result.message).toContain("boom");
    });
  });

  describe("registerHmacSha256HexProvider", () => {
    it("registers and verifies correctly", () => {
      const provider = registerHmacSha256HexProvider({
        name: "htest-sha256-hex",
        process: async () => ({ handled: true, message: "ok" }),
      });

      expect(getProvider("htest-sha256-hex")).toBe(provider);

      const body = '{"test":true}';
      const secret = "test-secret";
      const sig = hmacSha256Hex(body, secret);

      expect(
        provider.verify({ rawBody: body, signature: sig, secret }),
      ).toBe(true);
      expect(
        provider.verify({ rawBody: body, signature: "wrong", secret }),
      ).toBe(false);
    });
  });

  describe("registerSlackStyleProvider", () => {
    it("verifies Slack v0 signatures", () => {
      const provider = registerSlackStyleProvider({
        name: "htest-slack",
        process: async () => ({ handled: true, message: "ok" }),
      });

      const body = "body";
      const secret = "slack-secret";
      const timestamp = String(Math.floor(Date.now() / 1000));
      const baseString = `v0:${timestamp}:${body}`;
      const sig = `v0=${hmacSha256Hex(baseString, secret)}`;

      expect(
        provider.verify({
          rawBody: body,
          signature: sig,
          secret,
          headers: { timestamp },
        }),
      ).toBe(true);
    });
  });

  describe("registerTwilioStyleProvider", () => {
    it("verifies Twilio signatures", () => {
      const provider = registerTwilioStyleProvider({
        name: "htest-twilio",
        process: async () => ({ handled: true, message: "ok" }),
      });

      const url = "https://example.com/hook";
      const params = { A: "1", B: "2" };
      const secret = "twilio-token";
      const data = url + "A1B2";
      const sig = hmacSha1Base64(data, secret);

      expect(
        provider.verify({
          rawBody: "",
          signature: sig,
          secret,
          url,
          params,
        }),
      ).toBe(true);
    });
  });

  describe("withLogging", () => {
    it("logs and delegates", async () => {
      const handler = withLogging("test", async () => ({
        handled: true,
        message: "logged",
      }));
      const result = await handler({});
      expect(result.message).toBe("logged");
    });
  });
});
