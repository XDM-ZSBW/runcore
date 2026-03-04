/**
 * Encrypted key vault.
 * Stores API keys as AES-256-GCM encrypted JSON, same key used for sessions.
 * After loading, hydrates process.env so consumer modules need zero changes.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { encrypt, decrypt, type EncryptedPayload } from "../auth/crypto.js";
import { shouldHydrateKey } from "../integrations/gate.js";

const VAULT_DIR = join(process.cwd(), "brain", "vault");
const VAULT_FILE = join(VAULT_DIR, "keys.json");

interface EncryptedFile {
  v: 1;
  ciphertext: string;
  iv: string;
  authTag: string;
}

interface VaultEntry {
  value: string;
  label?: string;
}

type VaultData = Record<string, VaultEntry>;

// In-memory cache — populated by loadVault, read by list/hydrate
let vaultCache: VaultData = {};

/**
 * Load vault from encrypted file, populate cache and hydrate process.env.
 * Safe to call when file doesn't exist (starts empty).
 */
export async function loadVault(key: Buffer): Promise<void> {
  try {
    const raw = await readFile(VAULT_FILE, "utf-8");
    const file: EncryptedFile = JSON.parse(raw);
    const payload: EncryptedPayload = {
      ciphertext: file.ciphertext,
      iv: file.iv,
      authTag: file.authTag,
    };
    const plaintext = decrypt(payload, key);
    vaultCache = JSON.parse(plaintext) as VaultData;
  } catch {
    // File missing, corrupt, or wrong key — start fresh
    vaultCache = {};
  }
  hydrateEnv();
}

/**
 * Encrypt and save the vault cache to disk. Fresh IV on every write.
 */
async function saveVault(key: Buffer): Promise<void> {
  await mkdir(VAULT_DIR, { recursive: true });
  const plaintext = JSON.stringify(vaultCache);
  const payload = encrypt(plaintext, key);
  const file: EncryptedFile = {
    v: 1,
    ciphertext: payload.ciphertext,
    iv: payload.iv,
    authTag: payload.authTag,
  };
  await writeFile(VAULT_FILE, JSON.stringify(file), "utf-8");
}

/**
 * Add or update a key in the vault. Persists immediately.
 */
export async function setVaultKey(
  name: string,
  value: string,
  key: Buffer,
  label?: string,
): Promise<void> {
  vaultCache[name] = { value, label };
  await saveVault(key);
  // Keep process.env in sync — but respect the integration gate
  if (shouldHydrateKey(name)) {
    process.env[name] = value;
  }
}

/**
 * Remove a key from the vault. Persists immediately.
 */
export async function deleteVaultKey(name: string, key: Buffer): Promise<void> {
  delete vaultCache[name];
  await saveVault(key);
  // Remove from process.env (reverts to .env value on next restart)
  delete process.env[name];
}

/**
 * List vault keys — names and labels only, no values.
 */
export function listVaultKeys(): Array<{ name: string; label?: string }> {
  return Object.entries(vaultCache).map(([name, entry]) => ({
    name,
    label: entry.label,
  }));
}

/**
 * Get all vault entries with values. Used for migration to credential store.
 */
export function getVaultEntries(): Array<{ name: string; value: string; label?: string }> {
  return Object.entries(vaultCache).map(([name, entry]) => ({
    name,
    value: entry.value,
    label: entry.label,
  }));
}

/**
 * Get vault entries that the agent (the chat LLM) is allowed to see in conversation.
 * Only keys starting with "CORE_" or "DASH_" are returned — these are non-secret values
 * the user explicitly wants the agent to reference (e.g. preferences, nicknames).
 *
 * SECURITY: Authentication secrets (SAFE_WORD, RECOVERY_QUESTION) are NEVER
 * exposed to the LLM. The safe word is verified at the crypto layer via its
 * SHA-256 hash in human.json — the LLM must never know or repeat it.
 */
const NEVER_EXPOSE = new Set(["SAFE_WORD", "RECOVERY_QUESTION"]);

export function getDashReadableVault(): Array<{ name: string; value: string; label?: string }> {
  return Object.entries(vaultCache)
    .filter(([name]) => (name.startsWith("CORE_") || name.startsWith("DASH_")) && !NEVER_EXPOSE.has(name))
    .map(([name, entry]) => ({ name, value: entry.value, label: entry.label }));
}

/**
 * Push vault values into process.env, filtered by the integration gate.
 * Disabled integrations have their secrets actively removed from process.env.
 * Called after loadVault so consumer modules (LLM, search) pick them up.
 */
export function hydrateEnv(): void {
  for (const [name, entry] of Object.entries(vaultCache)) {
    if (shouldHydrateKey(name)) {
      process.env[name] = entry.value;
    } else {
      // Actively remove blocked keys — they may have been set by a prior hydration
      delete process.env[name];
    }
  }
}
