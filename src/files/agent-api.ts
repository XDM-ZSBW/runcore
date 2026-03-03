/**
 * Agent file API — DASH-65.
 * Helper functions for agents to create, read, and list files.
 * Agents use these instead of direct FileStore access.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "../utils/logger.js";
import type { FileEntry, FileCategory, FileFilter } from "./types.js";
import type { FileStore } from "./store.js";

const log = createLogger("files.agent-api");

// ── Lazy reference to FileManager (set at init) ────────────────────────────

let _store: FileStore | null = null;
let _storageRoot: string | null = null;

/**
 * Initialize agent file API with references to the store and storage root.
 * Called once by the FileManager during setup.
 */
export function initAgentFileApi(store: FileStore, storageRoot: string): void {
  _store = store;
  _storageRoot = storageRoot;
}

function ensureInit(): { store: FileStore; storageRoot: string } {
  if (!_store || !_storageRoot) {
    throw new Error("Agent file API not initialized — call initAgentFileApi first");
  }
  return { store: _store, storageRoot: _storageRoot };
}

// ── Agent API functions ─────────────────────────────────────────────────────

/**
 * Create a file from an agent task.
 * Writes content to storage/generated/<year>/<month>/ and registers it.
 */
export async function agentCreateFile(opts: {
  taskId: string;
  name: string;
  content: Buffer;
  mimeType: string;
  category?: FileCategory;
  tags?: string[];
}): Promise<{ ok: boolean; file?: FileEntry; message: string }> {
  // Deferred import to avoid circular dependency
  const { FileManager } = await import("./manager.js");
  const manager = FileManager.getInstance();
  if (!manager) {
    return { ok: false, message: "FileManager not initialized" };
  }

  try {
    const result = await manager.upload({
      buffer: opts.content,
      originalName: opts.name,
      mimeType: opts.mimeType,
      category: opts.category ?? "report",
      origin: "agent",
      taskId: opts.taskId,
      tags: opts.tags,
      actor: opts.taskId,
    });

    if (!result.ok) return { ok: false, message: result.message };

    log.info("agent created file", { taskId: opts.taskId, fileId: result.file?.id, name: opts.name });
    return { ok: true, file: result.file, message: "File created" };
  } catch (err: any) {
    log.error("agent file creation failed", { taskId: opts.taskId, error: err.message });
    return { ok: false, message: `Failed: ${err.message}` };
  }
}

/**
 * Read a file's contents by ID.
 */
export async function agentReadFile(fileId: string): Promise<{ ok: boolean; data?: Buffer; message: string }> {
  const { store, storageRoot } = ensureInit();

  try {
    const entry = await store.get(fileId);
    if (!entry) return { ok: false, message: `File not found: ${fileId}` };
    if (entry.visibility === "private") return { ok: false, message: "File is private" };

    const filePath = join(storageRoot, entry.storagePath);
    const data = await readFile(filePath);
    await store.logEvent(fileId, "downloaded", "agent");
    return { ok: true, data, message: "OK" };
  } catch (err: any) {
    return { ok: false, message: `Read failed: ${err.message}` };
  }
}

/**
 * List files matching a filter.
 */
export async function agentListFiles(filter: FileFilter): Promise<{ ok: boolean; files?: FileEntry[]; message: string }> {
  const { store } = ensureInit();

  try {
    const files = await store.list(filter);
    // Agents can only see files with "agents" or "shared" visibility
    const visible = files.filter((f) => f.visibility === "agents" || f.visibility === "shared");
    return { ok: true, files: visible, message: `Found ${visible.length} files` };
  } catch (err: any) {
    return { ok: false, message: `List failed: ${err.message}` };
  }
}

/**
 * Format file references for injection into agent prompts.
 * Returns a markdown section listing available files.
 */
export async function formatFilesForContext(
  taskId?: string,
  limit?: number,
): Promise<string> {
  const { store } = ensureInit();

  try {
    const filter: FileFilter = { limit: limit ?? 10 };
    if (taskId) filter.taskId = taskId;

    const files = await store.list(filter);
    const visible = files.filter((f) => f.visibility === "agents" || f.visibility === "shared");

    if (visible.length === 0) return "";

    const lines = visible.map((f) => {
      const size = formatBytes(f.sizeBytes);
      return `- ${f.id}: "${f.name}" (${f.category}, ${size})`;
    });

    return `## Available files\nYou can read files using their ID. Relevant files:\n${lines.join("\n")}`;
  } catch {
    return "";
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
