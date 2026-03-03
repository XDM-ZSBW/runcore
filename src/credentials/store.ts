/**
 * Credentials store — append-only encrypted JSONL persistence for secrets.
 * Follows ContactStore pattern (src/contacts/store.ts).
 *
 * File: brain/vault/credentials.enc.jsonl
 * Update strategy: append full updated record. On load, last occurrence per id wins.
 * Values stored directly (encrypted at rest via brain-io).
 */

import { join } from "node:path";
import { stat } from "node:fs/promises";
import { createLogger } from "../utils/logger.js";
import { readBrainLines, appendBrainLine, ensureBrainJsonl } from "../lib/brain-io.js";

const log = createLogger("credentials.store");

const SCHEMA = JSON.stringify({ _schema: "credentials", _version: "1.0" });

// ── Types ────────────────────────────────────────────────────────────────────

export type CredentialType = "api_key" | "token" | "oauth" | "password" | "secret";

export interface Credential {
  id: string;
  name: string;
  service: string;
  type: CredentialType;
  value: string;
  envVar?: string;
  notes?: string;
  tags: string[];
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
  lastRotatedAt?: string;
}

export interface CredentialFilter {
  type?: CredentialType;
  status?: "active" | "archived";
  search?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function generateId(): string {
  const ts = Date.now();
  const hex = Math.random().toString(16).slice(2, 10).padEnd(8, "0");
  return `cred_${ts}_${hex}`;
}

/** Mask a secret value: show first 4 + last 4 with **** in between, or •••••••• if short. */
export function maskValue(val: string): string {
  if (!val) return "••••••••";
  if (val.length < 12) return "••••••••";
  return val.slice(0, 4) + "****" + val.slice(-4);
}

// ── Store ────────────────────────────────────────────────────────────────────

export class CredentialStore {
  private readonly filePath: string;
  private cache: Map<string, Credential> | null = null;
  private mtime = 0;
  private lastStaleCheckMs = 0;

  constructor(brainDir: string) {
    this.filePath = join(brainDir, "vault", "credentials.enc.jsonl");
  }

  // ── File management ──────────────────────────────────────────────────────

  private async ensureFile(): Promise<void> {
    await ensureBrainJsonl(this.filePath, SCHEMA);
  }

  private async checkStale(): Promise<void> {
    const now = Date.now();
    if (now - this.lastStaleCheckMs < 5000) return;
    this.lastStaleCheckMs = now;

    try {
      if (this.cache) {
        const s = await stat(this.filePath);
        if (s.mtimeMs > this.mtime) this.cache = null;
      }
    } catch {
      // File may not exist yet
    }
  }

  // ── Load ────────────────────────────────────────────────────────────────

  private async load(): Promise<Map<string, Credential>> {
    await this.checkStale();
    if (this.cache) return this.cache;

    await this.ensureFile();
    const lines = await readBrainLines(this.filePath);
    const map = new Map<string, Credential>();

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj._schema) continue;
        if (!obj.id) continue;
        map.set(obj.id, obj as Credential);
      } catch { continue; }
    }

    this.cache = map;
    try {
      const s = await stat(this.filePath);
      this.mtime = s.mtimeMs;
    } catch { /* ok */ }

    return map;
  }

  private invalidate(): void { this.cache = null; }

  // ── CRUD ────────────────────────────────────────────────────────────────

  async list(filter?: CredentialFilter): Promise<Credential[]> {
    const map = await this.load();
    let creds = Array.from(map.values());

    if (filter?.type) {
      creds = creds.filter((c) => c.type === filter.type);
    }
    if (filter?.status) {
      creds = creds.filter((c) => c.status === filter.status);
    } else {
      creds = creds.filter((c) => c.status !== "archived");
    }
    if (filter?.search) {
      const q = filter.search.toLowerCase();
      creds = creds.filter((c) =>
        c.name.toLowerCase().includes(q) ||
        c.service.toLowerCase().includes(q) ||
        c.tags.some((t) => t.toLowerCase().includes(q))
      );
    }

    creds.sort((a, b) => a.service.localeCompare(b.service) || a.name.localeCompare(b.name));
    return creds;
  }

  async get(id: string): Promise<Credential | null> {
    const map = await this.load();
    return map.get(id) ?? null;
  }

  async create(opts: {
    name: string;
    service: string;
    type: CredentialType;
    value: string;
    envVar?: string;
    notes?: string;
    tags?: string[];
  }): Promise<Credential> {
    const now = new Date().toISOString();
    const cred: Credential = {
      id: generateId(),
      name: opts.name,
      service: opts.service,
      type: opts.type,
      value: opts.value,
      envVar: opts.envVar,
      notes: opts.notes,
      tags: opts.tags ?? [],
      status: "active",
      createdAt: now,
      updatedAt: now,
    };

    await appendBrainLine(this.filePath, JSON.stringify(cred));
    this.invalidate();
    log.info(`Created credential ${cred.id}: ${cred.name} (${cred.service})`);
    return cred;
  }

  async update(
    id: string,
    changes: Partial<Pick<Credential, "name" | "service" | "type" | "value" | "envVar" | "notes" | "tags" | "status" | "lastRotatedAt">>
  ): Promise<Credential | null> {
    const existing = await this.get(id);
    if (!existing) return null;

    const updated: Credential = {
      ...existing,
      ...changes,
      updatedAt: new Date().toISOString(),
    };

    await appendBrainLine(this.filePath, JSON.stringify(updated));
    this.invalidate();
    log.info(`Updated credential ${id}: ${updated.name}`);
    return updated;
  }

  async archive(id: string): Promise<Credential | null> {
    return this.update(id, { status: "archived" });
  }

  // ── Hydrate ─────────────────────────────────────────────────────────────

  /** Inject credentials with envVar into process.env. Called on startup. */
  async hydrate(): Promise<number> {
    const map = await this.load();
    let count = 0;
    for (const cred of map.values()) {
      if (cred.status === "active" && cred.envVar && cred.value) {
        process.env[cred.envVar] = cred.value;
        count++;
      }
    }
    if (count > 0) log.info(`Hydrated ${count} credential(s) into process.env`);
    return count;
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────

let _store: CredentialStore | null = null;

export function createCredentialStore(brainDir: string): CredentialStore {
  if (_store) return _store;
  _store = new CredentialStore(brainDir);
  return _store;
}

export function getCredentialStore(): CredentialStore | null {
  return _store;
}
