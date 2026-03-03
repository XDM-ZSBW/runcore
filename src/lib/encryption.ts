/**
 * Transparent file encryption layer for brain files at rest.
 * Per-line encryption for JSONL (preserves append-only semantics).
 * Whole-file encryption for YAML/MD.
 * Reuses AES-256-GCM primitives from auth/crypto.ts.
 */

import { encrypt, decrypt, type EncryptedPayload } from "../auth/crypto.js";

// --- Per-line encryption (JSONL) ---

/** Compact encrypted line format for JSONL append-only files. */
interface EncryptedLine {
  _e: 1;
  c: string;  // ciphertext (hex)
  iv: string;  // initialization vector (hex)
  t: string;   // auth tag (hex)
}

/** Encrypt a single JSONL line. Returns a JSON string ready for appending. */
export function encryptLine(plaintext: string, key: Buffer): string {
  const payload = encrypt(plaintext, key);
  const line: EncryptedLine = {
    _e: 1,
    c: payload.ciphertext,
    iv: payload.iv,
    t: payload.authTag,
  };
  return JSON.stringify(line);
}

/** Decrypt a single encrypted JSONL line. Throws on tamper or wrong key. */
export function decryptLine(encryptedJson: string, key: Buffer): string {
  const line = JSON.parse(encryptedJson) as EncryptedLine;
  const payload: EncryptedPayload = {
    ciphertext: line.c,
    iv: line.iv,
    authTag: line.t,
  };
  return decrypt(payload, key);
}

/** Check if a raw JSON line is an encrypted line (has _e marker). */
export function isEncryptedLine(line: string): boolean {
  // Fast check before parsing — encrypted lines always start with {"_e":
  return line.startsWith('{"_e":');
}

// --- Whole-file encryption (YAML, MD, etc.) ---

/** Encrypted file wrapper — matches format used by sessions/vault. */
interface EncryptedFile {
  v: 1;
  ciphertext: string;
  iv: string;
  authTag: string;
}

/** Encrypt an entire file's contents. Returns JSON string. */
export function encryptFile(content: string, key: Buffer): string {
  const payload = encrypt(content, key);
  const file: EncryptedFile = {
    v: 1,
    ciphertext: payload.ciphertext,
    iv: payload.iv,
    authTag: payload.authTag,
  };
  return JSON.stringify(file);
}

/** Decrypt an entire encrypted file. Throws on tamper or wrong key. */
export function decryptFile(encryptedJson: string, key: Buffer): string {
  const file = JSON.parse(encryptedJson) as EncryptedFile;
  const payload: EncryptedPayload = {
    ciphertext: file.ciphertext,
    iv: file.iv,
    authTag: file.authTag,
  };
  return decrypt(payload, key);
}

/** Check if file content is an encrypted file (JSON with v:1 marker). */
export function isEncryptedFile(content: string): boolean {
  try {
    const parsed = JSON.parse(content);
    return parsed?.v === 1 && typeof parsed.ciphertext === "string";
  } catch {
    return false;
  }
}
