/**
 * Extension disk cache — stores streamed modules locally.
 *
 * Layout:
 *   ~/.runcore/extensions/
 *     ext-byok/0.4.0/
 *       manifest.json
 *       vault/store.js
 *       notifications/channel.js
 *       ...
 *     ext-spawn/0.4.0/
 *       agents/spawn.js
 *       ...
 *     .integrity   ← SHA-256 hashes for quick verification
 *
 * Fallback: dist/.extensions/ if home dir is unavailable.
 */

import { readFile, writeFile, mkdir, rm, access, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import type { ExtensionManifest, ExtensionName } from "./manifest.js";

const CACHE_DIR_NAME = ".runcore";
const EXT_DIR_NAME = "extensions";
const INTEGRITY_FILE = ".integrity";
const MANIFEST_FILE = "manifest.json";

/** Resolve the cache root directory */
export function cacheRoot(): string {
  try {
    return join(homedir(), CACHE_DIR_NAME, EXT_DIR_NAME);
  } catch {
    // Fallback for environments without home dir (containers, CI)
    return join(process.cwd(), "dist", ".extensions");
  }
}

/** Path to a specific extension version directory */
export function extensionDir(name: ExtensionName, version: string): string {
  return join(cacheRoot(), name, version);
}

/** Path to a cached module file */
export function modulePath(
  name: ExtensionName,
  version: string,
  modulePath: string
): string {
  return join(extensionDir(name, version), modulePath);
}

/** SHA-256 hash of a buffer or string */
export function sha256(data: Buffer | string): string {
  return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}

/** Check if an extension is cached for a given version */
export async function isCached(
  name: ExtensionName,
  version: string
): Promise<boolean> {
  try {
    const dir = extensionDir(name, version);
    await access(join(dir, MANIFEST_FILE));
    return true;
  } catch {
    return false;
  }
}

/** Load the cached manifest for an extension */
export async function loadCachedManifest(
  name: ExtensionName,
  version: string
): Promise<ExtensionManifest | null> {
  try {
    const raw = await readFile(
      join(extensionDir(name, version), MANIFEST_FILE),
      "utf-8"
    );
    return JSON.parse(raw) as ExtensionManifest;
  } catch {
    return null;
  }
}

/** Verify integrity of a single cached module file */
export async function verifyModule(
  name: ExtensionName,
  version: string,
  path: string,
  expectedHash: string
): Promise<boolean> {
  try {
    const filePath = modulePath(name, version, path);
    const content = await readFile(filePath);
    return sha256(content) === expectedHash;
  } catch {
    return false;
  }
}

/** Verify all modules in a cached extension against its manifest */
export async function verifyExtension(
  name: ExtensionName,
  version: string
): Promise<{ valid: boolean; corrupted: string[] }> {
  const manifest = await loadCachedManifest(name, version);
  if (!manifest) return { valid: false, corrupted: ["manifest.json"] };

  const corrupted: string[] = [];
  for (const mod of manifest.modules) {
    const ok = await verifyModule(name, version, mod.path, mod.hash);
    if (!ok) corrupted.push(mod.path);
  }

  return { valid: corrupted.length === 0, corrupted };
}

/**
 * Write a module file to the cache.
 * Creates parent directories as needed.
 */
export async function writeModule(
  name: ExtensionName,
  version: string,
  path: string,
  content: Buffer
): Promise<void> {
  const filePath = modulePath(name, version, path);
  const dir = filePath.substring(0, filePath.lastIndexOf("/")) || filePath.substring(0, filePath.lastIndexOf("\\"));
  await mkdir(dir, { recursive: true });
  await writeFile(filePath, content);
}

/** Write the manifest to the cache */
export async function writeManifest(
  name: ExtensionName,
  version: string,
  manifest: ExtensionManifest
): Promise<void> {
  const dir = extensionDir(name, version);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, MANIFEST_FILE),
    JSON.stringify(manifest, null, 2),
    "utf-8"
  );
}

/** Update the integrity file with current hashes */
export async function writeIntegrity(
  name: ExtensionName,
  version: string,
  hashes: Record<string, string>
): Promise<void> {
  const dir = extensionDir(name, version);
  await writeFile(
    join(dir, INTEGRITY_FILE),
    JSON.stringify(hashes, null, 2),
    "utf-8"
  );
}

/** Remove a cached extension entirely */
export async function purge(
  name: ExtensionName,
  version: string
): Promise<void> {
  const dir = extensionDir(name, version);
  await rm(dir, { recursive: true, force: true });
}

/** Remove all cached versions of an extension */
export async function purgeAll(name: ExtensionName): Promise<void> {
  const dir = join(cacheRoot(), name);
  await rm(dir, { recursive: true, force: true });
}

/** List all cached extension versions */
export async function listCached(): Promise<
  Array<{ name: ExtensionName; version: string; sizeBytes: number }>
> {
  const root = cacheRoot();
  const results: Array<{ name: ExtensionName; version: string; sizeBytes: number }> = [];

  try {
    const extDirs = await readdir(root);
    for (const name of extDirs) {
      if (name.startsWith(".")) continue;
      const extPath = join(root, name);
      const s = await stat(extPath);
      if (!s.isDirectory()) continue;

      const versions = await readdir(extPath);
      for (const version of versions) {
        const vPath = join(extPath, version);
        const vs = await stat(vPath);
        if (!vs.isDirectory()) continue;
        // Rough size estimate from manifest
        const sizeBytes = await dirSize(vPath);
        results.push({ name: name as ExtensionName, version, sizeBytes });
      }
    }
  } catch {
    // Cache dir doesn't exist yet — that's fine
  }

  return results;
}

/** Recursively calculate directory size */
async function dirSize(dir: string): Promise<number> {
  let total = 0;
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        total += await dirSize(path);
      } else {
        const s = await stat(path);
        total += s.size;
      }
    }
  } catch {}
  return total;
}
