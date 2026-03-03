/**
 * Tests for the in-memory sliding-window rate limiter middleware.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { rateLimit } from "../src/rate-limit.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createApp(config?: Parameters<typeof rateLimit>[0]) {
  const app = new Hono();
  app.use("/limited/*", rateLimit(config));
  app.get("/limited/test", (c) => c.json({ ok: true }));
  app.post("/limited/test", (c) => c.json({ ok: true }));
  // Unrestricted route for comparison.
  app.get("/free/test", (c) => c.json({ ok: true }));
  return app;
}

async function fire(app: Hono, path = "/limited/test", method = "GET") {
  const req = new Request(`http://localhost${path}`, { method });
  return app.request(req);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("rateLimit middleware", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows requests under the limit", async () => {
    const app = createApp({ max: 5, windowMs: 60_000 });

    const res = await fire(app);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("5");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("4");
    expect(res.headers.get("X-RateLimit-Reset")).toBeTruthy();
  });

  it("decrements remaining with each request", async () => {
    const app = createApp({ max: 3, windowMs: 60_000 });

    const r1 = await fire(app);
    expect(r1.headers.get("X-RateLimit-Remaining")).toBe("2");

    const r2 = await fire(app);
    expect(r2.headers.get("X-RateLimit-Remaining")).toBe("1");

    const r3 = await fire(app);
    expect(r3.headers.get("X-RateLimit-Remaining")).toBe("0");
  });

  it("returns 429 when limit is exceeded", async () => {
    const app = createApp({ max: 2, windowMs: 60_000 });

    // First two should pass.
    await fire(app);
    await fire(app);

    // Third should be blocked.
    const res = await fire(app);
    expect(res.status).toBe(429);

    const body = await res.json();
    expect(body.error).toBe("Too many requests");

    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("resets after the window expires", async () => {
    const app = createApp({ max: 2, windowMs: 10_000 });

    await fire(app);
    await fire(app);

    // Should be blocked.
    const blocked = await fire(app);
    expect(blocked.status).toBe(429);

    // Advance past the window.
    vi.advanceTimersByTime(11_000);

    // Should be allowed again.
    const res = await fire(app);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("1");
  });

  it("does not affect unrestricted routes", async () => {
    const app = createApp({ max: 1, windowMs: 60_000 });

    // Exhaust the limited route.
    await fire(app, "/limited/test");
    const blocked = await fire(app, "/limited/test");
    expect(blocked.status).toBe(429);

    // Unrestricted route should still work.
    const free = await fire(app, "/free/test");
    expect(free.status).toBe(200);
  });

  it("uses custom key function to separate clients", async () => {
    const app = new Hono();
    app.use(
      "/api/*",
      rateLimit({
        max: 1,
        windowMs: 60_000,
        keyFn: (c) => c.req.header("X-Client-Id") || "anon",
      })
    );
    app.get("/api/test", (c) => c.json({ ok: true }));

    // Client A — first request allowed.
    const a1 = await app.request(
      new Request("http://localhost/api/test", {
        headers: { "X-Client-Id": "client-a" },
      })
    );
    expect(a1.status).toBe(200);

    // Client A — second request blocked.
    const a2 = await app.request(
      new Request("http://localhost/api/test", {
        headers: { "X-Client-Id": "client-a" },
      })
    );
    expect(a2.status).toBe(429);

    // Client B — should still be allowed (different key).
    const b1 = await app.request(
      new Request("http://localhost/api/test", {
        headers: { "X-Client-Id": "client-b" },
      })
    );
    expect(b1.status).toBe(200);
  });

  it("supports custom error message as string", async () => {
    const app = new Hono();
    app.use("/api/*", rateLimit({ max: 1, windowMs: 60_000, message: "Slow down" }));
    app.get("/api/test", (c) => c.json({ ok: true }));

    await app.request(new Request("http://localhost/api/test"));
    const res = await app.request(new Request("http://localhost/api/test"));

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe("Slow down");
  });

  it("supports custom error message as object", async () => {
    const app = new Hono();
    app.use(
      "/api/*",
      rateLimit({ max: 1, windowMs: 60_000, message: { code: "RATE_LIMITED", detail: "Chill" } })
    );
    app.get("/api/test", (c) => c.json({ ok: true }));

    await app.request(new Request("http://localhost/api/test"));
    const res = await app.request(new Request("http://localhost/api/test"));

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.code).toBe("RATE_LIMITED");
    expect(body.detail).toBe("Chill");
  });

  it("sliding window allows partial refill", async () => {
    const app = createApp({ max: 3, windowMs: 10_000 });

    // Use up 2 of 3.
    await fire(app);
    await fire(app);

    // Advance 5s (half the window) then make another request.
    vi.advanceTimersByTime(5_000);
    const r3 = await fire(app);
    expect(r3.status).toBe(200);

    // Now at limit (3 requests within 10s window). Next should fail.
    const r4 = await fire(app);
    expect(r4.status).toBe(429);

    // Advance another 6s — the first two requests are now outside the window.
    vi.advanceTimersByTime(6_000);
    const r5 = await fire(app);
    expect(r5.status).toBe(200);
    expect(r5.headers.get("X-RateLimit-Remaining")).toBe("1");
  });

  it("multiple middleware instances are isolated", async () => {
    const app = new Hono();

    // Two separate rate limiters for different route groups.
    app.use("/auth/*", rateLimit({ max: 2, windowMs: 60_000 }));
    app.use("/api/*", rateLimit({ max: 5, windowMs: 60_000 }));
    app.post("/auth/login", (c) => c.json({ ok: true }));
    app.get("/api/data", (c) => c.json({ ok: true }));

    // Exhaust auth limiter.
    await app.request(new Request("http://localhost/auth/login", { method: "POST" }));
    await app.request(new Request("http://localhost/auth/login", { method: "POST" }));
    const authBlocked = await app.request(
      new Request("http://localhost/auth/login", { method: "POST" })
    );
    expect(authBlocked.status).toBe(429);

    // API limiter should be unaffected.
    const apiOk = await app.request(new Request("http://localhost/api/data"));
    expect(apiOk.status).toBe(200);
    expect(apiOk.headers.get("X-RateLimit-Remaining")).toBe("4");
  });

  it("uses defaults when no config provided", async () => {
    const app = createApp(); // All defaults: 60 req/min

    const res = await fire(app);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("60");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("59");
  });
});
