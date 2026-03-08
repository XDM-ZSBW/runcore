/**
 * Dictionary Protocol — Backward compatibility checks.
 */

import type { Dictionary, CompatibilityResult } from "./types.js";
import { parseSemver, getBumpType } from "./versioning.js";

export function checkCompatibility(
  localVersion: string,
  remoteDictionary: Dictionary,
): CompatibilityResult {
  const remoteVersion = remoteDictionary.version;
  const bump = getBumpType(localVersion, remoteVersion);
  const breakingChanges: string[] = [];
  const warnings: string[] = [];

  if (bump === "downgrade") {
    return {
      compatible: false,
      localVersion,
      remoteVersion,
      breakingChanges: [`Remote version ${remoteVersion} is older than local ${localVersion}`],
      warnings: [],
    };
  }

  if (bump === "major") {
    const local = parseSemver(localVersion);
    const remote = parseSemver(remoteVersion);
    breakingChanges.push(
      `Major version bump ${local.major} -> ${remote.major} — protocol changes may be breaking`,
    );
  }

  if (bump === "minor") {
    warnings.push(
      `Minor version bump — new features may be available but existing behavior is preserved`,
    );
  }

  return {
    compatible: breakingChanges.length === 0,
    localVersion,
    remoteVersion,
    breakingChanges,
    warnings,
  };
}

export function canCommunicate(versionA: string, versionB: string): boolean {
  const a = parseSemver(versionA);
  const b = parseSemver(versionB);
  return a.major === b.major;
}

export function validateDictionary(dict: unknown): dict is Dictionary {
  if (!dict || typeof dict !== "object") return false;
  const d = dict as Record<string, unknown>;
  if (typeof d.version !== "string") return false;
  if (typeof d.publishedAt !== "string") return false;
  if (!Array.isArray(d.specs)) return false;
  if (!d.glossary || typeof d.glossary !== "object") return false;
  if (!d.defaults || typeof d.defaults !== "object") return false;
  return true;
}
