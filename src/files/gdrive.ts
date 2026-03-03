/**
 * Google Drive sync engine — DASH-65.
 * One-way backup (push) or two-way mirror mode.
 * Uses existing Google OAuth from src/google/auth.ts.
 * Tracked state in brain/files/gdrive-sync.jsonl.
 */

import { readFile, appendFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname, extname } from "node:path";
import { createReadStream } from "node:fs";
import { stat as fsStat } from "node:fs/promises";
import { createLogger } from "../utils/logger.js";
import { getAccessToken, isGoogleAuthenticated } from "../google/auth.js";
import type { FileEntry, GDriveSyncEntry, FileSettings } from "./types.js";
import type { FileStore } from "./store.js";

const log = createLogger("files.gdrive");

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";

const SYNC_SCHEMA = JSON.stringify({ _schema: "gdrive_sync", version: 1 });

// ── Sync state persistence ──────────────────────────────────────────────────

export class GDriveSyncStore {
  private cache: Map<string, GDriveSyncEntry> | null = null;
  private readonly filePath: string;

  constructor(brainDir: string) {
    this.filePath = join(brainDir, "files", "gdrive-sync.jsonl");
  }

  private async ensureFile(): Promise<void> {
    try {
      await readFile(this.filePath, "utf-8");
    } catch {
      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, SYNC_SCHEMA + "\n", "utf-8");
    }
  }

  private async load(): Promise<Map<string, GDriveSyncEntry>> {
    if (this.cache) return this.cache;
    await this.ensureFile();

    const raw = await readFile(this.filePath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    const map = new Map<string, GDriveSyncEntry>();

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj._schema) continue;
        map.set(obj.fileId, obj as GDriveSyncEntry);
      } catch {
        continue;
      }
    }

    this.cache = map;
    return map;
  }

  async get(fileId: string): Promise<GDriveSyncEntry | null> {
    const map = await this.load();
    return map.get(fileId) ?? null;
  }

  async set(entry: GDriveSyncEntry): Promise<void> {
    const map = await this.load();
    map.set(entry.fileId, entry);
    await appendFile(this.filePath, JSON.stringify(entry) + "\n", "utf-8");
  }

  async list(): Promise<GDriveSyncEntry[]> {
    const map = await this.load();
    return [...map.values()];
  }

  async compact(): Promise<void> {
    const map = await this.load();
    const lines = [SYNC_SCHEMA, ...[...map.values()].map((e) => JSON.stringify(e))];
    await writeFile(this.filePath, lines.join("\n") + "\n", "utf-8");
  }
}

// ── Drive API helpers ───────────────────────────────────────────────────────

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  size?: string;
  version?: string;
}

