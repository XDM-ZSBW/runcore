/**
 * File versioning — DASH-65.
 * Manages version chain: copies current file before overwrite,
 * maintains version history, supports rollback.
 */

import { copyFile, readdir, readFile, stat, unlink, mkdir } from "node:fs/promises";
import { join, extname } from "node:path";
import { createHash } from "node:crypto";
import { createLogger } from "../utils/logger.js";
import type { FileEntry, VersionInfo } from "./types.js";
import type { FileStore } from "./store.js";

const log = createLogger("files.version");

/**
 * Create a new version snapshot before updating a file.
 * Copies the current file to storage/versions/<file-id>/v<n>_<timestamp>.<ext>
 * Returns the new version number.
 */
export async function createVersion(
  entry: FileEntry,
  storageRoot: string,
  store: FileStore,
  maxVersions: number,
): Promise<{ ok: boolean; version: number; message: string }> {
  try {
    const currentPath = join(storageRoot, entry.storagePath);
    const ext = extname(entry.name) || extname(entry.storagePath);
    const versionDir = join(storageRoot, "versions", entry.id);
    await mkdir(versionDir, { recursive: true });

    const ts = Date.now();
    const versionFile = `v${entry.version}_${ts}${ext}`;
    const versionPath = join(versionDir, versionFile);

    await copyFile(currentPath, versionPath);

    // Log the versioned event
    await store.logEvent(entry.id, "versioned", "system", `v${entry.version} archived`);

    // Prune old versions if over limit
    await pruneVersions(entry.id, storageRoot, maxVersions);

    const newVersion = entry.version + 1;
    log.info("version created", { fileId: entry.id, version: entry.version, newVersion });
    return { ok: true, version: newVersion, message: `Version ${entry.version} archived` };
  } catch (err: any) {
    log.error("version creation failed", { fileId: entry.id, error: err.message });
    return { ok: false, version: entry.version, message: `Version failed: ${err.message}` };
  }
}

/**
 * List all versions of a file from the versions directory.
 */
export async function listVersions(
  fileId: string,
  storageRoot: string,
): Promise<VersionInfo[]> {
  const versionDir = join(storageRoot, "versions", fileId);
  try {
    const files = await readdir(versionDir);
    const versions: VersionInfo[] = [];

    for (const file of files) {
      const match = file.match(/^v(\d+)_(\d+)/);
      if (!match) continue;

      const filePath = join(versionDir, file);
      const fileStat = await stat(filePath);
      const buffer = await readFile(filePath);
      const checksum = createHash("sha256").update(buffer).digest("hex");

      versions.push({
        version: parseInt(match[1], 10),
        storagePath: join("versions", fileId, file),
        sizeBytes: fileStat.size,
        checksum,
        createdAt: new Date(parseInt(match[2], 10)).toISOString(),
      });
    }

    return versions.sort((a, b) => a.version - b.version);
  } catch {
    return [];
  }
}

/**
 * Rollback a file to a specific version.
 * Copies the target version back to the primary path.
 * Rollback is itself a new version (incrementing the counter).
 */
export async function rollbackToVersion(
  entry: FileEntry,
  targetVersion: number,
  storageRoot: string,
  store: FileStore,
): Promise<{ ok: boolean; message: string }> {
  try {
    const versions = await listVersions(entry.id, storageRoot);
    const target = versions.find((v) => v.version === targetVersion);
    if (!target) {
      return { ok: false, message: `Version ${targetVersion} not found` };
    }

    const targetPath = join(storageRoot, target.storagePath);
    const primaryPath = join(storageRoot, entry.storagePath);

    // First, archive the current file as the latest version
    const ext = extname(entry.name) || extname(entry.storagePath);
    const versionDir = join(storageRoot, "versions", entry.id);
    await mkdir(versionDir, { recursive: true });
    const ts = Date.now();
    const archiveName = `v${entry.version}_${ts}${ext}`;
    await copyFile(primaryPath, join(versionDir, archiveName));

    // Copy target version to primary
    await copyFile(targetPath, primaryPath);

    // Update registry
    const buffer = await readFile(primaryPath);
    const checksum = createHash("sha256").update(buffer).digest("hex");
    const fileStat = await stat(primaryPath);

    await store.update(entry.id, {
      version: entry.version + 1,
      sizeBytes: fileStat.size,
      checksum,
    });

    await store.logEvent(
      entry.id,
      "versioned",
      "system",
      `Rolled back from v${entry.version} to v${targetVersion}`,
    );

    log.info("file rolled back", { fileId: entry.id, from: entry.version, to: targetVersion });
    return { ok: true, message: `Rolled back to version ${targetVersion}` };
  } catch (err: any) {
    log.error("rollback failed", { fileId: entry.id, target: targetVersion, error: err.message });
    return { ok: false, message: `Rollback failed: ${err.message}` };
  }
}

/**
 * Remove old versions beyond the max limit (keep the most recent N).
 */
async function pruneVersions(
  fileId: string,
  storageRoot: string,
  maxVersions: number,
): Promise<void> {
  const versions = await listVersions(fileId, storageRoot);
  if (versions.length <= maxVersions) return;

  // Remove oldest versions first
  const toRemove = versions.slice(0, versions.length - maxVersions);
  for (const v of toRemove) {
    try {
      await unlink(join(storageRoot, v.storagePath));
      log.debug("pruned old version", { fileId, version: v.version });
    } catch {
      // Ignore — file may already be gone
    }
  }
}
