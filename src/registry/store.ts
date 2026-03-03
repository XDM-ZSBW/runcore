/**
 * Registry — File-based store.
 *
 * Manages the on-disk registry structure:
 *   brain/registry/
 *     packages/{name}/         — Published packages (manifest.json + content files)
 *     installed/{name}/        — Installed packages (copied from packages/)
 *     index.jsonl              — Append-only index of all published packages
 *
 * Follows Core patterns: atomic writes, parallel I/O, append-only JSONL.
 */

import { mkdir, readFile, writeFile, readdir, rename, cp } from "node:fs/promises";
import { join } from "node:path";
import type {
  PackageManifest,
  RegistryEntry,
  PackageStatus,
  PublishInput,
} from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MANIFEST_FILE = "manifest.json";
const INDEX_FILE = "index.jsonl";

// ---------------------------------------------------------------------------
// RegistryStore
// ---------------------------------------------------------------------------

export class RegistryStore {
  /** Root directory for the registry (brain/registry/). */
  private readonly registryDir: string;

  /** Where published packages live. */
  private readonly packagesDir: string;

  /** Where installed packages live. */
  private readonly installedDir: string;

  /** Path to the JSONL index file. */
  private readonly indexPath: string;

  /** In-memory cache of all entries, keyed by package name. */
  private readonly entries = new Map<string, RegistryEntry>();

  private initialized = false;

  constructor(brainDir: string) {
    this.registryDir = join(brainDir, "registry");
    this.packagesDir = join(this.registryDir, "packages");
    this.installedDir = join(this.registryDir, "installed");
    this.indexPath = join(this.registryDir, INDEX_FILE);
  }

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------

  /** Ensure directories exist and load all entries from disk. */
  async init(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.packagesDir, { recursive: true });
    await mkdir(this.installedDir, { recursive: true });
    await this.loadIndex();
    this.initialized = true;
  }

  // -------------------------------------------------------------------------
  // Read operations
  // -------------------------------------------------------------------------

  /** Get an entry by package name. */
  get(name: string): RegistryEntry | undefined {
    return this.entries.get(name);
  }

  /** Check if a package exists. */
  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** List all entries, optionally filtered by status. */
  list(filter?: { status?: PackageStatus }): RegistryEntry[] {
    const all = Array.from(this.entries.values());
    if (!filter?.status) return all;
    return all.filter((e) => e.status === filter.status);
  }

  /** Total number of packages. */
  get size(): number {
    return this.entries.size;
  }

  // -------------------------------------------------------------------------
  // Write operations
  // -------------------------------------------------------------------------

  /**
   * Publish a package to the registry.
   * Creates the package directory, writes manifest and files, appends to index.
   */
  async publish(input: PublishInput): Promise<RegistryEntry> {
    const now = new Date().toISOString();
    const manifest: PackageManifest = {
      name: input.name,
      version: input.version,
      kind: input.kind,
      description: input.description,
      author: input.author,
      tags: input.tags ?? [],
      dependencies: input.dependencies ?? [],
      files: Object.keys(input.files),
      publishedAt: now,
      updatedAt: now,
    };

    const packageDir = join(this.packagesDir, input.name);
    await mkdir(packageDir, { recursive: true });

    // Write manifest atomically
    const manifestPath = join(packageDir, MANIFEST_FILE);
    const tmpManifest = manifestPath + ".tmp";
    await writeFile(tmpManifest, JSON.stringify(manifest, null, 2), "utf-8");
    await rename(tmpManifest, manifestPath);

    // Write content files in parallel
    await Promise.all(
      Object.entries(input.files).map(async ([filename, content]) => {
        const filePath = join(packageDir, filename);
        const tmpFile = filePath + ".tmp";
        await writeFile(tmpFile, content, "utf-8");
        await rename(tmpFile, filePath);
      }),
    );

    // Build entry
    const entry: RegistryEntry = {
      manifest,
      status: "published",
      registryPath: packageDir,
      installedPath: null,
    };

    // Update in-memory cache
    this.entries.set(input.name, entry);

    // Append to index
    await this.appendIndex(manifest);

    return entry;
  }

  /**
   * Install a package from the registry to the installed directory.
   * Copies package files from packages/ to installed/.
   * Returns the installed path.
   */
  async install(name: string): Promise<string | null> {
    const entry = this.entries.get(name);
    if (!entry) return null;

    const sourceDir = entry.registryPath;
    const targetDir = join(this.installedDir, name);

    await mkdir(targetDir, { recursive: true });
    await cp(sourceDir, targetDir, { recursive: true });

    entry.status = "installed";
    entry.installedPath = targetDir;

    return targetDir;
  }

  /**
   * Mark a package as deprecated.
   */
  deprecate(name: string): boolean {
    const entry = this.entries.get(name);
    if (!entry) return false;
    entry.status = "deprecated";
    return true;
  }

  /**
   * Read a package manifest from its directory.
   */
  async readManifest(packageDir: string): Promise<PackageManifest | null> {
    try {
      const content = await readFile(join(packageDir, MANIFEST_FILE), "utf-8");
      return JSON.parse(content) as PackageManifest;
    } catch {
      return null;
    }
  }

  /**
   * Read all content files for a package.
   * Returns a map of relative filename to content.
   */
  async readPackageFiles(
    packageDir: string,
    manifest: PackageManifest,
  ): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    const results = await Promise.allSettled(
      manifest.files.map((f) => readFile(join(packageDir, f), "utf-8")),
    );
    for (let i = 0; i < manifest.files.length; i++) {
      const result = results[i];
      if (result.status === "fulfilled") {
        files[manifest.files[i]] = result.value;
      }
    }
    return files;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  /** Load the index from disk by scanning package directories. */
  private async loadIndex(): Promise<void> {
    // Scan packages/ directory for published packages
    await this.scanDir(this.packagesDir, "published");

    // Scan installed/ directory to mark installed packages
    await this.scanDir(this.installedDir, "installed");
  }

  /** Scan a directory for package subdirectories and load their manifests. */
  private async scanDir(
    dir: string,
    status: PackageStatus,
  ): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }

    const results = await Promise.allSettled(
      entries.map(async (name) => {
        const packageDir = join(dir, name);
        const manifest = await this.readManifest(packageDir);
        if (!manifest) return null;
        return { name, packageDir, manifest };
      }),
    );

    for (const result of results) {
      if (result.status !== "fulfilled" || !result.value) continue;
      const { name, packageDir, manifest } = result.value;

      if (status === "installed") {
        // Mark existing entry as installed
        const existing = this.entries.get(name);
        if (existing) {
          existing.status = "installed";
          existing.installedPath = packageDir;
        } else {
          // Installed but not in packages/ — registry-only install
          this.entries.set(name, {
            manifest,
            status: "installed",
            registryPath: packageDir,
            installedPath: packageDir,
          });
        }
      } else {
        // Only set if not already loaded (avoid overwriting installed status)
        if (!this.entries.has(name)) {
          this.entries.set(name, {
            manifest,
            status,
            registryPath: packageDir,
            installedPath: null,
          });
        }
      }
    }
  }

  /** Append a manifest entry to the JSONL index file. */
  private async appendIndex(manifest: PackageManifest): Promise<void> {
    const line = JSON.stringify(manifest) + "\n";
    await writeFile(this.indexPath, line, { flag: "a" });
  }
}
