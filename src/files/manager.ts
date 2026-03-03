/**
 * FileManager — central orchestrator for file operations (DASH-65).
 * Composes: FileStore, validation, compression, versioning, Google Drive sync.
 * Singleton pattern — one instance per process.
 *
 * Never throws — all public methods return { ok, data?, message }.
 */

import { readFile, writeFile, copyFile, unlink, mkdir, stat } from "node:fs/promises";
import { join, extname } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createLogger } from "../utils/logger.js";
import { FileStore, generateFileId } from "./store.js";
import { validateUpload, slugify, sanitizeSvgBuffer, mimeForExtension } from "./validate.js";
import { compressFile, generateThumbnail } from "./compress.js";
import { createVersion, listVersions, rollbackToVersion } from "./version.js";
import { GDriveSyncStore, syncToDrive, getDriveSyncStatus } from "./gdrive.js";
import { initAgentFileApi } from "./agent-api.js";
import type {
  FileEntry,
  FileCategory,
  FileOrigin,
  FileFilter,
  FileSettings,
  StorageUsage,
  VersionInfo,
  DEFAULT_FILE_SETTINGS,
} from "./types.js";
import { DEFAULT_FILE_SETTINGS as DEFAULTS } from "./types.js";

const log = createLogger("files.manager");

// ── Upload options ──────────────────────────────────────────────────────────

export interface UploadOptions {
  buffer: Buffer;
  originalName: string;
  mimeType: string;
  category?: FileCategory;
  origin?: FileOrigin;
  tags?: string[];
  taskId?: string;
  actor?: string;
  encrypt?: boolean;
}

// ── FileManager ─────────────────────────────────────────────────────────────

let instance: FileManager | null = null;

export class FileManager {
  private readonly store: FileStore;
  private readonly syncStore: GDriveSyncStore;
  private readonly storageRoot: string;
  private readonly brainDir: string;
  private settings: FileSettings;
  private syncTimer: ReturnType<typeof setInterval> | null = null;

  private constructor(brainDir: string, storageRoot: string, settings?: Partial<FileSettings>) {
    this.brainDir = brainDir;
    this.storageRoot = storageRoot;
    this.store = new FileStore(brainDir);
    this.syncStore = new GDriveSyncStore(brainDir);
    this.settings = { ...DEFAULTS, ...settings };
  }

  /**
   * Initialize the singleton FileManager.
   * Call once during server startup.
   */
  static async init(
    brainDir: string,
    storageRoot: string,
    settings?: Partial<FileSettings>,
  ): Promise<FileManager> {
    if (instance) return instance;

    const fm = new FileManager(brainDir, storageRoot, settings);

    // Ensure storage directories exist
    await fm.ensureDirectories();

    // Wire up the agent API
    initAgentFileApi(fm.store, storageRoot);

    // Start Drive sync timer if enabled
    if (fm.settings.gdrive.syncEnabled) {
      fm.startSyncTimer();
    }

    instance = fm;
    log.info("FileManager initialized", { storageRoot, brainDir });
    return fm;
  }

  /**
   * Get the singleton instance (null if not initialized).
   */
  static getInstance(): FileManager | null {
    return instance;
  }

  /**
   * Shutdown — stop timers, release resources.
   */
  async shutdown(): Promise<void> {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    instance = null;
    log.info("FileManager shut down");
  }

  // ── Directory setup ───────────────────────────────────────────────────

  private async ensureDirectories(): Promise<void> {
    const dirs = [
      this.storageRoot,
      join(this.storageRoot, "uploads"),
      join(this.storageRoot, "generated"),
      join(this.storageRoot, "templates"),
      join(this.storageRoot, "versions"),
      join(this.storageRoot, "thumbnails"),
      join(this.storageRoot, "tmp"),
    ];
    for (const dir of dirs) {
      await mkdir(dir, { recursive: true });
    }
  }

  // ── Upload ────────────────────────────────────────────────────────────

