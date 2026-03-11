/**
 * Extensions — capability delivery system.
 *
 * The npm package ships local-tier modules only. Higher-tier code
 * (integrations, agent spawning, browser automation) streams from
 * runcore.sh on activation and caches locally.
 */

export { loadExtensionModule, ensureExtension, setCoreVersion, getCoreVersion, ExtensionLoadError } from "./loader.js";
export { isCached, verifyExtension, listCached, purge, purgeAll, cacheRoot } from "./cache.js";
export { streamExtension, checkForUpdate, verifyManifestSignature, ExtensionStreamError } from "./client.js";
export type { ExtensionManifest, ExtensionName, ExtensionModule } from "./manifest.js";
export { EXTENSION_TIERS, extensionTier } from "./manifest.js";
