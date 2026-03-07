/**
 * Vault portable export/import.
 *
 * DPAPI ties session keys to the Windows user profile, making vault secrets
 * non-portable. This module provides passphrase-based export/import so
 * secrets can move across machines and operating systems.
 *
 * Export format: self-describing JSON envelope (.vault) with AES-256-GCM
 * encrypted payload, key derived via PBKDF2 from a case-sensitive passphrase.
 */

import { pbkdf2Sync, randomBytes, createHash } from "node:crypto";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { encrypt, decrypt, type EncryptedPayload } from "../auth/crypto.js";
import { getVaultEntries, setVaultKey } from "./store.js";
import { readBrainLines, appendBrainLine } from "../lib/brain-io.js";
import { getEncryptionKey } from "../lib/key-store.js";
import { getInstanceName } from "../instance.js";
import type { Credential } from "../credentials/store.js";
import type { VaultEntry } from "./personal.js";
import { BRAIN_DIR } from "../lib/paths.js";

// ── Constants ────────────────────────────────────────────────────────────────

const VAULT_DIR = join(BRAIN_DIR, "vault");
const CRED_FILE = join(BRAIN_DIR, "vault", "credentials.enc.jsonl");
const PERSONAL_FILE = join(BRAIN_DIR, "vault", "personal.enc.jsonl");

const FORMAT = "core-vault-export";
const VERSION = 1;
const ITERATIONS = 600_000;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

// ── Types ────────────────────────────────────────────────────────────────────

interface VaultKeyEntry {
  name: string;
  value: string;
  label?: string;
}

interface VaultExportPayload {
  vaultKeys: VaultKeyEntry[];
  credentials: Credential[];
  personalFields: VaultEntry[];
}

interface VaultExportEnvelope {
  format: string;
  version: number;
  exportedAt: string;
  sourceInstance: string;
  salt: string;
  iterations: number;
  keyHash: string;
  payload: EncryptedPayload;
}

export interface ExportStats {
  vaultKeys: number;
  credentials: number;
  personalFields: number;
}

export interface ExportResult {
  filePath: string;
  stats: ExportStats;
}

export interface ImportResult {
  stats: ExportStats & { skipped: number };
}

export interface VerifyResult {
  message: string;
  stats: ExportStats;
}

export type ConflictStrategy = "overwrite" | "skip" | "rename";

// ── Key derivation (case-sensitive, unlike safe word) ────────────────────────

function deriveExportKey(passphrase: string, salt: Buffer): Buffer {
  return pbkdf2Sync(passphrase, salt, ITERATIONS, KEY_LENGTH, "sha256");
}

function hashKey(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex");
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Read JSONL entries, skipping schema headers. */
async function readJsonlEntries<T>(filePath: string): Promise<T[]> {
  const lines = await readBrainLines(filePath);
  const entries: T[] = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj._schema) continue;
      entries.push(obj as T);
    } catch {
      // skip malformed
    }
  }
  return entries;
}

/** Deduplicate credentials by id (last occurrence wins), filter active only. */
function deduplicateCredentials(creds: Credential[]): Credential[] {
  const map = new Map<string, Credential>();
  for (const c of creds) {
    if (c.id) map.set(c.id, c);
  }
  return Array.from(map.values()).filter((c) => c.status !== "archived");
}

/** Deduplicate personal fields by field name (last wins), filter active. */
function deduplicatePersonal(entries: VaultEntry[]): VaultEntry[] {
  const map = new Map<string, VaultEntry>();
  for (const e of entries) {
    if (e.status === "archived") {
      map.delete(e.field);
    } else {
      map.set(e.field, e);
    }
  }
  return Array.from(map.values());
}

// ── Export ────────────────────────────────────────────────────────────────────

