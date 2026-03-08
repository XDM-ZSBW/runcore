/**
 * Tests for auth/middleware.ts — session auth gate on /api/* routes.
 *
 * Uses a minimal Hono app to test the middleware behavior without
 * starting the full server.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";

// Mock identity module to control session validation
const mockValidateSession = vi.fn();

vi.mock("../../src/auth/identity.js", () => ({
  validateSession: (...args: unknown[]) => mockValidateSession(...args),
}));

import { requireSession } from "../../src/auth/middleware.js";

// ---------------------------------------------------------------------------
// Test app setup
// ---------------------------------------------------------------------------

function createTestApp() {
  const app = new Hono();
  app.use("/api/*", requireSession());

  // Public routes (should be in the allowlist)
  app.get("/api/status", (c) => c.json({ ok: true }));
  app.post("/api/pair", (c) => c.json({ paired: true }));
  app.post("/api/auth", (c) => c.json({ authed: true }));
  app.get("/api/auth/validate", (c) => c.json({ valid: true }));
  app.get("/api/auth/active-session", (c) => c.json({ active: true }));
  app.post("/api/auth/token", (c) => c.json({ token: true }));
  app.post("/api/recover", (c) => c.json({ recovered: true }));
  app.get("/api/tier", (c) => c.json({ tier: "local" }));
  app.get("/api/health", (c) => c.json({ healthy: true }));
  app.get("/api/ui-version", (c) => c.json({ version: "1.0" }));

  // Protected routes
  app.get("/api/settings", (c) => c.json({ settings: true }));
  app.get("/api/chat", (c) => c.json({ chat: true }));
  app.get("/api/models", (c) => c.json({ models: [] }));
  app.get("/api/history", (c) => c.json({ history: [] }));

  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let app: ReturnType<typeof createTestApp>;

beforeEach(() => {
  vi.clearAllMocks();
  app = createTestApp();
});

describe("public routes (no auth required)", () => {
  const publicPaths = [
    ["GET", "/api/status"],
    ["POST", "/api/pair"],
    ["POST", "/api/auth"],
    ["GET", "/api/auth/validate"],
    ["GET", "/api/auth/active-session"],
    ["POST", "/api/auth/token"],
    ["POST", "/api/recover"],
    ["GET", "/api/tier"],
    ["GET", "/api/health"],
    ["GET", "/api/ui-version"],
  ] as const;

  for (const [method, path] of publicPaths) {
    it(`${method} ${path} returns 200 without session`, async () => {
      const req = new Request(`http://localhost${path}`, { method });
      const res = await app.request(req);
      expect(res.status).toBe(200);
    });
  }
});

describe("protected routes (auth required)", () => {
  it("returns 401 without session header", async () => {
    const res = await app.request(new Request("http://localhost/api/settings"));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Authentication required");
  });

  it("returns 401 with invalid session", async () => {
    mockValidateSession.mockReturnValue(null);

    const res = await app.request(new Request("http://localhost/api/settings", {
      headers: { "x-session-id": "invalid-session" },
    }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Invalid or expired session");
  });

  it("returns 200 with valid session via header", async () => {
    mockValidateSession.mockReturnValue({ id: "valid", name: "Bryant", createdAt: Date.now() });

    const res = await app.request(new Request("http://localhost/api/settings", {
      headers: { "x-session-id": "valid-session" },
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.settings).toBe(true);
  });

  it("returns 200 with valid session via query param", async () => {
    mockValidateSession.mockReturnValue({ id: "valid", name: "Bryant", createdAt: Date.now() });

    const res = await app.request(new Request("http://localhost/api/settings?sessionId=valid-session"));
    expect(res.status).toBe(200);
  });

  it("prefers header over query param", async () => {
    mockValidateSession.mockImplementation((id: string) => {
      if (id === "from-header") return { id: "from-header", name: "Bryant", createdAt: Date.now() };
      return null;
    });

    const res = await app.request(new Request("http://localhost/api/settings?sessionId=from-query", {
      headers: { "x-session-id": "from-header" },
    }));
    expect(res.status).toBe(200);
    expect(mockValidateSession).toHaveBeenCalledWith("from-header");
  });
});

describe("all /api/* routes are gated", () => {
  const protectedPaths = [
    "/api/settings",
    "/api/chat",
    "/api/models",
    "/api/history",
    "/api/anything/nested/deep",
  ];

  for (const path of protectedPaths) {
    it(`${path} returns 401 without session`, async () => {
      const res = await app.request(new Request(`http://localhost${path}`));
      expect(res.status).toBe(401);
    });
  }
});

describe("webhook routes (prefix-based public)", () => {
  it("allows GitHub webhook paths without session", async () => {
    app.post("/api/github/webhooks/push", (c) => c.json({ ok: true }));
    const res = await app.request(new Request("http://localhost/api/github/webhooks/push", {
      method: "POST",
    }));
    expect(res.status).toBe(200);
  });

  it("allows Slack webhook paths without session", async () => {
    app.post("/api/slack/events", (c) => c.json({ ok: true }));
    const res = await app.request(new Request("http://localhost/api/slack/events", {
      method: "POST",
    }));
    expect(res.status).toBe(200);
  });
});
