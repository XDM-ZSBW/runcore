/**
 * Library store — append-only JSONL persistence for virtual folders and state.
 * Follows src/contacts/store.ts pattern: Map cache, last-id-wins, 5s stale check.
 *
 * Files:
 *   brain/library/folders.jsonl — virtual folder hierarchy
 *   brain/library/state.jsonl   — recents + favorites tracking
 */

import { join } from "node:path";
import { stat } from "node:fs/promises";
import { createLogger } from "../utils/logger.js";
import { readBrainLines, appendBrainLine, ensureBrainJsonl } from "../lib/brain-io.js";
import type { LibraryFolder, LibraryStateEntry, FolderTreeNode } from "./types.js";
import { DEFAULT_ROOT_FOLDERS } from "./types.js";

const log = createLogger("library.store");

const FOLDER_SCHEMA = JSON.stringify({ _schema: "library-folders", _version: "1.0" });
const STATE_SCHEMA = JSON.stringify({ _schema: "library-state", _version: "1.0" });

function generateFolderId(): string {
  const ts = Date.now();
  const hex = Math.random().toString(16).slice(2, 10).padEnd(8, "0");
  return `folder_${ts}_${hex}`;
}

function generateStateId(): string {
  const ts = Date.now();
  const hex = Math.random().toString(16).slice(2, 10).padEnd(8, "0");
  return `ls_${ts}_${hex}`;
}

export class LibraryStore {
  private readonly foldersPath: string;
  private readonly statePath: string;
  private folderCache: Map<string, LibraryFolder> | null = null;
  private stateCache: Map<string, LibraryStateEntry> | null = null;
  private folderMtime = 0;
  private stateMtime = 0;
  private lastStaleCheckMs = 0;

  constructor(brainDir: string) {
    this.foldersPath = join(brainDir, "library", "folders.jsonl");
    this.statePath = join(brainDir, "library", "state.jsonl");
  }

  // ── File management ──────────────────────────────────────────────────────

  private async ensureFiles(): Promise<void> {
    await ensureBrainJsonl(this.foldersPath, FOLDER_SCHEMA);
    await ensureBrainJsonl(this.statePath, STATE_SCHEMA);
  }

  private async checkStale(): Promise<void> {
    const now = Date.now();
    if (now - this.lastStaleCheckMs < 5000) return;
    this.lastStaleCheckMs = now;

    try {
      if (this.folderCache) {
        const s = await stat(this.foldersPath);
        if (s.mtimeMs > this.folderMtime) this.folderCache = null;
      }
      if (this.stateCache) {
        const s = await stat(this.statePath);
        if (s.mtimeMs > this.stateMtime) this.stateCache = null;
      }
    } catch {
      // Files may not exist yet
    }
  }

  // ── Load folders ─────────────────────────────────────────────────────────

