/**
 * Encrypted session persistence.
 * Saves/loads chat sessions as AES-256-GCM encrypted JSON files.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { encrypt, decrypt, type EncryptedPayload } from "../auth/crypto.js";
import type { ContextMessage } from "../types.js";

const SESSIONS_DIR = join(process.cwd(), "brain", "sessions");

interface EncryptedFile {
  v: 1;
  ciphertext: string;
  iv: string;
  authTag: string;
}

export interface SessionData {
  history: ContextMessage[];
  fileContext: string;
  learnedPaths: string[];
  historySummary?: string;
}

function sessionPath(id: string): string {
  return join(SESSIONS_DIR, `${id}.json`);
}

/**
 * Encrypt and save session data to disk.
 */
export async function saveSession(id: string, data: SessionData, key: Buffer): Promise<void> {
  await mkdir(SESSIONS_DIR, { recursive: true });
  const plaintext = JSON.stringify(data);
  const payload = encrypt(plaintext, key);
  const file: EncryptedFile = {
    v: 1,
    ciphertext: payload.ciphertext,
    iv: payload.iv,
    authTag: payload.authTag,
  };
  await writeFile(sessionPath(id), JSON.stringify(file), "utf-8");
}

/**
 * Load and decrypt session data from disk.
 * Returns null if file missing or decryption fails (wrong key).
 */
export async function loadSession(id: string, key: Buffer): Promise<SessionData | null> {
  try {
    const raw = await readFile(sessionPath(id), "utf-8");
    const file: EncryptedFile = JSON.parse(raw);
    const payload: EncryptedPayload = {
      ciphertext: file.ciphertext,
      iv: file.iv,
      authTag: file.authTag,
    };
    const plaintext = decrypt(payload, key);
    return JSON.parse(plaintext) as SessionData;
  } catch {
    return null;
  }
}
