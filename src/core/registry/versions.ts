/**
 * Template & Skill Sharing Registry — Version management.
 *
 * Handles version listing, comparison, rollback, and compatibility checks
 * for registry entries. Builds on the version records stored by RegistryStore.
 */

import type { RegistryEntry, RegistryVersion } from "./types.js";
import type { RegistryStore } from "./store.js";
import { computeChecksum, compareSemver } from "./publisher.js";

// ---------------------------------------------------------------------------
// Version info
// ---------------------------------------------------------------------------

/** Summary of an entry's version history. */
export interface VersionHistory {
  entryId: string;
  currentVersion: string;
  versions: VersionSummary[];
}

/** Minimal version info for listing. */
export interface VersionSummary {
  version: string;
  changelog: string;
  publishedAt: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get the full version history for a registry entry.
 */
export function getVersionHistory(
  entry: RegistryEntry,
  store: RegistryStore,
): VersionHistory {
  const versions = store.getVersions(entry.id);
  return {
    entryId: entry.id,
    currentVersion: entry.version,
    versions: versions.map((v) => ({
      version: v.version,
      changelog: v.changelog,
      publishedAt: v.publishedAt,
    })),
  };
}

/**
 * Get the content of a specific version for an entry.
 * Returns null if the version doesn't exist.
 */
export function getVersionContent(
  entryId: string,
  version: string,
  store: RegistryStore,
): string | null {
  const ver = store.getVersion(entryId, version);
  return ver?.content ?? null;
}

/**
 * Check if a specific version exists for an entry.
 */
export function hasVersion(
  entryId: string,
  version: string,
  store: RegistryStore,
): boolean {
  return store.getVersion(entryId, version) !== undefined;
}

/**
 * Get the latest version record for an entry.
 */
export function getLatestVersion(
  entryId: string,
  store: RegistryStore,
): RegistryVersion | null {
  const versions = store.getVersions(entryId);
  if (versions.length === 0) return null;
  // Already sorted newest first by store.getVersions()
  return versions[0];
}

/**
 * Verify the integrity of a version's content against its checksum.
 */
export function verifyChecksum(version: RegistryVersion): boolean {
  return computeChecksum(version.content) === version.checksum;
}

/**
 * Rollback an entry to a previous version.
 * Updates the entry in-place and persists the change.
 * Returns the rolled-back entry, or null if the version doesn't exist.
 */
export async function rollbackToVersion(
  entryId: string,
  targetVersion: string,
  store: RegistryStore,
): Promise<RegistryEntry | null> {
  const entry = store.getEntry(entryId);
  if (!entry) return null;

  const ver = store.getVersion(entryId, targetVersion);
  if (!ver) return null;

  // Verify integrity before rollback
  if (!verifyChecksum(ver)) return null;

  // Update entry to point at the rolled-back content
  const updated: RegistryEntry = {
    ...entry,
    version: ver.version,
    content: ver.content,
    checksum: ver.checksum,
    updatedAt: new Date().toISOString(),
  };

  await store.saveEntry(updated);
  return updated;
}

/**
 * Check if an update is available by comparing a local version against the registry.
 */
export function isUpdateAvailable(
  localVersion: string,
  entry: RegistryEntry,
): boolean {
  return compareSemver(entry.version, localVersion) > 0;
}

/**
 * List versions newer than a given version.
 */
export function getNewerVersions(
  entryId: string,
  sinceVersion: string,
  store: RegistryStore,
): VersionSummary[] {
  const versions = store.getVersions(entryId);
  return versions
    .filter((v) => compareSemver(v.version, sinceVersion) > 0)
    .map((v) => ({
      version: v.version,
      changelog: v.changelog,
      publishedAt: v.publishedAt,
    }));
}
