/**
 * Encryption primitives for session persistence.
 * AES-256-GCM with PBKDF2-derived keys. Node built-ins only.
 */

import { pbkdf2Sync, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

export interface EncryptedPayload {
  ciphertext: string; // hex
  iv: string;         // hex
  authTag: string;    // hex
}

const ITERATIONS = 600_000;
const KEY_LENGTH = 32; // 256 bits
const DIGEST = "sha256";
const IV_LENGTH = 12;  // 96 bits for GCM

/**
 * Derive a 256-bit AES key from a safe word and salt via PBKDF2.
 */
export function deriveKey(safeWord: string, salt: Buffer): Buffer {
  return pbkdf2Sync(safeWord.trim().toLowerCase(), salt, ITERATIONS, KEY_LENGTH, DIGEST);
}

/**
 * Encrypt plaintext with AES-256-GCM.
 */
export function encrypt(plaintext: string, key: Buffer): EncryptedPayload {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: encrypted.toString("hex"),
    iv: iv.toString("hex"),
    authTag: authTag.toString("hex"),
  };
}

/**
 * Decrypt an AES-256-GCM payload. Throws on tamper or wrong key.
 */
export function decrypt(payload: EncryptedPayload, key: Buffer): string {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(payload.iv, "hex")
  );
  decipher.setAuthTag(Buffer.from(payload.authTag, "hex"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "hex")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}