  private async loadFolders(): Promise<Map<string, LibraryFolder>> {
    await this.checkStale();
    if (this.folderCache) return this.folderCache;

    await this.ensureFiles();
    const lines = await readBrainLines(this.foldersPath);
    const map = new Map<string, LibraryFolder>();

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj._schema) continue;
        if (!obj.id) continue;
        map.set(obj.id, obj as LibraryFolder);
      } catch { continue; }
    }

    // Seed defaults if empty
    if (map.size === 0) {
      log.info("Seeding default root folders");
      const now = new Date().toISOString();
      for (const def of DEFAULT_ROOT_FOLDERS) {
        const folder: LibraryFolder = {
          id: generateFolderId(),
          name: def.name,
          parentId: null,
          path: `/${def.name}`,
          icon: def.icon,
          color: null,
          sortOrder: def.sortOrder,
          isSystem: true,
          status: "active",
          createdAt: now,
          updatedAt: now,
        };
        map.set(folder.id, folder);
        await appendBrainLine(this.foldersPath, JSON.stringify(folder));
      }
    }

    // Seed system subfolders (e.g., "Last Used" under Documents)
    await this.seedSystemSubfolders(map);

    // Materialize paths for any folder whose path is stale
    this.materializePaths(map);

    this.folderCache = map;
    try {
      const s = await stat(this.foldersPath);
      this.folderMtime = s.mtimeMs;
    } catch { /* ok */ }

    return map;
  }

  /** Walk parentId chains to rebuild each folder's materialized path. */
  private materializePaths(map: Map<string, LibraryFolder>): void {
    for (const folder of map.values()) {
      if (folder.status === "archived") continue;
      const segments: string[] = [folder.name];
      let current = folder;
      let depth = 0;
      while (current.parentId && depth < 20) {
        const parent = map.get(current.parentId);
        if (!parent) break;
        segments.unshift(parent.name);
        current = parent;
        depth++;
      }
      folder.path = "/" + segments.join("/");
    }
  }

  /** Ensure system virtual folders exist (idempotent). */
  private async seedSystemSubfolders(map: Map<string, LibraryFolder>): Promise<void> {
    // Check if "Last Used" already exists at root level
    const hasLastUsed = Array.from(map.values()).some(
      (f) => f.systemType === "last-used" && f.status === "active",
    );
    if (hasLastUsed) return;

    log.info("Seeding system folder: Last Used");
    const now = new Date().toISOString();
    const folder: LibraryFolder = {
      id: generateFolderId(),
      name: "Last Used",
      parentId: null,
      path: "/Last Used",
      icon: "clock",
      color: null,
      sortOrder: 0, // pin to top of root folders
      isSystem: true,
      systemType: "last-used",
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    map.set(folder.id, folder);
    await appendBrainLine(this.foldersPath, JSON.stringify(folder));
  }

  // ── Load state ───────────────────────────────────────────────────────────

  private async loadState(): Promise<Map<string, LibraryStateEntry>> {
    await this.checkStale();
    if (this.stateCache) return this.stateCache;

    await this.ensureFiles();
    const lines = await readBrainLines(this.statePath);
    const map = new Map<string, LibraryStateEntry>();

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj._schema) continue;
        if (!obj.id) continue;
        map.set(obj.id, obj as LibraryStateEntry);
      } catch { continue; }
    }

    this.stateCache = map;
    try {
      const s = await stat(this.statePath);
      this.stateMtime = s.mtimeMs;
    } catch { /* ok */ }

    return map;
  }

  private invalidateFolders(): void { this.folderCache = null; }
  private invalidateState(): void { this.stateCache = null; }

  // ── Folder CRUD ──────────────────────────────────────────────────────────

  async getFolder(id: string): Promise<LibraryFolder | null> {
    const map = await this.loadFolders();
    return map.get(id) ?? null;
  }

  async listFolders(parentId?: string | null): Promise<LibraryFolder[]> {
    const map = await this.loadFolders();
    let folders = Array.from(map.values()).filter((f) => f.status === "active");
    if (parentId !== undefined) {
      folders = folders.filter((f) => f.parentId === parentId);
    }
    folders.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    return folders;
  }

  async createFolder(opts: {
    name: string;
    parentId?: string | null;
    icon?: string;
    color?: string | null;
  }): Promise<LibraryFolder> {
    const map = await this.loadFolders();
    const now = new Date().toISOString();

    // Compute path
    let parentPath = "";
    if (opts.parentId) {
      const parent = map.get(opts.parentId);
      if (parent) parentPath = parent.path;
    }

    // Determine sort order (after last sibling)
    const siblings = Array.from(map.values()).filter(
      (f) => f.parentId === (opts.parentId ?? null) && f.status === "active",
    );
    const maxSort = siblings.reduce((max, f) => Math.max(max, f.sortOrder), 0);

    const folder: LibraryFolder = {
      id: generateFolderId(),
      name: opts.name,
      parentId: opts.parentId ?? null,
      path: `${parentPath}/${opts.name}`,
      icon: opts.icon ?? "folder",
      color: opts.color ?? null,
      sortOrder: maxSort + 1,
      isSystem: false,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };

    await appendBrainLine(this.foldersPath, JSON.stringify(folder));
    this.invalidateFolders();
    log.info(`Created folder: ${folder.path}`, { id: folder.id });
    return folder;
  }

  async updateFolder(
    id: string,
    changes: Partial<Pick<LibraryFolder, "name" | "parentId" | "icon" | "color" | "sortOrder">>,
  ): Promise<LibraryFolder | null> {
    const existing = await this.getFolder(id);
    if (!existing) return null;
    if (existing.isSystem && changes.parentId !== undefined) {
      return null; // system folders can't be moved
    }

    const updated: LibraryFolder = {
      ...existing,
      ...changes,
      updatedAt: new Date().toISOString(),
    };

    // Recompute path if name or parent changed
    if (changes.name || changes.parentId !== undefined) {
      const map = await this.loadFolders();
      let parentPath = "";
      if (updated.parentId) {
        const parent = map.get(updated.parentId);
        if (parent) parentPath = parent.path;
      }
      updated.path = `${parentPath}/${updated.name}`;
    }

    await appendBrainLine(this.foldersPath, JSON.stringify(updated));
    this.invalidateFolders();
    log.info(`Updated folder: ${updated.path}`, { id });
    return updated;
  }

  async archiveFolder(id: string): Promise<{ ok: boolean; message: string }> {
    const existing = await this.getFolder(id);
    if (!existing) return { ok: false, message: `Folder not found: ${id}` };
    if (existing.isSystem) return { ok: false, message: "Cannot archive system folder" };
    if (existing.status === "archived") return { ok: true, message: "Already archived" };

    const updated: LibraryFolder = {
      ...existing,
      status: "archived",
      updatedAt: new Date().toISOString(),
    };

    await appendBrainLine(this.foldersPath, JSON.stringify(updated));
    this.invalidateFolders();
    log.info(`Archived folder: ${existing.path}`, { id });
    return { ok: true, message: `Archived: ${existing.name}` };
  }

  // ── Tree ─────────────────────────────────────────────────────────────────

  async getTree(fileCounts?: Map<string, number>): Promise<FolderTreeNode[]> {
    const map = await this.loadFolders();
    const active = Array.from(map.values()).filter((f) => f.status === "active");

    // Build children map
    const childrenMap = new Map<string | "root", LibraryFolder[]>();
    childrenMap.set("root", []);
    for (const f of active) {
      const key = f.parentId ?? "root";
      if (!childrenMap.has(key)) childrenMap.set(key, []);
      childrenMap.get(key)!.push(f);
    }

    // Sort each group
    for (const [, children] of childrenMap) {
      children.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    }

    const buildNode = (folder: LibraryFolder): FolderTreeNode => ({
      folder,
      children: (childrenMap.get(folder.id) ?? []).map(buildNode),
      fileCount: fileCounts?.get(folder.id) ?? 0,
    });

    return (childrenMap.get("root") ?? []).map(buildNode);
  }

  async getBreadcrumb(folderId: string): Promise<LibraryFolder[]> {
    const map = await this.loadFolders();
    const trail: LibraryFolder[] = [];
    let current = map.get(folderId);
    let depth = 0;
    while (current && depth < 20) {
      trail.unshift(current);
      if (!current.parentId) break;
      current = map.get(current.parentId);
      depth++;
    }
    return trail;
  }

  // ── Recents & Favorites ──────────────────────────────────────────────────

  async recordAccess(targetId: string, targetType: "file" | "folder"): Promise<void> {
    const entry: LibraryStateEntry = {
      id: generateStateId(),
      type: "recent",
      targetType,
      targetId,
      timestamp: new Date().toISOString(),
      status: "active",
    };
    await appendBrainLine(this.statePath, JSON.stringify(entry));
    this.invalidateState();
  }

  async getRecents(limit: number = 20): Promise<LibraryStateEntry[]> {
    const map = await this.loadState();
    const recents = Array.from(map.values())
      .filter((e) => e.type === "recent" && e.status === "active");

    // Deduplicate by targetId, keeping latest
    const latest = new Map<string, LibraryStateEntry>();
    for (const r of recents) {
      const existing = latest.get(r.targetId);
      if (!existing || r.timestamp > existing.timestamp) {
        latest.set(r.targetId, r);
      }
    }

    return Array.from(latest.values())
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, limit);
  }

  async toggleFavorite(targetId: string, targetType: "file" | "folder"): Promise<{ favorited: boolean }> {
    const map = await this.loadState();
    // Find existing active favorite for this target
    const existing = Array.from(map.values()).find(
      (e) => e.type === "favorite" && e.targetId === targetId && e.status === "active",
    );

    if (existing) {
      // Remove favorite
      const removed: LibraryStateEntry = {
        ...existing,
        status: "removed",
        timestamp: new Date().toISOString(),
      };
      await appendBrainLine(this.statePath, JSON.stringify(removed));
      this.invalidateState();
      return { favorited: false };
    }

    // Add favorite
    const entry: LibraryStateEntry = {
      id: generateStateId(),
      type: "favorite",
      targetType,
      targetId,
      timestamp: new Date().toISOString(),
      status: "active",
    };
    await appendBrainLine(this.statePath, JSON.stringify(entry));
    this.invalidateState();
    return { favorited: true };
  }

  async getFavorites(): Promise<LibraryStateEntry[]> {
    const map = await this.loadState();
    return Array.from(map.values())
      .filter((e) => e.type === "favorite" && e.status === "active")
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  async isFavorite(targetId: string): Promise<boolean> {
    const map = await this.loadState();
    return Array.from(map.values()).some(
      (e) => e.type === "favorite" && e.targetId === targetId && e.status === "active",
    );
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────

let _store: LibraryStore | null = null;

export function createLibraryStore(brainDir: string): LibraryStore {
  if (_store) return _store;
  _store = new LibraryStore(brainDir);
  return _store;
}

export function getLibraryStore(): LibraryStore | null {
  return _store;
}
