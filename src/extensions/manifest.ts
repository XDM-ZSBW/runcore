/**
 * Extension manifest types — describes a streamed capability bundle.
 *
 * Each extension is a tier-gated set of modules that don't ship in the
 * npm package. They stream from runcore.sh on activation and cache locally.
 */

import type { TierName } from "../tier/types.js";

/** Individual module within an extension */
export interface ExtensionModule {
  /** Relative path within extension (e.g. "vault/store.js") */
  path: string;
  /** SHA-256 hash of the file contents */
  hash: string;
}

/** Extension manifest — shipped inside each extension tarball */
export interface ExtensionManifest {
  /** Extension identifier (e.g. "ext-byok", "ext-spawn", "ext-hosted") */
  name: ExtensionName;
  /** Semver, locked to core package version */
  version: string;
  /** Minimum core version required */
  minCoreVersion: string;
  /** Tier required to activate this extension */
  tier: TierName;
  /** All modules in this extension */
  modules: ExtensionModule[];
  /** npm dependencies this extension needs (informational — installed by sync) */
  dependencies?: Record<string, string>;
  /** Ed25519 signature of the manifest (excluding this field) */
  signature?: string;
}

/** Known extension names */
export type ExtensionName = "ext-byok" | "ext-spawn" | "ext-hosted";

/** Extension tier mapping */
export const EXTENSION_TIERS: Record<ExtensionName, TierName> = {
  "ext-byok": "byok",
  "ext-spawn": "spawn",
  "ext-hosted": "hosted",
};

/** Map extension name to required tier level */
export function extensionTier(name: ExtensionName): TierName {
  return EXTENSION_TIERS[name];
}
