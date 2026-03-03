/**
 * Template & Skill Sharing Registry — Main service.
 *
 * Orchestrates publishing, discovery, search, versioning, and installation
 * of shared templates and skills. Integrates with the existing SkillRegistry
 * for skill installation and the agent template patterns.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  RegistryEntry,
  RegistryItemType,
  RegistryItemStatus,
  PublishRequest,
  PublishResult,
  RegistrySearchQuery,
  RegistrySearchResult,
  InstallRequest,
  InstallResult,
  ValidationResult,
} from "./types.js";
import { STATUS_TRANSITIONS, RegistryStatusError } from "./types.js";
import { RegistryStore } from "./store.js";
import { publishEntry, validatePublishRequest, computeChecksum } from "./publisher.js";
import { searchRegistry } from "./search.js";
import {
  getVersionHistory,
  getVersionContent,
  getLatestVersion,
  rollbackToVersion,
  isUpdateAvailable,
  getNewerVersions,
  verifyChecksum,
  hasVersion,
} from "./versions.js";
import type { VersionHistory, VersionSummary } from "./versions.js";

// ---------------------------------------------------------------------------
// SharingRegistry
// ---------------------------------------------------------------------------

export class SharingRegistry {
  private readonly store: RegistryStore;

  /** Path to brain directory (for skill installation). */
  private readonly brainDir: string;

  /** Path to installed skills directory. */
  private readonly installedDir: string;

  private initialized = false;

  constructor(opts: { registryDir: string; brainDir: string }) {
    this.store = new RegistryStore({ registryDir: opts.registryDir });
    this.brainDir = opts.brainDir;
    this.installedDir = join(opts.brainDir, "registry", "installed");
  }

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------

  /** Load registry state from disk. */
  async init(): Promise<void> {
    if (this.initialized) return;
    await this.store.load();
    this.initialized = true;
  }

  // -------------------------------------------------------------------------
  // Publishing
  // -------------------------------------------------------------------------

  /**
   * Publish a template or skill to the registry.
   * Creates a new entry or bumps the version of an existing one.
   */
  async publish(req: PublishRequest): Promise<PublishResult> {
    return publishEntry(req, this.store);
  }

  /**
   * Validate a publish request without actually publishing.
   * Useful for dry-run / pre-flight checks.
   */
  validate(req: PublishRequest): ValidationResult {
    return validatePublishRequest(req, this.store);
  }

  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------

  /** Search the registry with filtering, scoring, and pagination. */
  search(query: RegistrySearchQuery): RegistrySearchResult {
    return searchRegistry(this.store.allEntries(), query);
  }

  /** Get a single entry by ID. */
  getEntry(id: string): RegistryEntry | undefined {
    return this.store.getEntry(id);
  }

  /** Find an entry by name and type. */
  findEntry(name: string, type: RegistryItemType): RegistryEntry | undefined {
    return this.store.findEntry(name, type);
  }

  /** List all entries of a given type. */
  listByType(type: RegistryItemType): RegistryEntry[] {
    return this.store.allEntries().filter((e) => e.type === type && e.status !== "withdrawn");
  }

  /** Get entries that an entry depends on. */
  getDependencies(entryId: string): RegistryEntry[] {
    const entry = this.store.getEntry(entryId);
    if (!entry) return [];
    return entry.dependencies
      .map((depId) => this.store.getEntry(depId))
      .filter((e): e is RegistryEntry => e !== undefined);
  }

  // -------------------------------------------------------------------------
  // Status management
  // -------------------------------------------------------------------------

  /** Transition an entry's status (e.g., published → deprecated). */
  async setStatus(entryId: string, newStatus: RegistryItemStatus): Promise<void> {
    const entry = this.store.getEntry(entryId);
    if (!entry) throw new Error(`Registry entry not found: ${entryId}`);

    const allowed = STATUS_TRANSITIONS[entry.status];
    if (!allowed.includes(newStatus)) {
      throw new RegistryStatusError(entryId, entry.status, newStatus);
    }

    const updated: RegistryEntry = {
      ...entry,
      status: newStatus,
      updatedAt: new Date().toISOString(),
    };
    await this.store.saveEntry(updated);
  }

  /** Deprecate an entry (still discoverable but flagged). */
  async deprecate(entryId: string): Promise<void> {
    await this.setStatus(entryId, "deprecated");
  }

  /** Withdraw an entry from the registry (terminal). */
  async withdraw(entryId: string): Promise<void> {
    await this.setStatus(entryId, "withdrawn");
  }

  // -------------------------------------------------------------------------
  // Version management
  // -------------------------------------------------------------------------

  /** Get the full version history for an entry. */
  getVersionHistory(entryId: string): VersionHistory | null {
    const entry = this.store.getEntry(entryId);
    if (!entry) return null;
    return getVersionHistory(entry, this.store);
  }

  /** Get content at a specific version. */
  getVersionContent(entryId: string, version: string): string | null {
    return getVersionContent(entryId, version, this.store);
  }

  /** Rollback an entry to a previous version. */
  async rollback(entryId: string, targetVersion: string): Promise<RegistryEntry | null> {
    return rollbackToVersion(entryId, targetVersion, this.store);
  }

  /** Check if an update is available for a locally installed version. */
  checkForUpdate(entryId: string, localVersion: string): { available: boolean; latest?: string; versions?: VersionSummary[] } {
    const entry = this.store.getEntry(entryId);
    if (!entry) return { available: false };

    const available = isUpdateAvailable(localVersion, entry);
    if (!available) return { available: false };

    return {
      available: true,
      latest: entry.version,
      versions: getNewerVersions(entryId, localVersion, this.store),
    };
  }

  // -------------------------------------------------------------------------
  // Installation
  // -------------------------------------------------------------------------

  /**
   * Install a registry entry locally.
   *
   * For skills: writes the content to brain/registry/installed/{name}.md
   * so the SkillRegistry can discover it on next refresh.
   *
   * For templates: writes to brain/registry/installed/{name}.template.md
   * for use by the agent spawning system.
   */
  async install(req: InstallRequest): Promise<InstallResult> {
    const entry = this.store.getEntry(req.entryId);
    if (!entry) {
      return { ok: false, errors: ["Entry not found"] };
    }

    if (entry.status === "withdrawn") {
      return { ok: false, errors: ["Entry has been withdrawn"] };
    }

    // Resolve version
    let content = entry.content;
    if (req.version && req.version !== entry.version) {
      const versionContent = getVersionContent(entry.id, req.version, this.store);
      if (!versionContent) {
        return { ok: false, errors: [`Version ${req.version} not found`] };
      }
      content = versionContent;
    }

    // Determine install path
    const targetDir = req.targetDir ?? this.installedDir;
    await mkdir(targetDir, { recursive: true });

    const ext = entry.type === "skill" ? ".md" : ".template.md";
    const installPath = join(targetDir, `${entry.name}${ext}`);

    // Write the content
    await writeFile(installPath, content, "utf-8");

    // Increment download count
    const updated: RegistryEntry = {
      ...entry,
      downloads: entry.downloads + 1,
      updatedAt: new Date().toISOString(),
    };
    await this.store.saveEntry(updated);

    return {
      ok: true,
      entry: updated,
      installedPath: installPath,
      errors: [],
    };
  }

  /**
   * Uninstall a previously installed registry entry.
   * Removes the installed file but does not affect the registry entry.
   */
  async uninstall(name: string, type: RegistryItemType): Promise<boolean> {
    const { unlink } = await import("node:fs/promises");
    const ext = type === "skill" ? ".md" : ".template.md";
    const installPath = join(this.installedDir, `${name}${ext}`);
    try {
      await unlink(installPath);
      return true;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Metrics
  // -------------------------------------------------------------------------

  /** Get registry statistics. */
  stats(): {
    total: number;
    byType: Record<RegistryItemType, number>;
    byStatus: Record<RegistryItemStatus, number>;
  } {
    const entries = this.store.allEntries();
    const byType: Record<string, number> = { template: 0, skill: 0 };
    const byStatus: Record<string, number> = {
      draft: 0,
      published: 0,
      deprecated: 0,
      withdrawn: 0,
    };

    for (const entry of entries) {
      byType[entry.type] = (byType[entry.type] ?? 0) + 1;
      byStatus[entry.status] = (byStatus[entry.status] ?? 0) + 1;
    }

    return {
      total: entries.length,
      byType: byType as Record<RegistryItemType, number>,
      byStatus: byStatus as Record<RegistryItemStatus, number>,
    };
  }

  /** Total entry count. */
  get size(): number {
    return this.store.entryCount;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _registry: SharingRegistry | null = null;

/** Create and initialize the global sharing registry. */
export async function createSharingRegistry(opts: {
  registryDir: string;
  brainDir: string;
}): Promise<SharingRegistry> {
  if (_registry) return _registry;
  _registry = new SharingRegistry(opts);
  await _registry.init();
  return _registry;
}

/** Get the global sharing registry (null if not initialized). */
export function getSharingRegistry(): SharingRegistry | null {
  return _registry;
}
