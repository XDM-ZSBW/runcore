/**
 * File registry — lightweight file tracking backed by append-only JSONL.
 *
 * Provides a simplified interface over `brain/files/registry.jsonl` for
 * tracking uploaded/managed files. Follows Core's append-only rule:
 * entries are never modified or deleted, only appended.
 *
 * For the full file store with events, versioning, and visibility controls,
 * see `store.ts`. This module is a focused subset for file registration
 * and lookup.
 */

import { readFile, appendFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { createLogger } from "../utils/logger.js";
import { logActivity } from "../activity/log.js";
import { BRAIN_DIR } from "../lib/paths.js";

const log = createLogger("files.registry");

// ── Types ────────────────────────────────────────────────────────────────────

export interface FileRecord {
  id: string;
  filename: string;
  storagePath: string;
  mimeType: string;
  sizeBytes: number;
  checksum: string;
  createdAt: string;
  updatedAt: string;
  tags?: string[];
  source?: string;
  status: "active" | "archived";
  /** Which volume this file physically lives on. Default: "primary". */
  volume?: string;
}

/** Input for registering a new file (system-generated fields omitted). */
export type FileRecordInput = Omit<FileRecord, "id" | "createdAt" | "updatedAt">;

// ── Schema header ────────────────────────────────────────────────────────────

const REGISTRY_SCHEMA = JSON.stringify({
  _schema: "file_record",
  version: 1,
  fields: [
    "id", "filename", "storagePath", "mimeType", "sizeBytes",
    "checksum", "createdAt", "updatedAt", "tags", "source", "status",
  ],
});

// ── Registry class ───────────────────────────────────────────────────────────

export class FileRegistry {
  private cache: Map<string, FileRecord> | null = null;
  private readonly registryPath: string;

  constructor(brainDir: string = BRAIN_DIR) {
    this.registryPath = join(brainDir, "files", "registry.jsonl");
  }

  // ── File I/O helpers ─────────────────────────────────────────────────────

  private async ensureFile(): Promise<void> {
    try {
      await readFile(this.registryPath, "utf-8");
    } catch {
      await mkdir(dirname(this.registryPath), { recursive: true });
      await appendFile(this.registryPath, REGISTRY_SCHEMA + "\n", "utf-8");
    }
  }

  private async load(): Promise<Map<string, FileRecord>> {
    if (this.cache) return this.cache;
    await this.ensureFile();

    log.debug("loading file registry", { filePath: this.registryPath });
    const raw = await readFile(this.registryPath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);

    const map = new Map<string, FileRecord>();
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj._schema) continue;
        map.set(obj.id, obj as FileRecord);
      } catch {
        // skip malformed lines
        continue;
      }
    }

    this.cache = map;
    log.info("file registry loaded", { recordCount: map.size });
    return map;
  }

  private async append(record: FileRecord): Promise<void> {
    await appendFile(this.registryPath, JSON.stringify(record) + "\n", "utf-8");
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Register a new file. System-generated fields (id, createdAt, updatedAt)
   * are populated automatically.
   */
  async register(input: FileRecordInput): Promise<FileRecord> {
    const map = await this.load();
    const now = new Date().toISOString();

    const record: FileRecord = {
      ...input,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
    };

    map.set(record.id, record);
    await this.append(record);

    logActivity({
      source: "system",
      summary: `File registered: ${record.filename} (${formatBytes(record.sizeBytes)})`,
      detail: `id=${record.id} mime=${record.mimeType} source=${record.source ?? "unknown"}`,
    });

    log.info("file registered", {
      id: record.id,
      filename: record.filename,
      mimeType: record.mimeType,
    });

    return record;
  }

  /**
   * List records with optional filtering by status and/or source.
   */
  async list(opts?: { status?: string; source?: string }): Promise<FileRecord[]> {
    const map = await this.load();
    let results = [...map.values()];

    if (opts?.status) {
      results = results.filter((r) => r.status === opts.status);
    }
    if (opts?.source) {
      results = results.filter((r) => r.source === opts.source);
    }

    // Sort newest first
    results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return results;
  }

  /**
   * Get a single record by ID.
   */
  async get(id: string): Promise<FileRecord | null> {
    const map = await this.load();
    return map.get(id) ?? null;
  }

  /**
   * Archive a file by ID. Appends a new entry with status "archived"
   * (append-only — the original line is never modified or deleted).
   */
  async archive(id: string): Promise<FileRecord | null> {
    const map = await this.load();
    const existing = map.get(id);
    if (!existing) return null;
    if (existing.status === "archived") return existing;

    const updated: FileRecord = {
      ...existing,
      status: "archived",
      updatedAt: new Date().toISOString(),
    };

    map.set(id, updated);
    await this.append(updated);

    logActivity({
      source: "system",
      summary: `File archived: ${updated.filename}`,
      detail: `id=${id}`,
    });

    log.info("file archived", { id, filename: existing.filename });
    return updated;
  }

  /**
   * Update tags or source on a file record. Appends a new line (append-only).
   */
  async update(id: string, patch: { tags?: string[]; source?: string }): Promise<FileRecord | null> {
    const map = await this.load();
    const existing = map.get(id);
    if (!existing) return null;

    const updated: FileRecord = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    map.set(id, updated);
    await this.append(updated);

    log.info("file updated", { id, changes: Object.keys(patch) });
    return updated;
  }

  /**
   * Get all unique tags (virtual folders) across all active records.
   */
  async getFolders(): Promise<string[]> {
    const map = await this.load();
    const folders = new Set<string>();
    for (const record of map.values()) {
      if (record.status === "archived") continue;
      for (const tag of record.tags ?? []) {
        if (tag.startsWith("folder:")) {
          folders.add(tag.slice(7));
        }
      }
    }
    return [...folders].sort();
  }

  /**
   * Fuzzy search across filename and tags. Returns records whose filename
   * or any tag contains the query string (case-insensitive).
   */
  async search(query: string): Promise<FileRecord[]> {
    const map = await this.load();
    const q = query.toLowerCase();

    const results: FileRecord[] = [];
    for (const record of map.values()) {
      if (record.status === "archived") continue;

      const filenameMatch = record.filename.toLowerCase().includes(q);
      const tagMatch = record.tags?.some((t) => t.toLowerCase().includes(q)) ?? false;

      if (filenameMatch || tagMatch) {
        results.push(record);
      }
    }

    results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return results;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Compute SHA-256 hex digest for a buffer. */
export function computeChecksum(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Format byte count for human display. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// ── Singleton ────────────────────────────────────────────────────────────────

export const fileRegistry = new FileRegistry();