export async function exportVault(
  passphrase: string,
  outputDir?: string,
): Promise<ExportResult> {
  const sessionKey = getEncryptionKey();
  if (!sessionKey) throw new Error("Not authenticated — session key not set");

  // Collect secrets
  const vaultKeys = getVaultEntries();
  const rawCredentials = await readJsonlEntries<Credential>(CRED_FILE);
  const credentials = deduplicateCredentials(rawCredentials);
  const rawPersonal = await readJsonlEntries<VaultEntry>(PERSONAL_FILE);
  const personalFields = deduplicatePersonal(rawPersonal);

  const payload: VaultExportPayload = { vaultKeys, credentials, personalFields };

  // Derive export key (case-sensitive)
  const salt = randomBytes(SALT_LENGTH);
  const exportKey = deriveExportKey(passphrase, salt);
  const keyHash = hashKey(exportKey);

  // Encrypt
  const encrypted = encrypt(JSON.stringify(payload), exportKey);

  const envelope: VaultExportEnvelope = {
    format: FORMAT,
    version: VERSION,
    exportedAt: new Date().toISOString(),
    sourceInstance: getInstanceName(),
    salt: salt.toString("hex"),
    iterations: ITERATIONS,
    keyHash,
    payload: encrypted,
  };

  // Write file
  const dir = outputDir ?? VAULT_DIR;
  await mkdir(dir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = join(dir, `export-${timestamp}.vault`);
  await writeFile(filePath, JSON.stringify(envelope, null, 2), "utf-8");

  return {
    filePath,
    stats: {
      vaultKeys: vaultKeys.length,
      credentials: credentials.length,
      personalFields: personalFields.length,
    },
  };
}

// ── Verify ───────────────────────────────────────────────────────────────────

export async function verifyExport(
  filePath: string,
  passphrase: string,
): Promise<VerifyResult> {
  const payload = await decryptEnvelope(filePath, passphrase);
  return {
    message: "Export verified successfully",
    stats: {
      vaultKeys: payload.vaultKeys.length,
      credentials: payload.credentials.length,
      personalFields: payload.personalFields.length,
    },
  };
}

// ── Import ───────────────────────────────────────────────────────────────────

export async function importVault(
  filePath: string,
  passphrase: string,
  strategy: ConflictStrategy = "skip",
  sessionKey: Buffer,
): Promise<ImportResult> {
  const payload = await decryptEnvelope(filePath, passphrase);
  let skipped = 0;

  // Import vault keys
  const existingKeys = new Set(getVaultEntries().map((e) => e.name));
  for (const entry of payload.vaultKeys) {
    if (existingKeys.has(entry.name)) {
      if (strategy === "skip") { skipped++; continue; }
      if (strategy === "rename") {
        const renamed = `${entry.name}_imported`;
        await setVaultKey(renamed, entry.value, sessionKey, entry.label);
        continue;
      }
      // overwrite — fall through
    }
    await setVaultKey(entry.name, entry.value, sessionKey, entry.label);
  }

  // Import credentials (append-only JSONL)
  for (const cred of payload.credentials) {
    await appendBrainLine(CRED_FILE, JSON.stringify(cred));
  }

  // Import personal fields (append-only JSONL)
  for (const field of payload.personalFields) {
    await appendBrainLine(PERSONAL_FILE, JSON.stringify(field));
  }

  return {
    stats: {
      vaultKeys: payload.vaultKeys.length,
      credentials: payload.credentials.length,
      personalFields: payload.personalFields.length,
      skipped,
    },
  };
}

// ── Shared decrypt ───────────────────────────────────────────────────────────

async function decryptEnvelope(
  filePath: string,
  passphrase: string,
): Promise<VaultExportPayload> {
  const raw = await readFile(filePath, "utf-8");
  const envelope: VaultExportEnvelope = JSON.parse(raw);

  if (envelope.format !== FORMAT) {
    throw new Error(`Unknown export format: ${envelope.format}`);
  }
  if (envelope.version !== VERSION) {
    throw new Error(`Unsupported export version: ${envelope.version}`);
  }

  const salt = Buffer.from(envelope.salt, "hex");
  const exportKey = deriveExportKey(passphrase, salt);

  // Fast wrong-passphrase detection
  if (hashKey(exportKey) !== envelope.keyHash) {
    throw new Error("Wrong passphrase");
  }

  const plaintext = decrypt(envelope.payload, exportKey);
  return JSON.parse(plaintext) as VaultExportPayload;
}
