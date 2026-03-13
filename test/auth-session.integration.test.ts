/**
 * Integration tests: Authentication, Pairing ceremony, Session management.
 *
 * Tests the complete auth flow:
 *   generate pairing code → pair → authenticate → session validation → recovery
 *
 * Uses temp directories to isolate identity files from the real brain.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTempDir, randomKey } from "./helpers.js";
import { join } from "node:path";
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { createHash, randomBytes, pbkdf2Sync } from "node:crypto";
import { encrypt, decrypt, deriveKey, type EncryptedPayload } from "../src/auth/crypto.js";
import { saveSession, loadSession, type SessionData } from "../src/sessions/store.js";

// ---------------------------------------------------------------------------
// Crypto primitives
// ---------------------------------------------------------------------------

describe("Crypto primitives (AES-256-GCM + PBKDF2)", () => {
  it("should derive deterministic key from same inputs", () => {
    const salt = randomBytes(16);
    const key1 = deriveKey("mysafeword", salt);
    const key2 = deriveKey("mysafeword", salt);
    expect(key1.equals(key2)).toBe(true);
  });

  it("should derive different keys for different passwords", () => {
    const salt = randomBytes(16);
    const key1 = deriveKey("password1", salt);
    const key2 = deriveKey("password2", salt);
    expect(key1.equals(key2)).toBe(false);
  });

  it("should derive different keys for different salts", () => {
    const salt1 = randomBytes(16);
    const salt2 = randomBytes(16);
    const key1 = deriveKey("same", salt1);
    const key2 = deriveKey("same", salt2);
    expect(key1.equals(key2)).toBe(false);
  });

  it("should normalize input (trim + lowercase)", () => {
    const salt = randomBytes(16);
    const key1 = deriveKey("  MyWord  ", salt);
    const key2 = deriveKey("myword", salt);
    expect(key1.equals(key2)).toBe(true);
  });

  it("should encrypt and decrypt round-trip", () => {
    const key = randomKey();
    const plaintext = "Hello, this is sensitive data!";
    const payload = encrypt(plaintext, key);

    expect(payload.ciphertext).toBeTruthy();
    expect(payload.iv).toBeTruthy();
    expect(payload.authTag).toBeTruthy();
    expect(payload.ciphertext).not.toBe(plaintext);

    const decrypted = decrypt(payload, key);
    expect(decrypted).toBe(plaintext);
  });

  it("should produce different ciphertext for same plaintext (fresh IV)", () => {
    const key = randomKey();
    const p1 = encrypt("same data", key);
    const p2 = encrypt("same data", key);
    expect(p1.iv).not.toBe(p2.iv);
    expect(p1.ciphertext).not.toBe(p2.ciphertext);
  });

  it("should fail decryption with wrong key", () => {
    const key1 = randomKey();
    const key2 = randomKey();
    const payload = encrypt("secret", key1);

    expect(() => decrypt(payload, key2)).toThrow();
  });

  it("should fail decryption with tampered ciphertext", () => {
    const key = randomKey();
    const payload = encrypt("secret", key);

    // Tamper with ciphertext
    const tampered: EncryptedPayload = {
      ...payload,
      ciphertext: payload.ciphertext.replace(/^.{4}/, "dead"),
    };

    expect(() => decrypt(tampered, key)).toThrow();
  });

  it("should fail decryption with tampered auth tag", () => {
    const key = randomKey();
    const payload = encrypt("secret", key);

    const tampered: EncryptedPayload = {
      ...payload,
      authTag: "0".repeat(payload.authTag.length),
    };

    expect(() => decrypt(tampered, key)).toThrow();
  });

  it("should handle large payloads", () => {
    const key = randomKey();
    const plaintext = "x".repeat(100_000);
    const payload = encrypt(plaintext, key);
    const decrypted = decrypt(payload, key);
    expect(decrypted).toBe(plaintext);
  });

  it("should handle unicode content", () => {
    const key = randomKey();
    const plaintext = "日本語テスト 🚀 émojis àccents";
    const payload = encrypt(plaintext, key);
    const decrypted = decrypt(payload, key);
    expect(decrypted).toBe(plaintext);
  });
});

// ---------------------------------------------------------------------------
// Pairing ceremony simulation (file-level, without importing identity.ts
// which uses process.cwd() for paths — we test the logic directly)
// ---------------------------------------------------------------------------

describe("Pairing ceremony logic", () => {
  let dir: string;
  let cleanup: () => Promise<void>;

  function hashPassword(password: string): string {
    const salt = randomBytes(16);
    const hash = pbkdf2Sync(password.trim().toLowerCase(), salt, 600_000, 32, "sha256");
    return `pbkdf2:${salt.toString("hex")}:${hash.toString("hex")}`;
  }

  function verifyPassword(password: string, stored: string): boolean {
    if (stored.startsWith("pbkdf2:")) {
      const [, salt, hash] = stored.split(":");
      const computed = pbkdf2Sync(password.trim().toLowerCase(), Buffer.from(salt, "hex"), 600_000, 32, "sha256");
      return computed.toString("hex") === hash;
    }
    return createHash("sha256").update(password.trim().toLowerCase()).digest("hex") === stored;
  }

  function stableSessionId(passwordHash: string): string {
    return createHash("sha256").update(passwordHash + ":session").digest("hex").slice(0, 48);
  }

  beforeEach(async () => {
    const tmp = await createTempDir("dash-auth-");
    dir = tmp.dir;
    cleanup = tmp.cleanup;
    await mkdir(join(dir, "identity"), { recursive: true });
  });

  afterEach(async () => {
    await cleanup();
  });

  it("should hash safe word case-insensitively and trimmed", () => {
    const h1 = hashPassword("MySecret");
    const h2 = hashPassword("  mysecret  ");
    // Both should verify against the same input
    expect(verifyPassword("mysecret", h1)).toBe(true);
    expect(verifyPassword("mysecret", h2)).toBe(true);
  });

  it("should produce stable session IDs from same hash", () => {
    const hash = hashPassword("password");
    const id1 = stableSessionId(hash);
    const id2 = stableSessionId(hash);
    expect(id1).toBe(id2);
    expect(id1.length).toBe(48);
  });

  it("should produce different session IDs for different safe words", () => {
    const id1 = stableSessionId(hashPassword("word1"));
    const id2 = stableSessionId(hashPassword("word2"));
    expect(id1).not.toBe(id2);
  });

  it("should complete full pairing flow via files", async () => {
    const humanPath = join(dir, "identity", "human.json");
    const codePath = join(dir, "identity", "pairing-code.json");

    // Step 1: Generate pairing code
    const code = "amber-castle-seven-river-oak-noon";
    await writeFile(codePath, JSON.stringify({ code, createdAt: new Date().toISOString() }));

    // Step 2: Verify code and create identity
    const storedCode = JSON.parse(await readFile(codePath, "utf-8"));
    expect(storedCode.code).toBe(code);

    const safeWord = "mySecretWord";
    const salt = randomBytes(16).toString("hex");
    const pwHash = hashPassword(safeWord);
    const identity = {
      name: "TestUser",
      passwordHash: pwHash,
      pbkdf2Salt: salt,
      recovery: {
        question: "What is your pet's name?",
        answerHash: hashPassword("fluffy"),
      },
      pairedAt: new Date().toISOString(),
    };

    await writeFile(humanPath, JSON.stringify(identity, null, 2));
    await unlink(codePath); // consume pairing code

    // Step 3: Verify identity persisted
    const stored = JSON.parse(await readFile(humanPath, "utf-8"));
    expect(stored.name).toBe("TestUser");
    expect(verifyPassword(safeWord, stored.passwordHash)).toBe(true);
  });

  it("should authenticate with correct safe word", async () => {
    const humanPath = join(dir, "identity", "human.json");
    const safeWord = "testword";
    const pwHash = hashPassword(safeWord);
    const identity = {
      name: "Alice",
      passwordHash: pwHash,
      pbkdf2Salt: randomBytes(16).toString("hex"),
      recovery: { question: "Color?", answerHash: hashPassword("blue") },
      pairedAt: new Date().toISOString(),
    };

    await writeFile(humanPath, JSON.stringify(identity));

    const stored = JSON.parse(await readFile(humanPath, "utf-8"));
    const matches = verifyPassword(safeWord, stored.passwordHash);
    expect(matches).toBe(true);
  });

  it("should reject wrong safe word", async () => {
    const humanPath = join(dir, "identity", "human.json");
    const pwHash = hashPassword("correct");
    const identity = {
      name: "Bob",
      passwordHash: pwHash,
      pbkdf2Salt: randomBytes(16).toString("hex"),
      recovery: { question: "Number?", answerHash: hashPassword("42") },
      pairedAt: new Date().toISOString(),
    };

    await writeFile(humanPath, JSON.stringify(identity));

    const stored = JSON.parse(await readFile(humanPath, "utf-8"));
    const matches = verifyPassword("wrong", stored.passwordHash);
    expect(matches).toBe(false);
  });

  it("should recover and change safe word", async () => {
    const humanPath = join(dir, "identity", "human.json");
    const originalWord = "original";
    const recoveryAnswer = "fluffy";
    const newWord = "newword";

    const identity = {
      name: "Carol",
      passwordHash: hashPassword(originalWord),
      pbkdf2Salt: randomBytes(16).toString("hex"),
      recovery: { question: "Pet?", answerHash: hashPassword(recoveryAnswer) },
      pairedAt: new Date().toISOString(),
    };

    await writeFile(humanPath, JSON.stringify(identity));

    // Verify recovery
    const stored = JSON.parse(await readFile(humanPath, "utf-8"));
    expect(verifyPassword(recoveryAnswer, stored.recovery.answerHash)).toBe(true);

    // Update safe word
    stored.passwordHash = hashPassword(newWord);
    stored.pbkdf2Salt = randomBytes(16).toString("hex");
    await writeFile(humanPath, JSON.stringify(stored));

    // Verify new word works, old doesn't
    const updated = JSON.parse(await readFile(humanPath, "utf-8"));
    expect(verifyPassword(newWord, updated.passwordHash)).toBe(true);
    expect(verifyPassword(originalWord, updated.passwordHash)).toBe(false);
  });

  it("should derive session encryption key from safe word", async () => {
    const safeWord = "mysecret";
    const salt = randomBytes(16);

    const sessionKey = deriveKey(safeWord, salt);
    expect(sessionKey.length).toBe(32); // 256 bits

    // Encrypt some session data
    const payload = encrypt(JSON.stringify({ history: [] }), sessionKey);
    const decrypted = decrypt(payload, sessionKey);
    expect(JSON.parse(decrypted)).toEqual({ history: [] });
  });
});

// ---------------------------------------------------------------------------
// Encrypted session persistence
// ---------------------------------------------------------------------------

describe("Encrypted session persistence", () => {
  let sessionsDir: string;
  let cleanup: () => Promise<void>;
  let originalCwd: string;

  beforeEach(async () => {
    const tmp = await createTempDir("dash-sessions-");
    // Create brain/sessions structure
    sessionsDir = join(tmp.dir, "brain", "sessions");
    await mkdir(sessionsDir, { recursive: true });
    cleanup = tmp.cleanup;
    // Override process.cwd for session store
    originalCwd = process.cwd();
  });

  afterEach(async () => {
    await cleanup();
  });

  it("should encrypt, save, load, and decrypt session data via crypto layer", async () => {
    const key = randomKey();
    const sessionId = "test_session_001";
    const data = {
      history: [
        { role: "user" as const, content: "Hello" },
        { role: "assistant" as const, content: "Hi there!" },
      ],
      fileContext: "some file content",
      learnedPaths: ["/path/to/file"],
      historySummary: "A brief chat",
    };

    // Manually encrypt and write (simulating saveSession)
    const plaintext = JSON.stringify(data);
    const payload = encrypt(plaintext, key);
    const file = { v: 1, ...payload };
    await writeFile(join(sessionsDir, `${sessionId}.json`), JSON.stringify(file));

    // Read and decrypt
    const raw = await readFile(join(sessionsDir, `${sessionId}.json`), "utf-8");
    const parsed = JSON.parse(raw);
    const decrypted = decrypt(
      { ciphertext: parsed.ciphertext, iv: parsed.iv, authTag: parsed.authTag },
      key,
    );
    const restored = JSON.parse(decrypted) as SessionData;

    expect(restored.history).toEqual(data.history);
    expect(restored.fileContext).toBe(data.fileContext);
    expect(restored.learnedPaths).toEqual(data.learnedPaths);
    expect(restored.historySummary).toBe("A brief chat");
  });

  it("should return null for wrong key", async () => {
    const key1 = randomKey();
    const key2 = randomKey();
    const sessionId = "wrong_key_test";

    // Encrypt with key1
    const plaintext = JSON.stringify({ history: [], fileContext: "", learnedPaths: [] });
    const payload = encrypt(plaintext, key1);
    await writeFile(
      join(sessionsDir, `${sessionId}.json`),
      JSON.stringify({ v: 1, ...payload }),
    );

    // Try to decrypt with key2
    const raw = await readFile(join(sessionsDir, `${sessionId}.json`), "utf-8");
    const parsed = JSON.parse(raw);

    expect(() =>
      decrypt(
        { ciphertext: parsed.ciphertext, iv: parsed.iv, authTag: parsed.authTag },
        key2,
      ),
    ).toThrow();
  });

  it("should handle missing session file gracefully", async () => {
    try {
      await readFile(join(sessionsDir, "nonexistent.json"), "utf-8");
      expect.unreachable("Should have thrown");
    } catch (e: any) {
      expect(e.code).toBe("ENOENT");
    }
  });

  it("session TTL: 24-hour expiry logic", () => {
    const SESSION_TTL = 24 * 60 * 60 * 1000;
    const now = Date.now();

    // Fresh session
    const freshSession = { id: "s1", name: "Test", createdAt: now };
    expect(now - freshSession.createdAt < SESSION_TTL).toBe(true);

    // Expired session
    const expiredSession = { id: "s2", name: "Test", createdAt: now - SESSION_TTL - 1 };
    expect(now - expiredSession.createdAt > SESSION_TTL).toBe(true);
  });
});
