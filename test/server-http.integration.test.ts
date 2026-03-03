/**
 * Integration tests: HTTP server routes — authentication middleware,
 * API endpoints, status reporting, and settings management.
 *
 * These tests exercise the Hono app without starting a real server.
 * We build a minimal test harness that constructs Hono routes directly.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { createTempDir, randomKey, writeJsonlFile } from "./helpers.js";
import { encrypt, decrypt, deriveKey } from "../src/auth/crypto.js";
import { join } from "node:path";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Test helpers: minimal Hono app simulating key server routes
// ---------------------------------------------------------------------------

function sha256(input: string): string {
  return createHash("sha256").update(input.trim().toLowerCase()).digest("hex");
}

function stableSessionId(safeWordHash: string): string {
  return createHash("sha256").update(safeWordHash + ":session").digest("hex").slice(0, 48);
}

function createTestApp(opts: {
  identityDir: string;
  sessionsDir: string;
  vaultDir: string;
  settingsPath: string;
}) {
  const app = new Hono();
  const sessions = new Map<string, { id: string; name: string; createdAt: number }>();
  const sessionKeys = new Map<string, Buffer>();
  const SESSION_TTL = 24 * 60 * 60 * 1000;

  // Auth middleware
  const requireAuth = async (c: any, next: any) => {
    const sessionId = c.req.header("X-Session-Id");
    if (!sessionId) return c.json({ error: "No session" }, 401);

    const session = sessions.get(sessionId);
    if (!session) return c.json({ error: "Invalid session" }, 401);
    if (Date.now() - session.createdAt > SESSION_TTL) {
      sessions.delete(sessionId);
      return c.json({ error: "Session expired" }, 401);
    }

    c.set("session", session);
    c.set("sessionId", sessionId);
    return next();
  };

  // GET /api/status
  app.get("/api/status", async (c) => {
    try {
      const raw = await readFile(join(opts.identityDir, "human.json"), "utf-8");
      return c.json({ paired: true, needsCode: false });
    } catch {
      return c.json({ paired: false, needsCode: false });
    }
  });

  // POST /api/pair
  app.post("/api/pair", async (c) => {
    const body = await c.req.json();
    const { code, name, safeWord, recoveryQuestion, recoveryAnswer } = body;

    if (!code || !name || !safeWord) {
      return c.json({ error: "Missing required fields" }, 400);
    }

    // Check if already paired
    try {
      await readFile(join(opts.identityDir, "human.json"), "utf-8");
      return c.json({ error: "Already paired" }, 409);
    } catch {}

    // Verify pairing code
    try {
      const raw = await readFile(join(opts.identityDir, "pairing-code.json"), "utf-8");
      const stored = JSON.parse(raw);
      if (code.trim().toLowerCase() !== stored.code) {
        return c.json({ error: "Invalid pairing code" }, 403);
      }
    } catch {
      return c.json({ error: "No pairing code found" }, 404);
    }

    // Create identity
    const salt = randomBytes(16).toString("hex");
    const identity = {
      name: name.trim(),
      safeWordHash: sha256(safeWord),
      pbkdf2Salt: salt,
      recovery: { question: recoveryQuestion, answerHash: sha256(recoveryAnswer) },
      pairedAt: new Date().toISOString(),
    };

    await writeFile(join(opts.identityDir, "human.json"), JSON.stringify(identity));

    // Create session
    const sessionId = stableSessionId(identity.safeWordHash);
    const sessionKey = deriveKey(safeWord, Buffer.from(salt, "hex"));
    sessions.set(sessionId, { id: sessionId, name: name.trim(), createdAt: Date.now() });
    sessionKeys.set(sessionId, sessionKey);

    return c.json({ sessionId, name: name.trim() });
  });

  // POST /api/auth
  app.post("/api/auth", async (c) => {
    const body = await c.req.json();
    const { safeWord } = body;

    if (!safeWord) return c.json({ error: "Missing safe word" }, 400);

    let identity;
    try {
      const raw = await readFile(join(opts.identityDir, "human.json"), "utf-8");
      identity = JSON.parse(raw);
    } catch {
      return c.json({ error: "Not paired yet" }, 404);
    }

    if (sha256(safeWord) !== identity.safeWordHash) {
      return c.json({ error: "Wrong safe word" }, 403);
    }

    const sessionId = stableSessionId(identity.safeWordHash);
    const sessionKey = deriveKey(safeWord, Buffer.from(identity.pbkdf2Salt, "hex"));
    sessions.set(sessionId, { id: sessionId, name: identity.name, createdAt: Date.now() });
    sessionKeys.set(sessionId, sessionKey);

    return c.json({ sessionId, name: identity.name });
  });

  // GET /api/vault (protected)
  app.get("/api/vault", requireAuth, async (c) => {
    const sessionId = c.get("sessionId") as string;
    const key = sessionKeys.get(sessionId);
    if (!key) return c.json({ error: "No vault key" }, 500);

    try {
      const raw = await readFile(join(opts.vaultDir, "keys.json"), "utf-8");
      const file = JSON.parse(raw);
      const plaintext = decrypt(
        { ciphertext: file.ciphertext, iv: file.iv, authTag: file.authTag },
        key,
      );
      const data = JSON.parse(plaintext);
      const listing = Object.entries(data).map(([name, entry]: [string, any]) => ({
        name,
        label: entry.label,
      }));
      return c.json({ keys: listing });
    } catch {
      return c.json({ keys: [] });
    }
  });

  // PUT /api/vault/:name (protected)
  app.put("/api/vault/:name", requireAuth, async (c) => {
    const sessionId = c.get("sessionId") as string;
    const key = sessionKeys.get(sessionId);
    if (!key) return c.json({ error: "No vault key" }, 500);

    const name = c.req.param("name");
    const body = await c.req.json();

    let data: Record<string, any> = {};
    try {
      const raw = await readFile(join(opts.vaultDir, "keys.json"), "utf-8");
      const file = JSON.parse(raw);
      const plaintext = decrypt(
        { ciphertext: file.ciphertext, iv: file.iv, authTag: file.authTag },
        key,
      );
      data = JSON.parse(plaintext);
    } catch {}

    data[name] = { value: body.value, label: body.label };

    const payload = encrypt(JSON.stringify(data), key);
    await writeFile(
      join(opts.vaultDir, "keys.json"),
      JSON.stringify({ v: 1, ...payload }),
    );

    return c.json({ ok: true });
  });

  // GET /api/settings (protected)
  app.get("/api/settings", requireAuth, async (c) => {
    try {
      const raw = await readFile(opts.settingsPath, "utf-8");
      return c.json(JSON.parse(raw));
    } catch {
      return c.json({ airplaneMode: false });
    }
  });

  // PUT /api/settings (protected)
  app.put("/api/settings", requireAuth, async (c) => {
    const body = await c.req.json();
    await writeFile(opts.settingsPath, JSON.stringify(body, null, 2));
    return c.json({ ok: true });
  });

  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Server HTTP integration", () => {
  let app: Hono;
  let identityDir: string;
  let sessionsDir: string;
  let vaultDir: string;
  let settingsPath: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const tmp = await createTempDir("dash-server-");
    identityDir = join(tmp.dir, "identity");
    sessionsDir = join(tmp.dir, "sessions");
    vaultDir = join(tmp.dir, "vault");
    settingsPath = join(tmp.dir, "settings.json");

    await Promise.all([
      mkdir(identityDir, { recursive: true }),
      mkdir(sessionsDir, { recursive: true }),
      mkdir(vaultDir, { recursive: true }),
    ]);

    app = createTestApp({ identityDir, sessionsDir, vaultDir, settingsPath });
    cleanup = tmp.cleanup;
  });

  afterEach(async () => {
    await cleanup();
  });

  // -------------------------------------------------------------------------
  // Status endpoint
  // -------------------------------------------------------------------------

  it("GET /api/status should return unpaired when no human.json", async () => {
    const res = await app.request("/api/status");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.paired).toBe(false);
  });

  it("GET /api/status should return paired when human.json exists", async () => {
    await writeFile(join(identityDir, "human.json"), JSON.stringify({
      name: "Test",
      safeWordHash: sha256("word"),
      pairedAt: new Date().toISOString(),
    }));

    const res = await app.request("/api/status");
    const data = await res.json();
    expect(data.paired).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Pairing flow
  // -------------------------------------------------------------------------

  it("POST /api/pair should complete pairing ceremony", async () => {
    // Create pairing code
    await writeFile(
      join(identityDir, "pairing-code.json"),
      JSON.stringify({ code: "amber-castle-seven", createdAt: new Date().toISOString() }),
    );

    const res = await app.request("/api/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: "amber-castle-seven",
        name: "TestUser",
        safeWord: "mysecret",
        recoveryQuestion: "Pet name?",
        recoveryAnswer: "Fluffy",
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.sessionId).toBeTruthy();
    expect(data.name).toBe("TestUser");
  });

  it("POST /api/pair should reject invalid code", async () => {
    await writeFile(
      join(identityDir, "pairing-code.json"),
      JSON.stringify({ code: "real-code-here", createdAt: new Date().toISOString() }),
    );

    const res = await app.request("/api/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: "wrong-code",
        name: "Hacker",
        safeWord: "evil",
        recoveryQuestion: "?",
        recoveryAnswer: "?",
      }),
    });

    expect(res.status).toBe(403);
  });

  it("POST /api/pair should reject when already paired", async () => {
    await writeFile(join(identityDir, "human.json"), JSON.stringify({ name: "Existing" }));

    const res = await app.request("/api/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: "any",
        name: "Another",
        safeWord: "word",
        recoveryQuestion: "?",
        recoveryAnswer: "?",
      }),
    });

    expect(res.status).toBe(409);
  });

  it("POST /api/pair should reject missing fields", async () => {
    const res = await app.request("/api/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "test" }), // missing name and safeWord
    });

    expect(res.status).toBe(400);
  });

  // -------------------------------------------------------------------------
  // Authentication flow
  // -------------------------------------------------------------------------

  it("POST /api/auth should authenticate with correct safe word", async () => {
    // First pair
    await writeFile(
      join(identityDir, "pairing-code.json"),
      JSON.stringify({ code: "test-code", createdAt: new Date().toISOString() }),
    );

    await app.request("/api/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: "test-code",
        name: "Alice",
        safeWord: "secret",
        recoveryQuestion: "?",
        recoveryAnswer: "?",
      }),
    });

    // Then authenticate
    const res = await app.request("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ safeWord: "secret" }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.name).toBe("Alice");
    expect(data.sessionId).toBeTruthy();
  });

  it("POST /api/auth should reject wrong safe word", async () => {
    await writeFile(join(identityDir, "human.json"), JSON.stringify({
      name: "Bob",
      safeWordHash: sha256("correct"),
      pbkdf2Salt: randomBytes(16).toString("hex"),
      recovery: { question: "?", answerHash: sha256("?") },
      pairedAt: new Date().toISOString(),
    }));

    const res = await app.request("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ safeWord: "wrong" }),
    });

    expect(res.status).toBe(403);
  });

  it("POST /api/auth should return 404 when not paired", async () => {
    const res = await app.request("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ safeWord: "anything" }),
    });

    expect(res.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // Protected routes (auth middleware)
  // -------------------------------------------------------------------------

  it("protected routes should reject unauthenticated requests", async () => {
    const res = await app.request("/api/vault");
    expect(res.status).toBe(401);

    const res2 = await app.request("/api/settings");
    expect(res2.status).toBe(401);
  });

  it("protected routes should reject invalid session ID", async () => {
    const res = await app.request("/api/vault", {
      headers: { "X-Session-Id": "fake_session_id" },
    });
    expect(res.status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // Full authenticated workflow
  // -------------------------------------------------------------------------

  it("should complete full pair → auth → vault → settings workflow", async () => {
    // 1. Create pairing code
    await writeFile(
      join(identityDir, "pairing-code.json"),
      JSON.stringify({ code: "flow-test", createdAt: new Date().toISOString() }),
    );

    // 2. Pair
    const pairRes = await app.request("/api/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: "flow-test",
        name: "FlowUser",
        safeWord: "flowsecret",
        recoveryQuestion: "Color?",
        recoveryAnswer: "blue",
      }),
    });

    const { sessionId } = await pairRes.json();
    expect(sessionId).toBeTruthy();

    // 3. Access vault (should be empty)
    const vaultRes = await app.request("/api/vault", {
      headers: { "X-Session-Id": sessionId },
    });
    expect(vaultRes.status).toBe(200);
    const vaultData = await vaultRes.json();
    expect(vaultData.keys).toEqual([]);

    // 4. Add a vault key
    const putRes = await app.request("/api/vault/OPENROUTER_API_KEY", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Session-Id": sessionId,
      },
      body: JSON.stringify({ value: "sk-or-test123", label: "OpenRouter" }),
    });
    expect(putRes.status).toBe(200);

    // 5. Verify vault key was stored
    const vaultRes2 = await app.request("/api/vault", {
      headers: { "X-Session-Id": sessionId },
    });
    const vaultData2 = await vaultRes2.json();
    expect(vaultData2.keys.length).toBe(1);
    expect(vaultData2.keys[0].name).toBe("OPENROUTER_API_KEY");
    expect(vaultData2.keys[0].label).toBe("OpenRouter");

    // 6. Save settings
    const settingsRes = await app.request("/api/settings", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Session-Id": sessionId,
      },
      body: JSON.stringify({ airplaneMode: true }),
    });
    expect(settingsRes.status).toBe(200);

    // 7. Read settings
    const getSettingsRes = await app.request("/api/settings", {
      headers: { "X-Session-Id": sessionId },
    });
    const settings = await getSettingsRes.json();
    expect(settings.airplaneMode).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Re-authentication produces same session ID
  // -------------------------------------------------------------------------

  it("same safe word should produce same session ID across auth calls", async () => {
    await writeFile(
      join(identityDir, "pairing-code.json"),
      JSON.stringify({ code: "stable-test", createdAt: new Date().toISOString() }),
    );

    const pairRes = await app.request("/api/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: "stable-test",
        name: "Stable",
        safeWord: "stableword",
        recoveryQuestion: "?",
        recoveryAnswer: "?",
      }),
    });
    const { sessionId: id1 } = await pairRes.json();

    const authRes = await app.request("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ safeWord: "stableword" }),
    });
    const { sessionId: id2 } = await authRes.json();

    expect(id1).toBe(id2);
  });
});
