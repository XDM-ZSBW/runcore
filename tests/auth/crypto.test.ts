/**
 * Tests for auth/crypto.ts — PBKDF2 key derivation, AES-256-GCM encrypt/decrypt.
 */

import { describe, it, expect } from "vitest";
import { deriveKey, encrypt, decrypt, type EncryptedPayload } from "../../src/auth/crypto.js";
import { randomBytes } from "node:crypto";

describe("deriveKey", () => {
  it("returns a 32-byte buffer", () => {
    const salt = randomBytes(16);
    const key = deriveKey("testpassword", salt);
    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(32);
  });

  it("is deterministic — same input produces same key", () => {
    const salt = randomBytes(16);
    const key1 = deriveKey("hello", salt);
    const key2 = deriveKey("hello", salt);
    expect(key1.equals(key2)).toBe(true);
  });

  it("normalizes input — trims whitespace and lowercases", () => {
    const salt = randomBytes(16);
    const key1 = deriveKey("MyPassword", salt);
    const key2 = deriveKey("  mypassword  ", salt);
    expect(key1.equals(key2)).toBe(true);
  });

  it("produces different keys for different passwords", () => {
    const salt = randomBytes(16);
    const key1 = deriveKey("alpha", salt);
    const key2 = deriveKey("bravo", salt);
    expect(key1.equals(key2)).toBe(false);
  });

  it("produces different keys for different salts", () => {
    const key1 = deriveKey("same", randomBytes(16));
    const key2 = deriveKey("same", randomBytes(16));
    expect(key1.equals(key2)).toBe(false);
  });
});

describe("encrypt + decrypt", () => {
  const salt = randomBytes(16);
  const key = deriveKey("testpassword", salt);

  it("round-trips plaintext", () => {
    const plaintext = "hello world";
    const encrypted = encrypt(plaintext, key);
    const decrypted = decrypt(encrypted, key);
    expect(decrypted).toBe(plaintext);
  });

  it("handles empty string", () => {
    const encrypted = encrypt("", key);
    const decrypted = decrypt(encrypted, key);
    expect(decrypted).toBe("");
  });

  it("handles unicode", () => {
    const text = "こんにちは 🌍 Ñoño";
    const encrypted = encrypt(text, key);
    expect(decrypt(encrypted, key)).toBe(text);
  });

  it("handles large payloads", () => {
    const text = "x".repeat(100_000);
    const encrypted = encrypt(text, key);
    expect(decrypt(encrypted, key)).toBe(text);
  });

  it("produces hex strings in the payload", () => {
    const encrypted = encrypt("test", key);
    expect(encrypted.ciphertext).toMatch(/^[0-9a-f]+$/);
    expect(encrypted.iv).toMatch(/^[0-9a-f]+$/);
    expect(encrypted.authTag).toMatch(/^[0-9a-f]+$/);
  });

  it("produces unique IVs per encryption", () => {
    const e1 = encrypt("same", key);
    const e2 = encrypt("same", key);
    expect(e1.iv).not.toBe(e2.iv);
    expect(e1.ciphertext).not.toBe(e2.ciphertext);
  });

  it("fails with wrong key", () => {
    const encrypted = encrypt("secret", key);
    const wrongKey = deriveKey("wrongpassword", salt);
    expect(() => decrypt(encrypted, wrongKey)).toThrow();
  });

  it("fails with tampered ciphertext", () => {
    const encrypted = encrypt("secret", key);
    const tampered: EncryptedPayload = {
      ...encrypted,
      ciphertext: encrypted.ciphertext.replace(/^./, "0"),
    };
    expect(() => decrypt(tampered, key)).toThrow();
  });

  it("fails with tampered auth tag", () => {
    const encrypted = encrypt("secret", key);
    const tampered: EncryptedPayload = {
      ...encrypted,
      authTag: "00".repeat(16),
    };
    expect(() => decrypt(tampered, key)).toThrow();
  });
});
