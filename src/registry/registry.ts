/**
 * Registry — Main orchestrator.
 *
 * The PackageRegistry class ties together the store, validator, discovery,
 * and installer into a single API for managing shared templates and skills.
 * Follows the SkillRegistry pattern: singleton factory, init on first use.
 */

import type {
  RegistryEntry,
  SearchResult,
  SearchOptions,
  PackageValidation,
  InstallResult,
  PublishInput,
  PackageKind,
  PackageStatus,
} from "./types.js";
import { RegistryStore } from "./store.js";
import { PackageInstaller } from "./installer.js";
import { validatePublishInput } from "./validator.js";
import { search, listTags, listAuthors } from "./discovery.js";

// ---------------------------------------------------------------------------
// PackageRegistry
// ---------------------------------------------------------------------------

export class PackageRegistry {
  private readonly store: RegistryStore;
  private readonly installer: PackageInstaller;
  private initialized = false;

  constructor(opts: { brainDir: string; skillsDir: string }) {
    this.store = new RegistryStore(opts.brainDir);
    this.installer = new PackageInstaller(this.store, opts.skillsDir);
  }

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------

  /** Initialize the registry: ensure directories exist, load index. */
  async init(): Promise<void> {
    if (this.initialized) return;
    await this.store.init();
    this.initialized = true;
  }

  // -------------------------------------------------------------------------
  // Publish
  // -------------------------------------------------------------------------

  /**
   * Publish a package to the registry.
   * Validates the input, then writes to the store.
   * Returns the validation result if invalid, or the created entry.
   */
  async publish(
    input: PublishInput,
  ): Promise<{ entry: RegistryEntry | null; validation: PackageValidation }> {
    const validation = validatePublishInput(input);
    if (!validation.valid) {
      return { entry: null, validation };
    }

    const entry = await this.store.publish(input);
    return { entry, validation };
  }

  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------

  /** Search for packages. */
  search(options: SearchOptions): SearchResult[] {
    return search(this.store.list(), options);
  }

  /** Get a package by exact name. */
  get(name: string): RegistryEntry | undefined {
    return this.store.get(name);
  }

  /** Check if a package exists. */
  has(name: string): boolean {
    return this.store.has(name);
  }

  /** List all packages, optionally filtered. */
  list(filter?: {
    kind?: PackageKind;
    status?: PackageStatus;
  }): RegistryEntry[] {
    let entries = this.store.list(
      filter?.status ? { status: filter.status } : undefined,
    );
    if (filter?.kind) {
      entries = entries.filter((e) => e.manifest.kind === filter.kind);
    }
    return entries;
  }

  /** List all unique tags. */
  listTags(): string[] {
    return listTags(this.store.list());
  }

  /** List all unique authors. */
  listAuthors(): string[] {
    return listAuthors(this.store.list());
  }

  // -------------------------------------------------------------------------
  // Install
  // -------------------------------------------------------------------------

  /** Install a package (and its dependencies) locally. */
  async install(name: string): Promise<InstallResult> {
    return this.installer.install(name);
  }

  /** Install multiple packages. */
  async installMany(names: string[]): Promise<InstallResult[]> {
    return this.installer.installMany(names);
  }

  /** Check if a package can be installed (dry run). */
  canInstall(name: string): { installable: boolean; reasons: string[] } {
    return this.installer.canInstall(name);
  }

  // -------------------------------------------------------------------------
  // Management
  // -------------------------------------------------------------------------

  /** Deprecate a package. */
  deprecate(name: string): boolean {
    return this.store.deprecate(name);
  }

  /** Validate a publish input without actually publishing. */
  validate(input: PublishInput): PackageValidation {
    return validatePublishInput(input);
  }

  // -------------------------------------------------------------------------
  // Metrics
  // -------------------------------------------------------------------------

  /** Total number of packages in the registry. */
  get size(): number {
    return this.store.size;
  }

  /** Count packages by status. */
  countByStatus(): Record<PackageStatus, number> {
    const counts: Record<string, number> = {
      published: 0,
      installed: 0,
      deprecated: 0,
    };
    for (const entry of this.store.list()) {
      counts[entry.status] = (counts[entry.status] || 0) + 1;
    }
    return counts as Record<PackageStatus, number>;
  }

  /** Count packages by kind. */
  countByKind(): Record<PackageKind, number> {
    const counts: Record<string, number> = {
      skill: 0,
      template: 0,
    };
    for (const entry of this.store.list()) {
      counts[entry.manifest.kind] = (counts[entry.manifest.kind] || 0) + 1;
    }
    return counts as Record<PackageKind, number>;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _registry: PackageRegistry | null = null;

/** Create and initialize the global package registry. */
export async function createPackageRegistry(opts: {
  brainDir: string;
  skillsDir: string;
}): Promise<PackageRegistry> {
  if (_registry) return _registry;
  _registry = new PackageRegistry(opts);
  await _registry.init();
  return _registry;
}

/** Get the global package registry (null if not initialized). */
export function getPackageRegistry(): PackageRegistry | null {
  return _registry;
}
