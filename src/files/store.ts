/**
 * File store — append-only JSONL persistence for FileEntry and FileEvent.
 * Follows src/queue/store.ts pattern: in-memory Map cache, last-occurrence-wins.
 *
 * Files:
 *   brain/files/registry.jsonl — file metadata
 *   brain/files/events.jsonl   — audit trail
 */

import { readFile, appendFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { createLogger } from "../utils/logger.js";
import type {
  FileEntry,
  FileEvent,
  FileAction,
  FileFilter,
  FileCategory,
  StorageUsage,
} from "./types.js";

const log = createLogger("files.store");

const REGISTRY_SCHEMA = JSON.stringify({
  _schema: "file",
  version: 1,
  fields: [
    "id", "name", "slug", "mimeType", "sizeBytes", "category", "tags",
    "origin", "ownerId", "taskId", "parentId", "version", "storagePath",
    "checksum", "encrypted", "visibility", "status", "textPreview", "meta",
    "createdAt", "updatedAt",
  ],
});

const EVENTS_SCHEMA = JSON.stringify({
  _schema: "file_event",
  version: 1,
  fields: ["id", "fileId", "action", "actor", "detail", "timestamp"],
});

/** Generate a file ID: file_<timestamp>_<8-hex>. */
export function generateFileId(): string {
  const ts = Date.now();
  const rand = randomBytes(4).toString("hex");
  return `file_${ts}_${rand}`;
}

/** Generate an event ID: evt_<timestamp>_<8-hex>. */
function generateEventId(): string {
  const ts = Date.now();
  const rand = randomBytes(4).toString("hex");
  return `evt_${ts}_${rand}`;
}

/** Compute SHA-256 hex digest for a buffer. */
export function computeChecksum(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export class FileStore {
  private cache: Map<string, FileEntry> | null = null;
  private readonly registryPath: string;
  private readonly eventsPath: string;

  constructor(brainDir: string) {
    this.registryPath = join(brainDir, "files", "registry.jsonl");
    this.eventsPath = join(brainDir, "files", "events.jsonl");
  }

  // ── File I/O helpers ────────────────────────────────────────────────────

  private async ensureFile(filePath: string, schemaLine: string): Promise<void> {
    try {
      await readFile(filePath, "utf-8");
    } catch {
      await mkdir(dirname(filePath), { recursive: true });
      await appendFile(filePath, schemaLine + "\n", "utf-8");
    }
  }

  private async load(): Promise<Map<string, FileEntry>> {
    if (this.cache) return this.cache;
    await this.ensureFile(this.registryPath, REGISTRY_SCHEMA);

    log.debug("loading file registry", { filePath: this.registryPath });
    const raw = await readFile(this.registryPath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);

    const map = new Map<string, FileEntry>();
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj._schema) continue;
        map.set(obj.id, obj as FileEntry);
      } catch {
        continue;
      }
    }

    this.cache = map;
    log.info("file registry loaded", { fileCount: map.size });
    return map;
  }

  private async appendRegistry(entry: FileEntry): Promise<void> {
    await appendFile(this.registryPath, JSON.stringify(entry) + "\n", "utf-8");
  }

  private async appendEvent(event: FileEvent): Promise<void> {
    await this.ensureFile(this.eventsPath, EVENTS_SCHEMA);
    await appendFile(this.eventsPath, JSON.stringify(event) + "\n", "utf-8");
  }

  // ── Event logging ─────────────────────────────────────────────────────

  async logEvent(fileId: string, action: FileAction, actor: string, detail?: string): Promise<FileEvent> {
    const event: FileEvent = {
      id: generateEventId(),
      fileId,
      action,
      actor,
      detail,
      timestamp: new Date().toISOString(),
    };
    await this.appendEvent(event);
    log.debug("file event logged", { fileId, action, actor });
    return event;
  }

  // ── CRUD ──────────────────────────────────────────────────────────────

  async list(filter?: FileFilter): Promise<FileEntry[]> {
    const map = await this.load();
    let results = [...map.values()].filter((f) => f.status !== "quarantined");

    if (filter) {
      if (filter.category) results = results.filter((f) => f.category === filter.category);
      if (filter.origin) results = results.filter((f) => f.origin === filter.origin);
      if (filter.status) results = results.filter((f) => f.status === filter.status);
      if (filter.taskId) results = results.filter((f) => f.taskId === filter.taskId);
      if (filter.tags?.length) {
        results = results.filter((f) =>
          filter.tags!.some((t) => f.tags.includes(t)),
        );
      }
      if (filter.folderId) {
        results = results.filter((f) => f.meta?.folderId === filter.folderId);
      }
      if (filter.search) {
        const q = filter.search.toLowerCase();
        results = results.filter(
          (f) =>
            f.name.toLowerCase().includes(q) ||
            f.tags.some((t) => t.toLowerCase().includes(q)) ||
            f.textPreview?.toLowerCase().includes(q),
        );
      }
    }

    // Default: exclude archived unless explicitly requested
    if (!filter?.status) {
      results = results.filter((f) => f.status !== "archived");
    }

    results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    if (filter?.offset) results = results.slice(filter.offset);
    if (filter?.limit) results = results.slice(0, filter.limit);

    return results;
  }

  async get(id: string): Promise<FileEntry | null> {
    const map = await this.load();
    return map.get(id) ?? null;
  }

  async create(
    fields: Omit<FileEntry, "id" | "createdAt" | "updatedAt">,
  ): Promise<FileEntry> {
    await this.load();
    const now = new Date().toISOString();
    const entry: FileEntry = {
      ...fields,
      id: generateFileId(),
      createdAt: now,
      updatedAt: now,
    };
    this.cache!.set(entry.id, entry);
    await this.appendRegistry(entry);
    await this.logEvent(entry.id, "created", fields.ownerId ?? "system");
    log.info("file created", { id: entry.id, name: entry.name, category: entry.category });
    return entry;
  }

  async update(id: string, patch: Partial<FileEntry>): Promise<FileEntry | null> {
    const map = await this.load();
    const existing = map.get(id);
    if (!existing) return null;

    const mergedMeta = patch.meta
      ? { ...(existing.meta ?? {}), ...patch.meta }
      : existing.meta;
    const updated: FileEntry = {
      ...existing,
      ...patch,
      meta: mergedMeta,
      id: existing.id, // prevent overwrite
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };
    map.set(id, updated);
    await this.appendRegistry(updated);
    await this.logEvent(id, "updated", "system");
    log.debug("file updated", { id, changes: Object.keys(patch) });
    return updated;
  }

  async archive(id: string, actor: string): Promise<{ ok: boolean; message: string }> {
    const map = await this.load();
    const existing = map.get(id);
    if (!existing) return { ok: false, message: `File not found: ${id}` };
    if (existing.status === "archived") return { ok: true, message: "Already archived" };

    const updated: FileEntry = {
      ...existing,
      status: "archived",
      updatedAt: new Date().toISOString(),
    };
    map.set(id, updated);
    await this.appendRegistry(updated);
    await this.logEvent(id, "archived", actor);
    log.info("file archived", { id, name: existing.name });
    return { ok: true, message: `Archived: ${existing.name}` };
  }

  async restore(id: string, actor: string): Promise<{ ok: boolean; message: string }> {
    const map = await this.load();
    const existing = map.get(id);
    if (!existing) return { ok: false, message: `File not found: ${id}` };
    if (existing.status !== "archived") return { ok: true, message: "Not archived" };

    const updated: FileEntry = {
      ...existing,
      status: "active",
      updatedAt: new Date().toISOString(),
    };
    map.set(id, updated);
    await this.appendRegistry(updated);
    await this.logEvent(id, "restored", actor);
    log.info("file restored", { id, name: existing.name });
    return { ok: true, message: `Restored: ${existing.name}` };
  }

  // ── Storage metrics ───────────────────────────────────────────────────

  async getStorageUsage(): Promise<StorageUsage> {
    const map = await this.load();
    const cats: FileCategory[] = [
      "upload", "report", "template", "attachment", "export",
      "resume", "media", "ingest", "other",
    ];
    const byCategory = Object.fromEntries(cats.map((c) => [c, 0])) as Record<FileCategory, number>;
    let totalBytes = 0;
    let fileCount = 0;

    for (const entry of map.values()) {
      if (entry.status === "archived" || entry.status === "quarantined") continue;
      totalBytes += entry.sizeBytes;
      byCategory[entry.category] = (byCategory[entry.category] ?? 0) + entry.sizeBytes;
      fileCount++;
    }

    return { totalBytes, byCategory, fileCount };
  }

  // ── Compaction ────────────────────────────────────────────────────────

  async compact(): Promise<{ before: number; after: number }> {
    const map = await this.load();
    const tasks = [...map.values()];
    const lines = [REGISTRY_SCHEMA, ...tasks.map((t) => JSON.stringify(t))];
    const before = (await readFile(this.registryPath, "utf-8"))
      .split("\n")
      .filter((l) => l.trim().length > 0).length;
    await writeFile(this.registryPath, lines.join("\n") + "\n", "utf-8");
    const after = lines.length;
    log.info("registry compacted", { before, after });
    return { before, after };
  }

  // ── Events query ──────────────────────────────────────────────────────

  async getEvents(fileId: string): Promise<FileEvent[]> {
    await this.ensureFile(this.eventsPath, EVENTS_SCHEMA);
    const raw = await readFile(this.eventsPath, "utf-8");
    const events: FileEvent[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj._schema) continue;
        if (obj.fileId === fileId) events.push(obj as FileEvent);
      } catch {
        continue;
      }
    }
    return events;
  }
}
