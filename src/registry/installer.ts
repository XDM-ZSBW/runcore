/**
 * Registry — Package installer.
 *
 * Handles downloading and installing packages from the registry store
 * to the local skills/ or templates directory. Resolves dependencies
 * and validates before installation.
 */

import { mkdir, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type {
  InstallResult,
  PackageManifest,
  RegistryEntry,
} from "./types.js";
import { RegistryStore } from "./store.js";
import { checkDependencies } from "./validator.js";

// ---------------------------------------------------------------------------
// Installer
// ---------------------------------------------------------------------------

export class PackageInstaller {
  private readonly store: RegistryStore;
  private readonly skillsDir: string;

  constructor(store: RegistryStore, skillsDir: string) {
    this.store = store;
    this.skillsDir = skillsDir;
  }

  /**
   * Install a package and its dependencies.
   *
   * Steps:
   * 1. Validate the package exists in the registry
   * 2. Check and resolve dependencies (install missing ones)
   * 3. Copy package files to the installed directory via the store
   * 4. For skills: also copy .md files to the skills install location
   *
   * Returns an InstallResult with success status and details.
   */
  async install(name: string): Promise<InstallResult> {
    const errors: string[] = [];
    const installedDeps: string[] = [];

    // 1. Check package exists
    const entry = this.store.get(name);
    if (!entry) {
      return {
        success: false,
        name,
        installedPath: null,
        errors: [`Package "${name}" not found in registry`],
        installedDependencies: [],
      };
    }

    // 2. Check dependencies
    const availablePackages = new Map<string, PackageManifest>();
    for (const e of this.store.list()) {
      availablePackages.set(e.manifest.name, e.manifest);
    }

    const missingDeps = checkDependencies(
      entry.manifest,
      availablePackages,
    );

    if (missingDeps.length > 0) {
      // Try to install missing dependencies that exist in registry
      for (const depName of missingDeps) {
        // Extract just the name (without version info)
        const cleanName = depName.split("@")[0];
        const depEntry = this.store.get(cleanName);
        if (!depEntry) {
          errors.push(`Missing dependency: ${depName}`);
          continue;
        }

        // Recursively install the dependency
        const depResult = await this.install(cleanName);
        if (depResult.success) {
          installedDeps.push(cleanName);
        } else {
          errors.push(
            `Failed to install dependency "${cleanName}": ${depResult.errors.join(", ")}`,
          );
        }
      }

      if (errors.length > 0) {
        return {
          success: false,
          name,
          installedPath: null,
          errors,
          installedDependencies: installedDeps,
        };
      }
    }

    // 3. Install via store (copies to brain/registry/installed/)
    const installedPath = await this.store.install(name);
    if (!installedPath) {
      return {
        success: false,
        name,
        installedPath: null,
        errors: ["Failed to copy package to installed directory"],
        installedDependencies: installedDeps,
      };
    }

    // 4. For skills, also copy .md files to the skills install location
    if (entry.manifest.kind === "skill") {
      await this.installSkillFiles(entry, installedPath);
    }

    return {
      success: true,
      name,
      installedPath,
      errors: [],
      installedDependencies: installedDeps,
    };
  }

  /**
   * Install multiple packages at once.
   * Installs them sequentially to handle dependency ordering.
   */
  async installMany(names: string[]): Promise<InstallResult[]> {
    const results: InstallResult[] = [];
    for (const name of names) {
      results.push(await this.install(name));
    }
    return results;
  }

  /**
   * Check if a package can be installed (dry run).
   * Validates existence and dependencies without actually installing.
   */
  canInstall(name: string): { installable: boolean; reasons: string[] } {
    const reasons: string[] = [];

    const entry = this.store.get(name);
    if (!entry) {
      return { installable: false, reasons: [`Package "${name}" not found`] };
    }

    if (entry.status === "deprecated") {
      reasons.push(`Package "${name}" is deprecated`);
    }

    // Check dependencies
    const availablePackages = new Map<string, PackageManifest>();
    for (const e of this.store.list()) {
      availablePackages.set(e.manifest.name, e.manifest);
    }

    const missingDeps = checkDependencies(
      entry.manifest,
      availablePackages,
    );

    for (const dep of missingDeps) {
      reasons.push(`Missing dependency: ${dep}`);
    }

    return {
      installable: reasons.length === 0,
      reasons,
    };
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  /**
   * Copy skill .md files to the skills install directory
   * so the SkillRegistry can discover them.
   */
  private async installSkillFiles(
    entry: RegistryEntry,
    installedPath: string,
  ): Promise<void> {
    const mdFiles = entry.manifest.files.filter((f) => f.endsWith(".md"));
    if (mdFiles.length === 0) return;

    // Read and copy each skill file to the installed skills location
    const manifest = await this.store.readManifest(installedPath);
    if (!manifest) return;

    const files = await this.store.readPackageFiles(installedPath, manifest);

    // Write skill files to brain/registry/installed/{name}/ (already done by store.install)
    // The SkillRegistry scans brain/registry/installed/ on init,
    // so the skill will be discovered automatically.
    // But we also write to a predictable subdirectory for direct access.
    const skillInstallDir = join(this.skillsDir, ".registry", entry.manifest.name);
    await mkdir(skillInstallDir, { recursive: true });

    await Promise.all(
      mdFiles.map(async (filename) => {
        const content = files[filename];
        if (!content) return;
        const targetPath = join(skillInstallDir, filename);
        const tmpPath = targetPath + ".tmp";
        await writeFile(tmpPath, content, "utf-8");
        await rename(tmpPath, targetPath);
      }),
    );
  }
}
