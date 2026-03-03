/**
 * Registry — Public API.
 *
 * Provides a file-based registry for sharing agent templates and skills
 * across Core instances. Supports publishing, discovery, validation,
 * and installation of packages.
 */

// Types
export type {
  PackageKind,
  PackageManifest,
  PackageDependency,
  PackageStatus,
  RegistryEntry,
  SearchResult,
  SearchOptions,
  PackageValidation,
  InstallResult,
  PublishInput,
} from "./types.js";

// Store
export { RegistryStore } from "./store.js";

// Validator
export {
  validateManifest,
  validatePublishInput,
  validatePackageContent,
  checkDependencies,
} from "./validator.js";

// Discovery
export { search, listTags, listAuthors } from "./discovery.js";

// Installer
export { PackageInstaller } from "./installer.js";

// Registry (main orchestrator)
export {
  PackageRegistry,
  createPackageRegistry,
  getPackageRegistry,
} from "./registry.js";