  /**
   * Upload a file: validate, store, compress, register.
   */
  async upload(opts: UploadOptions): Promise<{ ok: boolean; file?: FileEntry; message: string }> {
    // 1. Validate
    const validation = await validateUpload(
      opts.buffer,
      opts.originalName,
      opts.mimeType,
      this.settings.maxUploadBytes,
    );
    if (!validation.valid) {
      log.warn("upload rejected", { name: opts.originalName, reason: validation.rejected });
      return { ok: false, message: `Upload rejected: ${validation.rejected}` };
    }

    // 2. Check storage quota
    const usage = await this.store.getStorageUsage();
    if (usage.totalBytes + opts.buffer.length > this.settings.maxStorageBytes) {
      return { ok: false, message: "Storage quota exceeded" };
    }

    try {
      // 3. Determine storage path
      const now = new Date();
      const year = now.getFullYear().toString();
      const month = (now.getMonth() + 1).toString().padStart(2, "0");
      const fileId = generateFileId();
      const slug = slugify(validation.sanitizedName.replace(/\.[^.]+$/, ""));
      const ext = validation.detectedExt || extname(opts.originalName);
      const subDir = opts.origin === "agent" ? "generated" : "uploads";
      const storagePath = join(subDir, year, month, `${fileId}_${slug}${ext}`);
      const fullPath = join(this.storageRoot, storagePath);

      // 4. Ensure target directory
      await mkdir(join(this.storageRoot, subDir, year, month), { recursive: true });

      // 5. SVG sanitization
      let buffer = opts.buffer;
      if (ext === ".svg") {
        buffer = sanitizeSvgBuffer(buffer);
      }

      // 6. Write file
      await writeFile(fullPath, buffer);

      // 7. Compute checksum
      const checksum = createHash("sha256").update(buffer).digest("hex");

      // 8. Extract text preview for searchable files
      let textPreview: string | undefined;
      const textExts = new Set([".txt", ".md", ".csv", ".json", ".yaml", ".yml", ".log"]);
      if (textExts.has(ext)) {
        const text = buffer.toString("utf-8");
        textPreview = text.slice(0, 500);
      }

      // 9. Register in store
      const entry = await this.store.create({
        name: validation.sanitizedName,
        slug,
        mimeType: validation.detectedMime || opts.mimeType,
        sizeBytes: buffer.length,
        category: opts.category ?? "upload",
        tags: opts.tags ?? [],
        origin: opts.origin ?? "user-upload",
        ownerId: opts.actor ?? null,
        taskId: opts.taskId ?? null,
        parentId: null,
        version: 1,
        storagePath,
        checksum,
        encrypted: opts.encrypt ?? false,
        visibility: opts.origin === "agent" ? "agents" : "private",
        status: "active",
        textPreview,
      });

      // 10. Post-upload: compression (fire-and-forget)
      if (this.settings.autoCompress) {
        compressFile(fullPath, entry.mimeType).then((result) => {
          if (result) {
            this.store.logEvent(entry.id, "compressed", "system", result.action);
          }
        }).catch(() => {});
      }

      // 11. Post-upload: thumbnail (fire-and-forget)
      if (this.settings.autoThumbnail) {
        generateThumbnail(
          fullPath,
          entry.mimeType,
          join(this.storageRoot, "thumbnails"),
          entry.id,
        ).catch(() => {});
      }

      log.info("file uploaded", {
        id: entry.id,
        name: entry.name,
        size: entry.sizeBytes,
        category: entry.category,
      });
      return { ok: true, file: entry, message: "File uploaded" };
    } catch (err: any) {
      log.error("upload failed", { name: opts.originalName, error: err.message });
      return { ok: false, message: `Upload failed: ${err.message}` };
    }
  }

  // ── Read / Download ───────────────────────────────────────────────────

  /**
   * Read file contents by ID.
   */
  async read(fileId: string): Promise<{ ok: boolean; data?: Buffer; entry?: FileEntry; message: string }> {
    const entry = await this.store.get(fileId);
    if (!entry) return { ok: false, message: `File not found: ${fileId}` };
    if (entry.status === "quarantined") return { ok: false, message: "File is quarantined" };

    try {
      const filePath = join(this.storageRoot, entry.storagePath);
      const data = await readFile(filePath);
      await this.store.logEvent(fileId, "downloaded", "system");
      return { ok: true, data, entry, message: "OK" };
    } catch (err: any) {
      return { ok: false, message: `Read failed: ${err.message}` };
    }
  }

  // ── Metadata ──────────────────────────────────────────────────────────

  async get(fileId: string): Promise<FileEntry | null> {
    return this.store.get(fileId);
  }

  async list(filter?: FileFilter): Promise<FileEntry[]> {
    return this.store.list(filter);
  }

