/**
 * Registry — Type definitions.
 *
 * Defines package manifests, registry entries, search results,
 * and validation types for sharing agent templates and skills
 * across Core instances.
 */

// ---------------------------------------------------------------------------
// Package kind — what the registry item contains
// ---------------------------------------------------------------------------

/** The kind of content a registry package provides. */
export type PackageKind = "skill" | "template";

// ---------------------------------------------------------------------------
// Package manifest — metadata for a published package
// ---------------------------------------------------------------------------

/** Dependency on another registry package. */
export interface PackageDependency {
  /** Package name. */
  name: string;
  /** Required semver (exact match for now). */
  version: string;
}

/** A published package manifest. */
export interface PackageManifest {
  /** Unique package name (kebab-case). */
  name: string;

  /** Semver version string. */
  version: string;

  /** What kind of content this package provides. */
  kind: PackageKind;

  /** Human-readable description. */
  description: string;

  /** Author name or identifier. */
  author: string;

  /** Tags for discovery / search. */
  tags: string[];

  /** Other registry packages this depends on. */
  dependencies: PackageDependency[];

  /** Relative paths to the content files within the package. */
  files: string[];

  /** ISO timestamp of when the package was published. */
  publishedAt: string;

  /** ISO timestamp of the last update. */
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Registry entry — manifest + storage location
// ---------------------------------------------------------------------------

/** A package's status in the registry. */
export type PackageStatus = "published" | "installed" | "deprecated";

/** A registry entry: manifest + local metadata. */
export interface RegistryEntry {
  /** The package manifest. */
  manifest: PackageManifest;

  /** Current status. */
  status: PackageStatus;

  /** Absolute path to the package directory in the registry. */
  registryPath: string;

  /** Absolute path to the installed location (null if not installed). */
  installedPath: string | null;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** A search result with relevance scoring. */
export interface SearchResult {
  /** The matching registry entry. */
  entry: RegistryEntry;

  /** Relevance score (0–1). */
  score: number;

  /** Why this result matched. */
  matchReason: "exact-name" | "tag-match" | "description-match" | "kind-match";
}

/** Options for searching the registry. */
export interface SearchOptions {
  /** Free-text query. */
  query?: string;

  /** Filter by package kind. */
  kind?: PackageKind;

  /** Filter by tag (any match). */
  tags?: string[];

  /** Filter by status. */
  status?: PackageStatus;

  /** Maximum results to return. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Result of validating a package. */
export interface PackageValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

/** Result of an install operation. */
export interface InstallResult {
  success: boolean;
  /** Package name. */
  name: string;
  /** Where the package was installed. */
  installedPath: string | null;
  /** Errors encountered during installation. */
  errors: string[];
  /** Dependencies that were also installed. */
  installedDependencies: string[];
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

/** Input for publishing a package. */
export interface PublishInput {
  /** Package name (kebab-case). */
  name: string;

  /** Semver version. */
  version: string;

  /** Package kind. */
  kind: PackageKind;

  /** Description. */
  description: string;

  /** Author. */
  author: string;

  /** Tags for discovery. */
  tags?: string[];

  /** Dependencies on other packages. */
  dependencies?: PackageDependency[];

  /**
   * Map of relative filename to content.
   * For skills: { "my-skill.md": "---\nname: ...\n---\n..." }
   * For templates: { "my-template.json": "{...}" }
   */
  files: Record<string, string>;
}
