/**
 * Avatar client — communicates with the MuseTalk FastAPI sidecar.
 * Handles photo preparation, video generation, and MP4 caching.
 */

import { createHash } from "node:crypto";
import { readFile, writeFile, readdir, stat, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { getAvatarConfig } from "../settings.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("avatar-client");

const CACHE_DIR = join(process.cwd(), "public", "avatar", "cache");
const MAX_CACHE_ENTRIES = 50;

/** In-flight guard — only one generate request at a time. */
let generating = false;

function baseUrl(): string {
  return `http://127.0.0.1:${getAvatarConfig().port}`;
}

/**
 * Health probe — GET /health, 3-second timeout.
 */
export async function checkAvatarSidecar(): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl()}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return false;
    const data = await res.json() as { ready?: boolean };
    return !!data.ready;
  } catch {
    return false;
  }
}

/**
 * Prepare a reference photo for lip-sync generation.
 * POST /prepare with the photo file. Runs face detection + VAE encode (cached on sidecar side).
 */
export async function preparePhoto(photoPath: string): Promise<boolean> {
  try {
    const photoBytes = await readFile(photoPath);
    const formData = new FormData();
    formData.append("photo", new Blob([photoBytes]), "photo.png");

    const res = await fetch(`${baseUrl()}/prepare`, {
      method: "POST",
      body: formData,
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: string };
      log.warn(` Prepare failed: ${err.error ?? res.statusText}`);
      return false;
    }

    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(` Prepare error: ${msg}`);
    return false;
  }
}

/**
 * Generate a lip-synced MP4 from WAV audio.
 * POST /generate with WAV bytes. Returns MP4 Buffer or null.
 * Timeout: 120s (generation time ≈ audio duration).
 */
export async function generateVideo(wavBuffer: Buffer): Promise<Buffer | null> {
  if (generating) {
    log.warn(` Skipped — generation already in flight`);
    return null;
  }
  generating = true;
  try {
    const formData = new FormData();
    formData.append("audio", new Blob([wavBuffer]), "audio.wav");

    const res = await fetch(`${baseUrl()}/generate`, {
      method: "POST",
      body: formData,
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: string };
      log.warn(` Generate failed: ${err.error ?? res.statusText}`);
      return null;
    }

    const arrayBuf = await res.arrayBuffer();
    return Buffer.from(arrayBuf);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(` Generate error: ${msg}`);
    return null;
  } finally {
    generating = false;
  }
}

/** Compute SHA-256 hash of a buffer (for cache keys). */
function hashBuffer(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex").slice(0, 16);
}

/**
 * Check if a video is already cached for the given WAV audio.
 * Returns the cache filename (hash.mp4) if found, null otherwise.
 */
export async function getCachedVideo(wavBuffer: Buffer): Promise<string | null> {
  const hash = hashBuffer(wavBuffer);
  const cachePath = join(CACHE_DIR, `${hash}.mp4`);
  try {
    await stat(cachePath);
    return `${hash}.mp4`;
  } catch {
    return null;
  }
}

/**
 * Cache an MP4 video, keyed by WAV audio hash.
 * Returns the cache filename (hash.mp4).
 */
export async function cacheVideo(mp4Buffer: Buffer, wavBuffer: Buffer): Promise<string> {
  await mkdir(CACHE_DIR, { recursive: true });
  const hash = hashBuffer(wavBuffer);
  const filename = `${hash}.mp4`;
  await writeFile(join(CACHE_DIR, filename), mp4Buffer);
  await pruneCache();
  return filename;
}

/**
 * Prune the cache directory to keep at most MAX_CACHE_ENTRIES files.
 * Removes oldest files by modification time.
 */
async function pruneCache(): Promise<void> {
  try {
    const files = await readdir(CACHE_DIR);
    const mp4Files = files.filter((f) => f.endsWith(".mp4"));

    if (mp4Files.length <= MAX_CACHE_ENTRIES) return;

    // Get mtimes for sorting
    const withStats = await Promise.all(
      mp4Files.map(async (f) => {
        const s = await stat(join(CACHE_DIR, f));
        return { name: f, mtime: s.mtimeMs };
      })
    );

    // Sort oldest first
    withStats.sort((a, b) => a.mtime - b.mtime);

    // Remove oldest entries beyond the limit
    const toRemove = withStats.slice(0, withStats.length - MAX_CACHE_ENTRIES);
    for (const f of toRemove) {
      await unlink(join(CACHE_DIR, f.name)).catch(() => {});
    }
  } catch {
    // Cache dir may not exist yet — that's fine
  }
}

/**
 * Clear all cached videos. Used when the reference photo changes.
 */
export async function clearVideoCache(): Promise<void> {
  try {
    const files = await readdir(CACHE_DIR);
    for (const f of files) {
      if (f.endsWith(".mp4")) {
        await unlink(join(CACHE_DIR, f)).catch(() => {});
      }
    }
  } catch {
    // Cache dir may not exist yet
  }
}
