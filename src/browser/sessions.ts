/**
 * Browser session manager — persist and reuse Playwright storageState per domain.
 *
 * Sessions are stored as AES-256-GCM encrypted JSON in brain/browser/sessions/.
 * Each session is keyed by domain with a 7-day expiry.
 */

import { readFile, writeFile, readdir, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { createLogger } from "../utils/logger.js";
import { getEncryptionKey } from "../lib/key-store.js";
import { BRAIN_DIR } from "../lib/paths.js";

const log = createLogger("browser-sessions");

const SESSIONS_DIR = join(BRAIN_DIR, "browser", "sessions");
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

interface SessionEnvelope {
  domain: string;
  createdAt: string;
  expiresAt: string;
  /** AES-256-GCM IV (hex). */
  iv: string;
  /** AES-256-GCM auth tag (hex). */
  tag: string;
  /** Encrypted storageState JSON (hex). */
  data: string;
}

// ── Crypto helpers ───────────────────────────────────────────────────────────

function deriveSessionKey(): Buffer {
  const masterKey = getEncryptionKey();
  if (!masterKey) throw new Error("No encryption key available — not authenticated");
  // Use first 32 bytes of the master key (AES-256)
  return masterKey.subarray(0, 32);
}

function encrypt(plaintext: string): { iv: string; tag: string; data: string } {
  const key = deriveSessionKey();
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: iv.toString("hex"), tag: tag.toString("hex"), data: encrypted.toString("hex") };
}

function decrypt(iv: string, tag: string, data: string): string {
  const key = deriveSessionKey();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "hex"));
  decipher.setAuthTag(Buffer.from(tag, "hex"));
  return decipher.update(data, "hex", "utf-8") + decipher.final("utf-8");
}

// ── File helpers ─────────────────────────────────────────────────────────────

function sessionPath(domain: string): string {
  // Sanitize domain for filesystem: replace dots/colons with underscores
  const safe = domain.replace(/[^a-zA-Z0-9-]/g, "_");
  return join(SESSIONS_DIR, `${safe}.session.json`);
}

async function ensureDir(): Promise<void> {
  await mkdir(SESSIONS_DIR, { recursive: true });
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Save a Playwright storageState (cookies, localStorage, etc.) for a domain.
 */
export async function saveSession(domain: string, storageState: unknown): Promise<void> {
  await ensureDir();
  const plaintext = JSON.stringify(storageState);
  const { iv, tag, data } = encrypt(plaintext);
  const now = new Date();
  const envelope: SessionEnvelope = {
    domain,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
    iv,
    tag,
    data,
  };
  await writeFile(sessionPath(domain), JSON.stringify(envelope, null, 2), "utf-8");
  log.info(`Saved browser session for ${domain}`);
}

/**
 * Load a stored session for a domain, or null if missing/expired/corrupted.
 */
export async function loadSession(domain: string): Promise<unknown | null> {
  try {
    const raw = await readFile(sessionPath(domain), "utf-8");
    const envelope: SessionEnvelope = JSON.parse(raw);

    // Check expiry
    if (new Date(envelope.expiresAt).getTime() < Date.now()) {
      log.info(`Session expired for ${domain} — removing`);
      await unlink(sessionPath(domain)).catch(() => {});
      return null;
    }

    const plaintext = decrypt(envelope.iv, envelope.tag, envelope.data);
    return JSON.parse(plaintext);
  } catch {
    return null;
  }
}

/**
 * Delete a stored session for a domain.
 */
export async function deleteSession(domain: string): Promise<void> {
  await unlink(sessionPath(domain)).catch(() => {});
  log.info(`Deleted browser session for ${domain}`);
}

/**
 * Purge all expired sessions from disk.
 */
export async function purgeExpiredSessions(): Promise<number> {
  await ensureDir();
  let purged = 0;
  const files = await readdir(SESSIONS_DIR);
  for (const file of files) {
    if (!file.endsWith(".session.json")) continue;
    try {
      const raw = await readFile(join(SESSIONS_DIR, file), "utf-8");
      const envelope: SessionEnvelope = JSON.parse(raw);
      if (new Date(envelope.expiresAt).getTime() < Date.now()) {
        await unlink(join(SESSIONS_DIR, file));
        purged++;
      }
    } catch {
      // Corrupted file — remove it
      await unlink(join(SESSIONS_DIR, file)).catch(() => {});
      purged++;
    }
  }
  if (purged > 0) log.info(`Purged ${purged} expired browser session(s)`);
  return purged;
}
