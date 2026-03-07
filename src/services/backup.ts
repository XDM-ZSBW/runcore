/**
 * Automated brain backup service — DASH-147.
 * Schedules periodic backups of the brain/ directory to configured storage providers.
 * Brain files are already encrypted at rest (DASH-148), so backup is just file sync.
 * Safe word never leaves the local machine.
 *
 * Recovery process: clone repo → pull backup → enter safe word → brain reconstituted.
 */

import { readFile, readdir, stat, mkdir, writeFile, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createLogger } from "../utils/logger.js";
import { logActivity } from "../activity/log.js";
import { isEncryptedLine } from "../lib/encryption.js";
import { getBackupConfig, type BackupConfig } from "../settings.js";
import type { StorageAdapter, BackupManifest, BackupFileEntry, BackupResult } from "../adapters/storage/types.js";
import { LocalStorageAdapter } from "../adapters/storage/local.js";
import { GDriveBackupAdapter } from "../adapters/storage/gdrive-backup.js";

const log = createLogger("backup");

const execFileAsync = promisify(execFile);

export type BackupProvider = "local" | "gdrive";

// ── Module state ─────────────────────────────────────────────────────────────

let timer: ReturnType<typeof setInterval> | null = null;
let lastBackup: BackupManifest | null = null;
let lastBackupError: string | null = null;

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // Check every hour

// ── Timer lifecycle ──────────────────────────────────────────────────────────

export function startBackupTimer(): void {
  if (timer) return;
  const config = getBackupConfig();

  if (!config.enabled) {
    log.info("backup service disabled, not starting timer");
    return;
  }

  timer = setInterval(async () => {
    try {
      await checkAndRunScheduledBackup();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("backup timer error", { error: msg });
      logActivity({ source: "system", summary: `Backup timer error: ${msg}` });
    }
  }, CHECK_INTERVAL_MS);

  log.info(`backup timer started: schedule=${config.schedule}, providers=${config.providers.join(",")}`);
}

