/**
 * Centralized encrypted I/O for brain files at rest.
 * Brain file reads/writes go through this module for transparent
 * encryption/decryption using AES-256-GCM with the session-derived key.
 * Only files in the ENCRYPTED_FILES set (episodic/personal) are encrypted.
 *
 * Two modes:
 * - Per-line (JSONL): each line encrypted individually, preserving append-only semantics.
 * - Whole-file (YAML, MD, JSON): entire file content encrypted as one blob.
 *
 * Backward compatible: plaintext content passes through on read when no encryption
 * marker is detected. Mixed encrypted/plaintext lines are handled gracefully.
 */

import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { dirname } from "node:path";
import { createLogger } from "../utils/logger.js";
import { getEncryptionKey, getWriteEncryptionKey } from "./key-store.js";
import { logAccess, logAccessSync } from "./audit.js";
import { assertNotLocked } from "./locked.js";

const log = createLogger("brain-io");
import { shouldEncryptFile } from "./encryption-config.js";
import {
  encryptLine,
  decryptLine,
  isEncryptedLine,
  encryptFile,
  decryptFile,
  isEncryptedFile,
} from "./encryption.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Returns the encryption key for reading (decryption) if the file is encrypted, or null. */
function readKey(filePath: string): Buffer | null {
  if (!shouldEncryptFile(filePath)) return null;
  return getEncryptionKey();
}

/** Returns the encryption key for writing if the file should be encrypted AND writes are enabled. */
function writeKey(filePath: string): Buffer | null {
  if (!shouldEncryptFile(filePath)) return null;
  return getWriteEncryptionKey();
}

// ── Async JSONL (per-line) I/O ───────────────────────────────────────────────

/**
 * Read a JSONL file, decrypting each line if needed.
 * Returns raw (decrypted) line strings. Caller is responsible for JSON.parse.
 * Empty/whitespace lines are filtered out.
 */
export async function readBrainLines(filePath: string): Promise<string[]> {
  assertNotLocked(filePath);
  logAccess(filePath, "readBrainLines");
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch {
    return [];
  }

  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const key = readKey(filePath);
  if (!key) return lines;

  return lines.map((line) => {
    if (isEncryptedLine(line)) {
      try {
        return decryptLine(line, key);
      } catch {
        log.debug(`Decryption failed for line in ${filePath} — passing through as-is`);
        return line;
      }
    }
    return line;
  });
}

/**
 * Append a single line to a JSONL file, encrypting if enabled.
 * The line should be a JSON string (not newline-terminated).
 */
export async function appendBrainLine(filePath: string, jsonLine: string): Promise<void> {
  assertNotLocked(filePath);
  const key = writeKey(filePath);
  const line = key ? encryptLine(jsonLine, key) : jsonLine;
  await appendFile(filePath, line + "\n", "utf-8");
}

/**
 * Write an entire JSONL file from an array of JSON strings, encrypting each if enabled.
 * Used for compaction/rotation where the whole file is rewritten.
 */
export async function writeBrainLines(filePath: string, jsonLines: string[]): Promise<void> {
  assertNotLocked(filePath);
  const key = writeKey(filePath);
  const output = jsonLines
    .map((l) => (key ? encryptLine(l, key) : l))
    .join("\n") + "\n";
  await writeFile(filePath, output, "utf-8");
}

// ── Async whole-file I/O (YAML, MD, JSON) ────────────────────────────────────

/**
 * Read a brain file (MD, YAML, JSON), decrypting if it's an encrypted blob.
 * Returns the plaintext content. Falls back to raw content if not encrypted.
 */
export async function readBrainFile(filePath: string): Promise<string> {
  assertNotLocked(filePath);
  logAccess(filePath, "readBrainFile");
  const raw = await readFile(filePath, "utf-8");
  const key = readKey(filePath);
  if (key && isEncryptedFile(raw)) {
    return decryptFile(raw, key);
  }
  return raw;
}

/**
 * Write a brain file (MD, YAML, JSON), encrypting if enabled.
 * Creates parent directories if needed.
 */
export async function writeBrainFile(filePath: string, content: string): Promise<void> {
  assertNotLocked(filePath);
  await mkdir(dirname(filePath), { recursive: true });
  const key = writeKey(filePath);
  const output = key ? encryptFile(content, key) : content;
  await writeFile(filePath, output, "utf-8");
}

// ── Sync JSONL I/O (for activity log and other fire-and-forget paths) ────────

/**
 * Synchronously read a JSONL file, decrypting each line if needed.
 */
export function readBrainLinesSync(filePath: string): string[] {
  assertNotLocked(filePath);
  logAccessSync(filePath, "readBrainLinesSync");
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }

  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const key = readKey(filePath);
  if (!key) return lines;

  return lines.map((line) => {
    if (isEncryptedLine(line)) {
      try {
        return decryptLine(line, key);
      } catch {
        log.debug(`Decryption failed for line in ${filePath} — passing through as-is`);
        return line;
      }
    }
    return line;
  });
}

/**
 * Synchronously append a single line to a JSONL file, encrypting if enabled.
 */
export function appendBrainLineSync(filePath: string, jsonLine: string): void {
  assertNotLocked(filePath);
  const key = writeKey(filePath);
  const line = key ? encryptLine(jsonLine, key) : jsonLine;
  appendFileSync(filePath, line + "\n", "utf-8");
}

/**
 * Synchronously ensure a directory exists.
 */
export function ensureDirSync(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Synchronously ensure a JSONL file exists with a schema header.
 */
export function ensureBrainFileSync(filePath: string, schemaLine: string): void {
  ensureDirSync(dirname(filePath));
  if (!existsSync(filePath)) {
    const key = writeKey(filePath);
    const line = key ? encryptLine(schemaLine, key) : schemaLine;
    appendFileSync(filePath, line + "\n", "utf-8");
  }
}

// ── Async JSONL ensure ───────────────────────────────────────────────────────

/**
 * Ensure a JSONL file exists with a schema header line (encrypted if applicable).
 */
export async function ensureBrainJsonl(filePath: string, schemaLine: string): Promise<void> {
  try {
    await readFile(filePath, "utf-8");
  } catch {
    await mkdir(dirname(filePath), { recursive: true });
    const key = writeKey(filePath);
    const line = key ? encryptLine(schemaLine, key) : schemaLine;
    await appendFile(filePath, line + "\n", "utf-8");
  }
}
