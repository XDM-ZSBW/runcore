/**
 * Pairing ceremony + auth for Core's human partner.
 * Handles: pairing code generation, safe word hashing, recovery, session management.
 */

import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { deriveKey } from "./crypto.js";

// --- Types ---

export interface HumanIdentity {
  name: string;
  safeWordHash: string;
  pbkdf2Salt?: string; // hex, 16 bytes — added for session encryption
  recovery: {
    question: string;
    answerHash: string;
  };
  pairedAt: string;
}

export interface PairingCode {
  code: string;
  createdAt: string;
}

export interface Session {
  id: string;
  name: string;
  createdAt: number;
}

// --- Paths ---

const IDENTITY_DIR = join(process.cwd(), "brain", "identity");
const HUMAN_PATH = join(IDENTITY_DIR, "human.json");
const PAIRING_CODE_PATH = join(IDENTITY_DIR, "pairing-code.json");
const SESSION_KEY_CACHE_PATH = join(IDENTITY_DIR, ".session-key");

// --- Helpers ---

function sha256(input: string): string {
  return createHash("sha256").update(input.trim().toLowerCase()).digest("hex");
}

function generateSessionId(): string {
  return randomBytes(24).toString("hex");
}

/**
 * Deterministic session ID derived from safe word hash.
 * Same safe word always produces the same session ID, so encrypted
 * session files survive server restarts. Changes on recovery (new safe word).
 */
function stableSessionId(safeWordHash: string): string {
  return createHash("sha256").update(safeWordHash + ":session").digest("hex").slice(0, 48);
}

const WORD_LIST = [
  "amber", "castle", "seven", "river", "oak", "noon",
  "storm", "velvet", "coral", "maple", "frost", "dawn",
  "iron", "sage", "dune", "echo", "flint", "grove",
  "haze", "jade", "knot", "lark", "moss", "nova",
  "opal", "pine", "quill", "reed", "silk", "tide",
  "vale", "wren", "zinc", "arch", "bloom", "crest",
  "drift", "elm", "forge", "glen", "hawk", "isle",
  "jest", "keel", "lime", "mist", "nest", "orbit",
  "peak", "rust", "shard", "thorn", "umber", "veil",
  "whisk", "yarn", "zeal", "bolt", "clay", "dusk",
];

function generatePairingCode(): string {
  const words: string[] = [];
  for (let i = 0; i < 6; i++) {
    const idx = Math.floor(Math.random() * WORD_LIST.length);
    words.push(WORD_LIST[idx]);
  }
  return words.join("-");
}

// --- Session store (in-memory) ---

const sessions = new Map<string, Session>();

// Sessions expire after 24 hours
const SESSION_TTL = 24 * 60 * 60 * 1000;

export function validateSession(sessionId: string): Session | null {
  const session = sessions.get(sessionId);
  if (!session) return null;
  if (Date.now() - session.createdAt > SESSION_TTL) {
    sessions.delete(sessionId);
    return null;
  }
  return session;
}

function createSession(name: string, id?: string): Session {
  const session: Session = {
    id: id ?? generateSessionId(),
    name,
    createdAt: Date.now(),
  };
  sessions.set(session.id, session);
  return session;
}

// --- Identity file operations ---

async function ensureDir(): Promise<void> {
  await mkdir(IDENTITY_DIR, { recursive: true });
}

export async function readHuman(): Promise<HumanIdentity | null> {
  try {
    const raw = await readFile(HUMAN_PATH, "utf-8");
    return JSON.parse(raw) as HumanIdentity;
  } catch {
    return null;
  }
}

async function writeHuman(identity: HumanIdentity): Promise<void> {
  await ensureDir();
  await writeFile(HUMAN_PATH, JSON.stringify(identity, null, 2), "utf-8");
}

async function readPairingCode(): Promise<PairingCode | null> {
  try {
    const raw = await readFile(PAIRING_CODE_PATH, "utf-8");
    return JSON.parse(raw) as PairingCode;
  } catch {
    return null;
  }
}

async function writePairingCode(pc: PairingCode): Promise<void> {
  await ensureDir();
  await writeFile(PAIRING_CODE_PATH, JSON.stringify(pc, null, 2), "utf-8");
}

async function consumePairingCode(): Promise<void> {
  try {
    await unlink(PAIRING_CODE_PATH);
  } catch {
    // Already gone
  }
}

// --- Key derivation helpers ---

function generateSalt(): string {
  return randomBytes(16).toString("hex");
}

/** Ensure human has a salt (backward compat). Returns the salt and derived key. */
async function ensureSaltAndDeriveKey(
  human: HumanIdentity,
  safeWord: string
): Promise<{ salt: string; sessionKey: Buffer }> {
  let salt = human.pbkdf2Salt;
  if (!salt) {
    salt = generateSalt();
    human.pbkdf2Salt = salt;
    await writeHuman(human);
  }
  const sessionKey = deriveKey(safeWord, Buffer.from(salt, "hex"));
  return { salt, sessionKey };
}