  async updateMetadata(
    fileId: string,
    patch: Partial<Pick<FileEntry, "name" | "tags" | "category" | "visibility" | "meta">>,
  ): Promise<{ ok: boolean; file?: FileEntry; message: string }> {
    const updated = await this.store.update(fileId, patch);
    if (!updated) return { ok: false, message: `File not found: ${fileId}` };
    return { ok: true, file: updated, message: "Updated" };
  }

  // ── Archive / Restore ─────────────────────────────────────────────────

  async archive(fileId: string, actor: string): Promise<{ ok: boolean; message: string }> {
    return this.store.archive(fileId, actor);
  }

  async restore(fileId: string, actor: string): Promise<{ ok: boolean; message: string }> {
    return this.store.restore(fileId, actor);
  }

  // ── Versioning ────────────────────────────────────────────────────────

  /**
   * Update a file's content, creating a new version of the old content.
   */
  async updateContent(
    fileId: string,
    newBuffer: Buffer,
    actor: string,
  ): Promise<{ ok: boolean; file?: FileEntry; message: string }> {
    const entry = await this.store.get(fileId);
    if (!entry) return { ok: false, message: `File not found: ${fileId}` };

    // Create version of current content
    const vResult = await createVersion(entry, this.storageRoot, this.store, this.settings.maxVersions);
    if (!vResult.ok) return { ok: false, message: vResult.message };

    try {
      // Overwrite primary file
      const fullPath = join(this.storageRoot, entry.storagePath);
      await writeFile(fullPath, newBuffer);

      const checksum = createHash("sha256").update(newBuffer).digest("hex");
      const updated = await this.store.update(fileId, {
        version: vResult.version,
        sizeBytes: newBuffer.length,
        checksum,
      });

      log.info("file content updated", { fileId, version: vResult.version });
      return { ok: true, file: updated ?? undefined, message: `Updated to v${vResult.version}` };
    } catch (err: any) {
      return { ok: false, message: `Update failed: ${err.message}` };
    }
  }

  async getVersionHistory(fileId: string): Promise<VersionInfo[]> {
    return listVersions(fileId, this.storageRoot);
  }

  async rollback(fileId: string, targetVersion: number): Promise<{ ok: boolean; message: string }> {
    const entry = await this.store.get(fileId);
    if (!entry) return { ok: false, message: `File not found: ${fileId}` };
    return rollbackToVersion(entry, targetVersion, this.storageRoot, this.store);
  }

  // ── Google Drive ──────────────────────────────────────────────────────

  async syncDrive(): Promise<{ ok: boolean; synced: number; errors: number; message: string }> {
    return syncToDrive(this.store, this.syncStore, this.storageRoot, this.settings.gdrive);
  }

  async getDriveStatus() {
    return getDriveSyncStatus(this.syncStore, this.settings.gdrive);
  }

  async updateDriveConfig(
    config: Partial<FileSettings["gdrive"]>,
  ): Promise<{ ok: boolean; message: string }> {
    this.settings.gdrive = { ...this.settings.gdrive, ...config };

    // Restart sync timer if settings changed
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    if (this.settings.gdrive.syncEnabled) {
      this.startSyncTimer();
    }

    log.info("Drive config updated", { config });
    return { ok: true, message: "Drive config updated" };
  }

  private startSyncTimer(): void {
    const interval = this.settings.gdrive.syncIntervalMs;
    this.syncTimer = setInterval(() => {
      this.syncDrive().catch((err) => {
        log.error("Drive sync timer error", { error: err.message });
      });
    }, interval);
    log.info("Drive sync timer started", { intervalMs: interval });
  }

  // ── Storage stats ─────────────────────────────────────────────────────

  async getStats(): Promise<StorageUsage> {
    return this.store.getStorageUsage();
  }

  // ── Compaction ────────────────────────────────────────────────────────

  async compact(): Promise<{ registry: { before: number; after: number } }> {
    const registry = await this.store.compact();
    await this.syncStore.compact();
    return { registry };
  }

  // ── Accessors for sub-modules ─────────────────────────────────────────

  getStore(): FileStore {
    return this.store;
  }

  getStorageRoot(): string {
    return this.storageRoot;
  }

  getSettings(): FileSettings {
    return { ...this.settings };
  }
}
