/**
 * UI sync — pulls the latest UI bundle from runcore.sh on first boot.
 * npm package ships only the engine. UI arrives from the CDN, cached locally.
 *
 * Flow:
 *   1. Check brain/.ui/revision.json — if present and fresh, skip
 *   2. Fetch https://runcore.sh/ui/manifest.json — current revision + tarball URL
 *   3. If revision matches cached, skip
 *   4. Download + extract tarball to brain/.ui/public/
 *   5. Stamp revision.json with revision, timestamp, npm version
 *
 * Falls back to bundled public/ (in npm package) if CDN unreachable.
 */

import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { BRAIN_DIR } from "./lib/paths.js";
import { createLogger } from "./utils/logger.js";

const log = createLogger("ui-sync");

const UI_BASE_URL = process.env.CORE_UI_URL ?? "https://runcore.sh/ui";
const UI_CACHE_DIR = join(BRAIN_DIR, ".ui");
const UI_PUBLIC_DIR = join(UI_CACHE_DIR, "public");
const REVISION_PATH = join(UI_CACHE_DIR, "revision.json");

export interface UiRevision {
  revision: string;
  downloadedAt: string;
  npmVersion?: string;
  url?: string;
}

/**
 * Returns the path to the UI public directory.
 * Prefers the synced CDN version; falls back to bundled package version.
 */
export function getUiPublicDir(pkgRoot: string): string {
  if (existsSync(join(UI_PUBLIC_DIR, "index.html"))) {
    return UI_PUBLIC_DIR;
  }
  // Fallback: bundled in npm package
  return join(pkgRoot, "public");
}

/**
 * Read the current cached revision, or null if not synced yet.
 */
async function readRevision(): Promise<UiRevision | null> {
  try {
    const raw = await readFile(REVISION_PATH, "utf-8");
    return JSON.parse(raw) as UiRevision;
  } catch {
    return null;
  }
}

/**
 * Sync UI from runcore.sh. Non-blocking, non-fatal.
 * Call at startup — if CDN is unreachable, falls back to bundled.
 */
export async function syncUi(npmVersion?: string): Promise<{ synced: boolean; revision?: string; source: "cdn" | "cached" | "bundled" }> {
  try {
    // Check manifest
    const manifestRes = await fetch(`${UI_BASE_URL}/manifest.json`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!manifestRes.ok) {
      log.warn("UI manifest fetch failed", { status: manifestRes.status });
      return { synced: false, source: existsSync(UI_PUBLIC_DIR) ? "cached" : "bundled" };
    }

    const manifest = await manifestRes.json() as { revision: string; tarball: string };

    // Check if already up to date
    const cached = await readRevision();
    if (cached?.revision === manifest.revision) {
      log.info("UI up to date", { revision: manifest.revision });
      return { synced: false, revision: manifest.revision, source: "cached" };
    }

    // Download tarball
    log.info("Downloading UI update", { revision: manifest.revision });
    const tarballUrl = manifest.tarball.startsWith("http") ? manifest.tarball : `${UI_BASE_URL}/${manifest.tarball}`;
    const tarRes = await fetch(tarballUrl, { signal: AbortSignal.timeout(30_000) });
    if (!tarRes.ok || !tarRes.body) {
      log.warn("UI tarball download failed", { status: tarRes.status });
      return { synced: false, source: existsSync(UI_PUBLIC_DIR) ? "cached" : "bundled" };
    }

    // Extract — use tar if available, otherwise simple approach
    await mkdir(UI_PUBLIC_DIR, { recursive: true });

    // Write tarball to temp file, then extract
    const tarballPath = join(UI_CACHE_DIR, "ui.tar.gz");
    const arrayBuf = await tarRes.arrayBuffer();
    await writeFile(tarballPath, Buffer.from(arrayBuf));

    // Extract using tar command (available on all platforms with Node)
    const { exec } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execAsync = promisify(exec);

    // Clean old UI files before extracting
    await rm(UI_PUBLIC_DIR, { recursive: true, force: true });
    await mkdir(UI_PUBLIC_DIR, { recursive: true });

    await execAsync(`tar -xzf "${tarballPath}" -C "${UI_PUBLIC_DIR}"`, { timeout: 15_000 });

    // Clean up tarball
    await rm(tarballPath, { force: true });

    // Stamp revision
    const revision: UiRevision = {
      revision: manifest.revision,
      downloadedAt: new Date().toISOString(),
      npmVersion,
      url: tarballUrl,
    };
    await writeFile(REVISION_PATH, JSON.stringify(revision, null, 2), "utf-8");

    log.info("UI synced", { revision: manifest.revision });
    return { synced: true, revision: manifest.revision, source: "cdn" };
  } catch (err: any) {
    log.warn("UI sync failed, using fallback", { error: err.message });
    return { synced: false, source: existsSync(UI_PUBLIC_DIR) ? "cached" : "bundled" };
  }
}