export function stopBackupTimer(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export function isBackupTimerRunning(): boolean {
  return timer !== null;
}

export function getLastBackup(): BackupManifest | null {
  return lastBackup;
}

export function getLastBackupError(): string | null {
  return lastBackupError;
}

export function getActiveBackupConfig(): BackupConfig {
  return getBackupConfig();
}

// ── Schedule check ───────────────────────────────────────────────────────────

let lastScheduledRun: string | null = null;

async function checkAndRunScheduledBackup(): Promise<void> {
  const now = new Date();
  const hour = now.getHours();

  // Only run at the configured hour
  if (hour !== getBackupConfig().backupHour) return;

  // Build a date key to avoid running more than once per day
  const dateKey = now.toISOString().slice(0, 10);

  if (getBackupConfig().schedule === "weekly") {
    // Only run on Sundays
    if (now.getDay() !== 0) return;
  }

  // Already ran today
  if (lastScheduledRun === dateKey) return;
  lastScheduledRun = dateKey;

  log.info("running scheduled backup", { schedule: getBackupConfig().schedule, dateKey });
  const result = await runBackup();

  if (result.ok) {
    logActivity({
      source: "system",
      summary: `Scheduled backup completed: ${result.message}`,
    });
  } else {
    logActivity({
      source: "system",
      summary: `Scheduled backup failed: ${result.message}`,
    });
  }
}

// ── Core backup logic ────────────────────────────────────────────────────────

import { BRAIN_DIR } from "../lib/paths.js";
const TEMP_DIR = join(process.cwd(), ".core-backups", "tmp");

/**
 * Run a backup of the brain/ directory to all configured providers.
 * Can be called manually or by the scheduler.
 */
export async function runBackup(
  overrideProviders?: BackupProvider[],
): Promise<BackupResult> {
  const providers = overrideProviders ?? getBackupConfig().providers;
  const backupId = `backup_${Date.now()}_${randomBytes(4).toString("hex")}`;
  const timestamp = new Date().toISOString();

  log.info("starting backup", { backupId, providers });

  try {
    // 1. Scan brain directory and build manifest
    const files = await scanBrainFiles(BRAIN_DIR);
    const totalBytes = files.reduce((sum, f) => sum + f.sizeBytes, 0);

    const manifest: BackupManifest = {
      id: backupId,
      timestamp,
      files,
      totalBytes,
      provider: providers.join(","),
    };

    // 2. Create tar.gz archive
    await mkdir(TEMP_DIR, { recursive: true });
    const archiveName = `${backupId}.tar.gz`;
    const archivePath = join(TEMP_DIR, archiveName);
    const manifestPath = join(TEMP_DIR, `${backupId}.manifest.json`);

    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

    await createTarGz(BRAIN_DIR, archivePath);

    // 3. Upload to each provider
    const adapters = providers.map((p) => getAdapter(p));
    const results: { provider: string; ok: boolean; message: string }[] = [];

    for (const adapter of adapters) {
      const available = await adapter.isAvailable();
      if (!available) {
        results.push({ provider: adapter.name, ok: false, message: `${adapter.name} not available` });
        continue;
      }

      const uploadResult = await adapter.upload(archivePath, archiveName);
      results.push({ provider: adapter.name, ok: uploadResult.ok, message: uploadResult.message });

      // Prune old backups
      if (uploadResult.ok && getBackupConfig().maxBackups > 0) {
        await pruneOldBackups(adapter, getBackupConfig().maxBackups);
      }
    }

    // 4. Clean up temp files
    await rm(TEMP_DIR, { recursive: true, force: true }).catch(() => {});

    // 5. Check results
    const allOk = results.every((r) => r.ok);
    const summary = results.map((r) => `${r.provider}: ${r.ok ? "OK" : r.message}`).join("; ");

    if (allOk) {
      lastBackup = manifest;
      lastBackupError = null;
      log.info("backup completed", { backupId, files: files.length, totalBytes, summary });
      return { ok: true, message: summary, manifest };
    }

    const anyOk = results.some((r) => r.ok);
    lastBackupError = summary;
    if (anyOk) lastBackup = manifest;

    log.warn("backup partially failed", { summary });
    return { ok: anyOk, message: summary, manifest: anyOk ? manifest : undefined };
  } catch (err: any) {
    lastBackupError = err.message;
    log.error("backup failed", { backupId, error: err.message });
    return { ok: false, message: `Backup failed: ${err.message}` };
  }
}

/**
 * Restore brain/ from a backup archive.
 * After restore, user must enter safe word to decrypt episodic files.
 */
export async function restoreBackup(
  provider: BackupProvider,
  backupId: string,
): Promise<{ ok: boolean; message: string }> {
  const adapter = getAdapter(provider);
  const available = await adapter.isAvailable();
  if (!available) return { ok: false, message: `${provider} not available` };

  try {
    await mkdir(TEMP_DIR, { recursive: true });
    const archiveName = `${backupId}.tar.gz`;
    const localPath = join(TEMP_DIR, archiveName);

    // Download archive
    const dlResult = await adapter.download(archiveName, localPath);
    if (!dlResult.ok) return { ok: false, message: dlResult.message };

    // Extract to brain/
    await extractTarGz(localPath, BRAIN_DIR);

    // Clean up temp
    await rm(TEMP_DIR, { recursive: true, force: true }).catch(() => {});

    log.info("backup restored", { backupId, provider });
    logActivity({
      source: "system",
      summary: `Brain restored from backup ${backupId} (${provider}). Enter safe word to decrypt episodic files.`,
    });

    return { ok: true, message: `Restored from ${provider}. Enter safe word to decrypt episodic files.` };
  } catch (err: any) {
    log.error("restore failed", { backupId, error: err.message });
    return { ok: false, message: `Restore failed: ${err.message}` };
  }
}

/**
 * Verify a backup by checking manifest checksums against stored files.
 */
export async function verifyBackup(
  provider: BackupProvider,
  backupId: string,
): Promise<{ ok: boolean; message: string; mismatches: string[] }> {
  const adapter = getAdapter(provider);
  const backups = await adapter.listBackups();
  const manifest = backups.find((b) => b.id === backupId);

  if (!manifest) {
    return { ok: false, message: `Backup ${backupId} not found`, mismatches: [] };
  }

  // Verify checksums against current brain files
  const mismatches: string[] = [];
  for (const entry of manifest.files) {
    const filePath = join(BRAIN_DIR, entry.relativePath);
    try {
      const content = await readFile(filePath);
      const checksum = createHash("sha256").update(content).digest("hex");
      if (checksum !== entry.checksum) {
        mismatches.push(`${entry.relativePath}: checksum mismatch (file changed since backup)`);
      }
    } catch {
      mismatches.push(`${entry.relativePath}: file not found locally`);
    }
  }

  if (mismatches.length === 0) {
    return { ok: true, message: `Backup ${backupId} verified: all ${manifest.files.length} files match`, mismatches: [] };
  }

  return {
    ok: false,
    message: `Backup ${backupId}: ${mismatches.length} mismatches out of ${manifest.files.length} files`,
    mismatches,
  };
}

/**
 * List available backups across all configured providers.
 */
export async function listBackups(
  provider?: BackupProvider,
): Promise<BackupManifest[]> {
  const providers = provider ? [provider] : getBackupConfig().providers;
  const allManifests: BackupManifest[] = [];

  for (const p of providers) {
    const adapter = getAdapter(p);
    const available = await adapter.isAvailable();
    if (!available) continue;
    const manifests = await adapter.listBackups();
    allManifests.push(...manifests);
  }

  return allManifests.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getAdapter(provider: BackupProvider): StorageAdapter {
  switch (provider) {
    case "local":
      return new LocalStorageAdapter(getBackupConfig().localBackupDir);
    case "gdrive":
      return new GDriveBackupAdapter();
    default:
      throw new Error(`Unknown backup provider: ${provider}`);
  }
}

async function scanBrainFiles(dir: string, base?: string): Promise<BackupFileEntry[]> {
  const root = base ?? dir;
  const entries: BackupFileEntry[] = [];

  const items = await readdir(dir, { withFileTypes: true });
  for (const item of items) {
    const fullPath = join(dir, item.name);
    const relPath = relative(root, fullPath);

    // Skip agent runtime files (ephemeral)
    if (relPath.startsWith(join("agents", "runtime"))) continue;
    if (relPath.startsWith(join("agents", "logs"))) continue;

    if (item.isDirectory()) {
      const subEntries = await scanBrainFiles(fullPath, root);
      entries.push(...subEntries);
    } else if (item.isFile()) {
      const fileStat = await stat(fullPath);
      const content = await readFile(fullPath);
      const checksum = createHash("sha256").update(content).digest("hex");

      // Check if any line in the file is encrypted
      let encrypted = false;
      if (item.name.endsWith(".jsonl")) {
        const text = content.toString("utf-8");
        const firstDataLine = text.split("\n").find((l) => l.trim() && !l.includes('"_schema"'));
        if (firstDataLine && isEncryptedLine(firstDataLine)) {
          encrypted = true;
        }
      }

      entries.push({
        relativePath: relPath,
        checksum,
        sizeBytes: fileStat.size,
        encrypted,
      });
    }
  }

  return entries;
}

async function createTarGz(sourceDir: string, outputPath: string): Promise<void> {
  await mkdir(join(outputPath, ".."), { recursive: true });
  // Use tar command — available on Windows (Git Bash), macOS, Linux
  const parentDir = join(sourceDir, "..");
  const dirName = sourceDir.split(/[\\/]/).pop()!;
  await execFileAsync("tar", ["-czf", outputPath, "-C", parentDir, dirName], {
    timeout: 120_000,
  });
}

async function extractTarGz(archivePath: string, targetDir: string): Promise<void> {
  const parentDir = join(targetDir, "..");
  await execFileAsync("tar", ["-xzf", archivePath, "-C", parentDir], {
    timeout: 120_000,
  });
}

async function pruneOldBackups(adapter: StorageAdapter, maxBackups: number): Promise<void> {
  try {
    const backups = await adapter.listBackups();
    if (backups.length <= maxBackups) return;

    // Delete oldest backups
    const toDelete = backups.slice(maxBackups);
    for (const backup of toDelete) {
      await adapter.deleteBackup(backup.id);
      log.info("pruned old backup", { backupId: backup.id, provider: adapter.name });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn("failed to prune old backups", { error: msg });
  }
}