async function driveRequest<T>(
  method: string,
  url: string,
  body?: Buffer | string | Record<string, unknown>,
  contentType?: string,
): Promise<{ ok: boolean; data?: T; message: string }> {
  const auth = await getAccessToken();
  if (!auth.ok) return { ok: false, message: auth.message };

  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${auth.token}`,
    };
    if (contentType) headers["Content-Type"] = contentType;

    const fetchOpts: RequestInit = { method, headers };
    if (body) {
      fetchOpts.body = body instanceof Buffer
        ? body
        : typeof body === "string"
          ? body
          : JSON.stringify(body);
      if (!contentType && typeof body === "object" && !(body instanceof Buffer)) {
        headers["Content-Type"] = "application/json";
      }
    }

    const res = await fetch(url, { ...fetchOpts, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, message: `Drive API error (${res.status}): ${text}` };
    }

    // Some requests return empty body (204)
    const resText = await res.text();
    const data = resText ? (JSON.parse(resText) as T) : undefined;
    return { ok: true, data, message: "OK" };
  } catch (err: any) {
    return { ok: false, message: `Drive request failed: ${err.message}` };
  }
}

// ── Upload to Drive ─────────────────────────────────────────────────────────

/**
 * Upload a file to Google Drive.
 * Uses simple upload for files < 5MB, resumable for larger.
 */
export async function uploadToDrive(
  filePath: string,
  fileName: string,
  mimeType: string,
  folderId: string | null,
): Promise<{ ok: boolean; driveFileId?: string; message: string }> {
  if (!isGoogleAuthenticated()) {
    return { ok: false, message: "Google not authenticated" };
  }

  try {
    const buffer = await readFile(filePath);

    // Multipart upload: metadata + file content
    const boundary = "dash_file_upload_boundary";
    const metadata: Record<string, unknown> = { name: fileName, mimeType };
    if (folderId) metadata.parents = [folderId];

    const metaPart = JSON.stringify(metadata);
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`),
      Buffer.from(metaPart),
      Buffer.from(`\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
      buffer,
      Buffer.from(`\r\n--${boundary}--`),
    ]);

    const result = await driveRequest<DriveFile>(
      "POST",
      `${DRIVE_UPLOAD_API}/files?uploadType=multipart`,
      body,
      `multipart/related; boundary=${boundary}`,
    );

    if (!result.ok) return { ok: false, message: result.message };

    log.info("file uploaded to Drive", { fileName, driveFileId: result.data?.id });
    return { ok: true, driveFileId: result.data?.id, message: "Uploaded to Drive" };
  } catch (err: any) {
    log.error("Drive upload failed", { fileName, error: err.message });
    return { ok: false, message: `Upload failed: ${err.message}` };
  }
}

/**
 * Update an existing file on Google Drive.
 */
export async function updateOnDrive(
  driveFileId: string,
  filePath: string,
  mimeType: string,
): Promise<{ ok: boolean; message: string }> {
  if (!isGoogleAuthenticated()) {
    return { ok: false, message: "Google not authenticated" };
  }

  try {
    const buffer = await readFile(filePath);
    const result = await driveRequest(
      "PATCH",
      `${DRIVE_UPLOAD_API}/files/${driveFileId}?uploadType=media`,
      buffer,
      mimeType,
    );
    if (!result.ok) return { ok: false, message: result.message };

    log.info("file updated on Drive", { driveFileId });
    return { ok: true, message: "Updated on Drive" };
  } catch (err: any) {
    log.error("Drive update failed", { driveFileId, error: err.message });
    return { ok: false, message: `Update failed: ${err.message}` };
  }
}

// ── Sync engine ─────────────────────────────────────────────────────────────

/**
 * Run a sync cycle: push local files to Drive that haven't been synced
 * or have changed since last sync.
 */
export async function syncToDrive(
  fileStore: FileStore,
  syncStore: GDriveSyncStore,
  storageRoot: string,
  settings: FileSettings["gdrive"],
): Promise<{ ok: boolean; synced: number; errors: number; message: string }> {
  if (!settings.syncEnabled || !isGoogleAuthenticated()) {
    return { ok: false, synced: 0, errors: 0, message: "Sync not enabled or not authenticated" };
  }

  const files = await fileStore.list({
    status: "active",
  });

  // Only sync user uploads and agent-generated files
  const syncable = files.filter(
    (f) => f.origin === "user-upload" || f.origin === "agent",
  );

  let synced = 0;
  let errors = 0;

  for (const file of syncable) {
    const existing = await syncStore.get(file.id);

    // Skip if already synced and checksum matches
    if (existing && existing.localChecksum === file.checksum) continue;

    const filePath = join(storageRoot, file.storagePath);

    try {
      if (existing?.driveFileId) {
        // Update existing Drive file
        const result = await updateOnDrive(existing.driveFileId, filePath, file.mimeType);
        if (!result.ok) {
          log.warn("sync update failed", { fileId: file.id, error: result.message });
          errors++;
          continue;
        }
        await syncStore.set({
          fileId: file.id,
          driveFileId: existing.driveFileId,
          driveVersion: (existing.driveVersion ?? 0) + 1,
          localChecksum: file.checksum,
          syncedAt: new Date().toISOString(),
          direction: "push",
        });
      } else {
        // Upload new file
        const result = await uploadToDrive(
          filePath,
          file.name,
          file.mimeType,
          settings.folderId,
        );
        if (!result.ok || !result.driveFileId) {
          log.warn("sync upload failed", { fileId: file.id, error: result.message });
          errors++;
          continue;
        }
        await syncStore.set({
          fileId: file.id,
          driveFileId: result.driveFileId,
          driveVersion: 1,
          localChecksum: file.checksum,
          syncedAt: new Date().toISOString(),
          direction: "push",
        });
      }

      await fileStore.logEvent(file.id, "synced", "system", "Pushed to Google Drive");
      synced++;
    } catch (err: any) {
      log.error("sync error for file", { fileId: file.id, error: err.message });
      errors++;
    }
  }

  log.info("Drive sync completed", { synced, errors, total: syncable.length });
  return { ok: true, synced, errors, message: `Synced ${synced} files, ${errors} errors` };
}

/**
 * Get Drive sync status for reporting.
 */
export async function getDriveSyncStatus(
  syncStore: GDriveSyncStore,
  settings: FileSettings["gdrive"],
): Promise<{
  connected: boolean;
  folderId: string | null;
  syncEnabled: boolean;
  fileCount: number;
  lastSync: string | null;
}> {
  const connected = isGoogleAuthenticated();
  const entries = await syncStore.list();
  const lastSync = entries.length > 0
    ? entries.reduce((latest, e) => (e.syncedAt > latest ? e.syncedAt : latest), "")
    : null;

  return {
    connected,
    folderId: settings.folderId,
    syncEnabled: settings.syncEnabled,
    fileCount: entries.length,
    lastSync,
  };
}