/** Cache the session key to disk so it survives server restarts. */
export async function cacheSessionKey(key: Buffer): Promise<void> {
  try {
    await ensureDir();
    await writeFile(SESSION_KEY_CACHE_PATH, key.toString("hex"), "utf-8");
  } catch {}
}

/** Read cached session key from disk. Returns null if not found. */
async function loadCachedSessionKey(): Promise<Buffer | null> {
  try {
    const hex = (await readFile(SESSION_KEY_CACHE_PATH, "utf-8")).trim();
    if (hex.length !== 64) return null; // 32 bytes = 64 hex chars
    return Buffer.from(hex, "hex");
  } catch {
    return null;
  }
}

/**
 * Restore session + cached key at startup (survives server restarts).
 * Returns the session and key if both can be restored.
 */
export async function restoreSession(): Promise<{ session: Session; sessionKey: Buffer } | null> {
  const human = await readHuman();
  if (!human) return null;
  const id = stableSessionId(human.safeWordHash);
  // Only restore if not already in memory
  const existing = sessions.get(id);
  const session = existing ?? createSession(human.name, id);
  const sessionKey = await loadCachedSessionKey();
  if (!sessionKey) return null;
  return { session, sessionKey };
}

// --- Public API ---

/**
 * Get current status: is Core paired? Does it need a pairing code entered?
 */
export async function getStatus(): Promise<{ paired: boolean; needsCode: boolean }> {
  const human = await readHuman();
  if (human) return { paired: true, needsCode: false };
  const code = await readPairingCode();
  return { paired: false, needsCode: code !== null };
}

/**
 * Called at server startup. If no human.json and no pairing-code.json,
 * generates a new pairing code and returns it (for printing to terminal).
 * Returns null if already paired or code already exists.
 */
export async function ensurePairingCode(): Promise<string | null> {
  const human = await readHuman();
  if (human) return null; // Already paired

  const existing = await readPairingCode();
  if (existing) return existing.code; // Code already generated

  const code = generatePairingCode();
  await writePairingCode({ code, createdAt: new Date().toISOString() });
  return code;
}

/**
 * Complete the pairing ceremony: verify code, create human identity, return session.
 */
export async function pair(input: {
  code: string;
  name: string;
  safeWord: string;
  recoveryQuestion?: string;
  recoveryAnswer?: string;
  skipCodeCheck?: boolean;
}): Promise<{ session: Session; sessionKey: Buffer } | { error: string }> {
  // Check not already paired
  const human = await readHuman();
  if (human) return { error: "Already paired" };

  if (!input.skipCodeCheck) {
    // Verify pairing code
    const stored = await readPairingCode();
    if (!stored) return { error: "No pairing code found — restart the server" };
    if (input.code.trim().toLowerCase() !== stored.code) {
      return { error: "Invalid pairing code" };
    }
  }

  // Create identity with salt for session encryption
  const salt = generateSalt();
  const identity: HumanIdentity = {
    name: input.name.trim(),
    safeWordHash: sha256(input.safeWord),
    pbkdf2Salt: salt,
    recovery: input.recoveryQuestion && input.recoveryAnswer ? {
      question: input.recoveryQuestion.trim(),
      answerHash: sha256(input.recoveryAnswer),
    } : undefined as any,
    pairedAt: new Date().toISOString(),
  };

  await writeHuman(identity);
  await consumePairingCode();

  const sessionKey = deriveKey(input.safeWord, Buffer.from(salt, "hex"));
  const session = createSession(identity.name, stableSessionId(identity.safeWordHash));
  return { session, sessionKey };
}

/**
 * Authenticate with safe word on return visits.
 */
export async function authenticate(safeWord: string): Promise<{ session: Session; name: string; sessionKey: Buffer } | { error: string }> {
  const human = await readHuman();
  if (!human) return { error: "Not paired yet" };

  if (sha256(safeWord) !== human.safeWordHash) {
    return { error: "Wrong safe word" };
  }

  const { sessionKey } = await ensureSaltAndDeriveKey(human, safeWord);
  const session = createSession(human.name, stableSessionId(human.safeWordHash));
  return { session, name: human.name, sessionKey };
}

/**
 * Get recovery question (for display).
 */
export async function getRecoveryQuestion(): Promise<string | null> {
  const human = await readHuman();
  return human?.recovery.question ?? null;
}

/**
 * Recover: verify recovery answer, set new safe word.
 */
export async function recover(answer: string, newSafeWord: string): Promise<{ session: Session; name: string; sessionKey: Buffer } | { error: string }> {
  const human = await readHuman();
  if (!human) return { error: "Not paired yet" };

  if (sha256(answer) !== human.recovery.answerHash) {
    return { error: "Wrong answer" };
  }

  // Update safe word and regenerate salt (old sessions unreadable — intentional)
  human.safeWordHash = sha256(newSafeWord);
  const salt = generateSalt();
  human.pbkdf2Salt = salt;
  await writeHuman(human);

  const sessionKey = deriveKey(newSafeWord, Buffer.from(salt, "hex"));
  const session = createSession(human.name, stableSessionId(human.safeWordHash));
  return { session, name: human.name, sessionKey };
}
