/**
 * Personal data vault — encrypted JSONL store for form-filling fields.
 *
 * Stores personal data (name, address, SSN, etc.) as per-line encrypted JSONL
 * via brain-io. Each entry has a field key, value, category, and timestamp.
 *
 * SECURITY:
 * - All data encrypted at rest via AES-256-GCM (brain-io handles this).
 * - Values are NEVER exposed in logs, prompts, or LLM context.
 * - Only field names and categories are surfaced to the LLM; retrieval
 *   of actual values happens through action blocks, not context injection.
 */

import { join } from "node:path";
import {
  readBrainLines,
  writeBrainLines,
  appendBrainLine,
  ensureBrainJsonl,
} from "../lib/brain-io.js";
import { BRAIN_DIR } from "../lib/paths.js";

const VAULT_DIR = join(BRAIN_DIR, "vault");
const VAULT_FILE = join(VAULT_DIR, "personal.enc.jsonl");

const SCHEMA_LINE = JSON.stringify({
  _schema: "personal-vault",
  _version: "1.0",
  _description:
    "Encrypted personal data for form filling. One JSON object per line. Append-only.",
});

// ── Types ────────────────────────────────────────────────────────────────────

export type VaultCategory =
  | "identity"
  | "contact"
  | "financial"
  | "medical"
  | "credentials";

export interface VaultEntry {
  field: string;
  value: string;
  category: VaultCategory;
  updatedAt: string; // ISO 8601
  /** Soft-delete marker. Archived entries are filtered out on read. */
  status?: "active" | "archived";
}

// ── In-memory cache ──────────────────────────────────────────────────────────

/** Field → latest entry. Rebuilt on load, updated on set/delete. */
let cache: Map<string, VaultEntry> = new Map();
let loaded = false;

// ── Internal helpers ─────────────────────────────────────────────────────────

function isVaultEntry(obj: unknown): obj is VaultEntry {
  if (!obj || typeof obj !== "object") return false;
  const e = obj as Record<string, unknown>;
  return (
    typeof e.field === "string" &&
    typeof e.value === "string" &&
    typeof e.category === "string" &&
    typeof e.updatedAt === "string"
  );
}

/** Load all entries from disk, dedup by field (latest wins), filter archived. */
async function hydrate(): Promise<void> {
  await ensureBrainJsonl(VAULT_FILE, SCHEMA_LINE);
  const lines = await readBrainLines(VAULT_FILE);
  cache = new Map();

  for (const line of lines) {
    try {
      const parsed: unknown = JSON.parse(line);
      // Skip schema header
      if (parsed && typeof parsed === "object" && "_schema" in parsed) continue;
      if (!isVaultEntry(parsed)) continue;
      if (parsed.status === "archived") {
        cache.delete(parsed.field);
      } else {
        cache.set(parsed.field, parsed);
      }
    } catch {
      // Skip malformed lines
    }
  }
  loaded = true;
}

/** Ensure cache is hydrated before reads. */
async function ensureLoaded(): Promise<void> {
  if (!loaded) await hydrate();
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Initialize the personal vault. Call once at startup after encryption key is set.
 */
export async function loadPersonalVault(): Promise<void> {
  await hydrate();
}

/**
 * Get a single vault entry by exact field name.
 * Returns the entry (with value) or null.
 */
export async function getPersonalField(
  field: string,
): Promise<VaultEntry | null> {
  await ensureLoaded();
  return cache.get(field) ?? null;
}

/**
 * Set (create or update) a personal data field.
 * Appends a new line to the JSONL file (append-only).
 */
export async function setPersonalField(
  field: string,
  value: string,
  category: VaultCategory,
): Promise<VaultEntry> {
  await ensureLoaded();
  const entry: VaultEntry = {
    field,
    value,
    category,
    updatedAt: new Date().toISOString(),
    status: "active",
  };
  await appendBrainLine(VAULT_FILE, JSON.stringify(entry));
  cache.set(field, entry);
  return entry;
}

/**
 * List all active entries, optionally filtered by category.
 * Returns field names and categories only — values are redacted.
 */
export async function listPersonalFields(
  category?: VaultCategory,
): Promise<Array<{ field: string; category: VaultCategory; updatedAt: string }>> {
  await ensureLoaded();
  const results: Array<{
    field: string;
    category: VaultCategory;
    updatedAt: string;
  }> = [];
  for (const entry of cache.values()) {
    if (category && entry.category !== category) continue;
    results.push({
      field: entry.field,
      category: entry.category,
      updatedAt: entry.updatedAt,
    });
  }
  return results;
}

/**
 * Soft-delete a field by appending an archived entry.
 */
export async function deletePersonalField(field: string): Promise<boolean> {
  await ensureLoaded();
  const existing = cache.get(field);
  if (!existing) return false;

  const tombstone: VaultEntry = {
    ...existing,
    updatedAt: new Date().toISOString(),
    status: "archived",
  };
  await appendBrainLine(VAULT_FILE, JSON.stringify(tombstone));
  cache.delete(field);
  return true;
}

/**
 * Get multiple fields by name. Returns a map of field → value.
 * This is the retrieval path for form-filling — values are returned
 * but must NEVER be forwarded to logs or LLM context.
 */
export async function getPersonalFields(
  fields: string[],
): Promise<Map<string, string>> {
  await ensureLoaded();
  const result = new Map<string, string>();
  for (const f of fields) {
    const entry = cache.get(f);
    if (entry) result.set(f, entry.value);
  }
  return result;
}

/**
 * Compact the vault file — rewrite with only the latest active entries.
 * Call periodically to reclaim space from archived/superseded entries.
 */
export async function compactPersonalVault(): Promise<number> {
  await ensureLoaded();
  const lines: string[] = [SCHEMA_LINE];
  for (const entry of cache.values()) {
    lines.push(JSON.stringify(entry));
  }
  await writeBrainLines(VAULT_FILE, lines);
  return cache.size;
}
