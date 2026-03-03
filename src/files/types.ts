/**
 * File management types — DASH-65.
 * All interfaces for the file registry, events, validation, and sync.
 */

// ── Categories & Origins ────────────────────────────────────────────────────

export type FileCategory =
  | "upload"
  | "report"
  | "template"
  | "attachment"
  | "export"
  | "resume"
  | "media"
  | "ingest"
  | "other";

export type FileOrigin =
  | "user-upload"
  | "agent"
  | "gdrive-sync"
  | "template"
  | "system";

export type FileStatus = "active" | "archived" | "processing" | "quarantined";

export type FileVisibility = "private" | "agents" | "shared";

// ── Registry Entry ──────────────────────────────────────────────────────────

export interface FileEntry {
  id: string;
  name: string;
  slug: string;
  mimeType: string;
  sizeBytes: number;
  category: FileCategory;
  tags: string[];
  origin: FileOrigin;
  ownerId: string | null;
  taskId: string | null;
  parentId: string | null;
  version: number;
  storagePath: string;
  checksum: string;
  encrypted: boolean;
  visibility: FileVisibility;
  status: FileStatus;
  textPreview?: string;
  meta?: Record<string, string | number | boolean>;
  createdAt: string;
  updatedAt: string;
}

// ── Event Log ───────────────────────────────────────────────────────────────

export type FileAction =
  | "created"
  | "updated"
  | "versioned"
  | "archived"
  | "restored"
  | "downloaded"
  | "shared"
  | "quarantined"
  | "synced"
  | "attached"
  | "detached"
  | "compressed"
  | "encrypted"
  | "decrypted";

export interface FileEvent {
  id: string;
  fileId: string;
  action: FileAction;
  actor: string;
  detail?: string;
  timestamp: string;
}

// ── Filter & Search ─────────────────────────────────────────────────────────

export interface FileFilter {
  category?: FileCategory;
  origin?: FileOrigin;
  status?: FileStatus;
  tags?: string[];
  taskId?: string;
  folderId?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface FileSearchResult {
  file: FileEntry;
  relevance: number;
  matchContext?: string;
}

// ── Validation ──────────────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  rejected?: string;
  sanitizedName: string;
  detectedMime: string;
  detectedExt: string;
}

// ── Compression ─────────────────────────────────────────────────────────────

export interface CompressionResult {
  originalBytes: number;
  compressedBytes: number;
  saved: number;
  action: string;
}

// ── Versioning ──────────────────────────────────────────────────────────────

export interface VersionInfo {
  version: number;
  storagePath: string;
  sizeBytes: number;
  checksum: string;
  createdAt: string;
}

// ── Google Drive Sync ───────────────────────────────────────────────────────

export interface GDriveSyncEntry {
  fileId: string;
  driveFileId: string;
  driveVersion: number;
  localChecksum: string;
  syncedAt: string;
  direction: "push" | "pull";
}

// ── Share Links ─────────────────────────────────────────────────────────────

export interface ShareLink {
  id: string;
  fileId: string;
  token: string;
  expiresAt: string;
  maxDownloads: number | null;
  downloads: number;
  createdAt: string;
}

// ── Settings ────────────────────────────────────────────────────────────────

export interface FileSettings {
  enabled: boolean;
  maxStorageBytes: number;
  maxUploadBytes: number;
  maxVersions: number;
  autoCompress: boolean;
  autoThumbnail: boolean;
  encryptSensitive: boolean;
  cleanupDays: number;
  gdrive: {
    syncEnabled: boolean;
    folderId: string | null;
    syncIntervalMs: number;
  };
}

export const DEFAULT_FILE_SETTINGS: FileSettings = {
  enabled: true,
  maxStorageBytes: 10 * 1024 * 1024 * 1024, // 10 GB
  maxUploadBytes: 50 * 1024 * 1024,          // 50 MB
  maxVersions: 20,
  autoCompress: true,
  autoThumbnail: true,
  encryptSensitive: true,
  cleanupDays: 90,
  gdrive: {
    syncEnabled: false,
    folderId: null,
    syncIntervalMs: 15 * 60 * 1000, // 15 min
  },
};

// ── Storage Quotas ──────────────────────────────────────────────────────────

export interface StorageUsage {
  totalBytes: number;
  byCategory: Record<FileCategory, number>;
  fileCount: number;
}
