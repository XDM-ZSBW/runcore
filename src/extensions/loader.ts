/**
 * Extension loader — the core of the capability delivery system.
 *
 * Resolves module imports through: cache check → integrity verify → stream if missing.
 * Same pattern as the 91 existing `await import()` calls in the codebase,
 * but routed through cache + stream instead of static file paths.
 *
 * Usage:
 *   const { AgentInstanceManager } = await loadExtensionModule<
 *     typeof import("./agents/instance-manager.js")
 *   >("ext-spawn", "agents/instance-manager.js");
 */

import { pathToFileURL } from "node:url";
import { createLogger } from "../utils/logger.js";
import type { ExtensionName } from "./manifest.js";
import { EXTENSION_TIERS } from "./manifest.js";
import {
  isCached,
  verifyModule,
  modulePath,
  loadCachedManifest,
  writeModule,
  writeManifest,
  writeIntegrity,
  purge,
  sha256,
} from "./cache.js";
import { streamExtension, ExtensionStreamError } from "./client.js";
import { loadActivationToken } from "../tier/token.js";
import { meetsMinimum } from "../tier/gate.js";

const log = createLogger("ext-loader");

/** Version of the core package — used for cache keying */
let _coreVersion = "0.4.0";

/** Set the core version (called at startup from package.json) */
export function setCoreVersion(version: string): void {
  _coreVersion = version;
}

/** Get the current core version */
export function getCoreVersion(): string {
  return _coreVersion;
}

/**
 * Load a module from an extension.
 *
 * Resolution order:
 * 1. Check if extension is cached for current version
 * 2. Verify file integrity (SHA-256)
 * 3. If missing or corrupt, stream from runcore.sh
 * 4. Dynamic import the resolved file
 *
 * @param extension - Extension name (e.g. "ext-spawn")
 * @param module - Module path within extension (e.g. "agents/spawn.js")
 * @param root - Brain root directory (for token + bond key access)
 * @returns The imported module
 */
export async function loadExtensionModule<T = unknown>(
  extension: ExtensionName,
  module: string,
  root?: string
): Promise<T> {
  const resolvedRoot = root ?? process.cwd();
  const version = _coreVersion;

  // Check tier before attempting load
  const activation = await loadActivationToken(resolvedRoot);
  const currentTier = activation?.token.tier ?? "local";
  const requiredTier = EXTENSION_TIERS[extension];

  if (!meetsMinimum(currentTier, requiredTier)) {
    throw new ExtensionLoadError(
      `Extension "${extension}" requires tier "${requiredTier}" (current: "${currentTier}"). ` +
        `Run \`runcore register\` to upgrade.`,
      "TIER_INSUFFICIENT",
      extension,
      module
    );
  }

  // Try loading from cache
  const cached = await isCached(extension, version);
  if (cached) {
    const manifest = await loadCachedManifest(extension, version);
    if (manifest) {
      const modEntry = manifest.modules.find((m) => m.path === module);
      if (modEntry) {
        // Verify integrity
        const valid = await verifyModule(extension, version, module, modEntry.hash);
        if (valid) {
          return dynamicImport<T>(extension, version, module);
        }
        // Corrupted — purge and re-stream
        log.warn(`Integrity check failed for ${extension}/${module} — re-downloading`);
        await purge(extension, version);
      }
    }
  }

  // Stream from runcore.sh
  if (!activation) {
    throw new ExtensionLoadError(
      `Extension "${extension}" not cached and no activation token found. ` +
        `Run \`runcore activate <token>\` first.`,
      "NOT_CACHED",
      extension,
      module
    );
  }

  log.info(`Streaming ${extension}@${version} for module ${module}...`);
  const result = await streamExtension({
    jwt: activation.raw,
    name: extension,
    version,
    root: resolvedRoot,
  });

  // Write all files to cache
  const hashes: Record<string, string> = {};
  for (const [path, content] of result.files) {
    await writeModule(extension, version, path, content);
    hashes[path] = sha256(content);
  }
  await writeManifest(extension, version, result.manifest);
  await writeIntegrity(extension, version, hashes);

  // Verify the target module exists in the downloaded set
  if (!result.files.has(module)) {
    throw new ExtensionLoadError(
      `Module "${module}" not found in extension "${extension}@${version}".`,
      "MODULE_NOT_FOUND",
      extension,
      module
    );
  }

  return dynamicImport<T>(extension, version, module);
}

/**
 * Ensure an entire extension is cached.
 * Used by `runcore sync` to pre-pull extensions.
 */
export async function ensureExtension(
  extension: ExtensionName,
  root: string,
  options?: { force?: boolean }
): Promise<{ cached: boolean; modules: number }> {
  const version = _coreVersion;

  // Check tier
  const activation = await loadActivationToken(root);
  const currentTier = activation?.token.tier ?? "local";
  const requiredTier = EXTENSION_TIERS[extension];

  if (!meetsMinimum(currentTier, requiredTier)) {
    return { cached: false, modules: 0 };
  }

  // Already cached (and not forcing)?
  if (!options?.force && (await isCached(extension, version))) {
    const manifest = await loadCachedManifest(extension, version);
    return { cached: true, modules: manifest?.modules.length ?? 0 };
  }

  if (!activation) {
    return { cached: false, modules: 0 };
  }

  // Force purge if requested
  if (options?.force) {
    await purge(extension, version);
  }

  // Stream
  const result = await streamExtension({
    jwt: activation.raw,
    name: extension,
    version,
    root,
  });

  // Write to cache
  const hashes: Record<string, string> = {};
  for (const [path, content] of result.files) {
    await writeModule(extension, version, path, content);
    hashes[path] = sha256(content);
  }
  await writeManifest(extension, version, result.manifest);
  await writeIntegrity(extension, version, hashes);

  return { cached: true, modules: result.files.size };
}

/** Dynamic import from the cache directory */
async function dynamicImport<T>(
  extension: ExtensionName,
  version: string,
  module: string
): Promise<T> {
  const filePath = modulePath(extension, version, module);
  const fileUrl = pathToFileURL(filePath).href;

  try {
    return (await import(fileUrl)) as T;
  } catch (err) {
    throw new ExtensionLoadError(
      `Failed to import ${extension}/${module}: ${err instanceof Error ? err.message : String(err)}`,
      "IMPORT_FAILED",
      extension,
      module
    );
  }
}

/** Typed error for extension loading failures */
export class ExtensionLoadError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "TIER_INSUFFICIENT"
      | "NOT_CACHED"
      | "MODULE_NOT_FOUND"
      | "IMPORT_FAILED"
      | "INTEGRITY_FAILED",
    public readonly extension: ExtensionName,
    public readonly module: string
  ) {
    super(message);
    this.name = "ExtensionLoadError";
  }
}
