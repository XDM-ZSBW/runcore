/**
 * Template & Skill Sharing Registry — Type definitions.
 *
 * Defines the data model for publishable, discoverable, and versionable
 * resources (agent templates and skills) in the sharing registry.
 */

// ---------------------------------------------------------------------------
// Enums / union types
// ---------------------------------------------------------------------------

/** What kind of resource is being shared. */
export type RegistryItemType = "template" | "skill";

/** Lifecycle status of a registry entry. */
export type RegistryItemStatus =
  | "draft"       // Not yet published (local only)
  | "published"   // Available for discovery and installation
  | "deprecated"  // Still installable but superseded
  | "withdrawn";  // Removed from discovery (existing installs unaffected)

/** Valid status transitions. */
export const STATUS_TRANSITIONS: Record<RegistryItemStatus, RegistryItemStatus[]> = {
  draft: ["published", "withdrawn"],
  published: ["deprecated", "withdrawn"],
  deprecated: ["published", "withdrawn"], // can un-deprecate
  withdrawn: [],                          // terminal
};

/** Template categories (aligned with agent-templates-spec.md). */
export type TemplateCategory =
  | "code-review"
  | "bug-investigation"
  | "feature-implementation"
  | "testing"
  | "deployment-ops"
  | "integration"
  | "custom";

// ---------------------------------------------------------------------------
// Core data model
// ---------------------------------------------------------------------------

/** A published entry in the sharing registry. */
export interface RegistryEntry {
  /** Unique identifier (generated on publish). */
  id: string;

  /** Type of shared resource. */
  type: RegistryItemType;

  /** Human-readable name (unique per type). */
  name: string;

  /** Current semver version string. */
  version: string;

  /** Short description for search results. */
  description: string;

  /** Author identifier. */
  author: string;

  /** Searchable tags. */
  tags: string[];

  /** Template category (only for type "template"). */
  category?: TemplateCategory;

  /** The resource content (YAML frontmatter + markdown for skills, prompt pattern for templates). */
  content: string;

  /** IDs of other registry entries this depends on. */
  dependencies: string[];

  /** Lifecycle status. */
  status: RegistryItemStatus;

  /** SHA-256 hex digest of content for integrity verification. */
  checksum: string;

  /** Download/install count. */
  downloads: number;

  /** ISO timestamp of first publish. */
  publishedAt: string;

  /** ISO timestamp of last update. */
  updatedAt: string;
}

/** A version snapshot stored alongside the entry. */
export interface RegistryVersion {
  /** ID of the parent registry entry. */
  entryId: string;

  /** Semver version string. */
  version: string;

  /** Content at this version. */
  content: string;

  /** SHA-256 hex digest of content. */
  checksum: string;

  /** What changed in this version. */
  changelog: string;

  /** ISO timestamp. */
  publishedAt: string;
}

// ---------------------------------------------------------------------------
// API request/response types
// ---------------------------------------------------------------------------

/** Input for publishing a new entry or new version. */
export interface PublishRequest {
  type: RegistryItemType;
  name: string;
  version: string;
  description: string;
  author: string;
  content: string;
  tags?: string[];
  category?: TemplateCategory;
  dependencies?: string[];
  changelog?: string;
}

/** Result of a publish operation. */
export interface PublishResult {
  ok: boolean;
  entry?: RegistryEntry;
  errors: string[];
  warnings: string[];
}

/** Validation result for pre-publish checks. */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/** Search/filter query for the registry. */
export interface RegistrySearchQuery {
  /** Free-text search (matched against name, description, tags). */
  query?: string;

  /** Filter by resource type. */
  type?: RegistryItemType;

  /** Filter by template category. */
  category?: TemplateCategory;

  /** Filter by tags (all must match). */
  tags?: string[];

  /** Filter by author. */
  author?: string;

  /** Filter by status (default: published). */
  status?: RegistryItemStatus;

  /** Sort field. */
  sortBy?: "name" | "publishedAt" | "downloads" | "relevance";

  /** Sort direction. */
  sortOrder?: "asc" | "desc";

  /** Max results (default: 20). */
  limit?: number;

  /** Offset for pagination. */
  offset?: number;
}

/** Paginated search results. */
export interface RegistrySearchResult {
  entries: RegistryEntry[];
  total: number;
  query: RegistrySearchQuery;
}

/** Input for installing a registry entry locally. */
export interface InstallRequest {
  /** Registry entry ID. */
  entryId: string;

  /** Specific version (latest if omitted). */
  version?: string;

  /** Override install directory. */
  targetDir?: string;
}

/** Result of an install operation. */
export interface InstallResult {
  ok: boolean;
  entry?: RegistryEntry;
  installedPath?: string;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

/** Thrown on invalid status transitions. */
export class RegistryStatusError extends Error {
  constructor(
    public readonly entryId: string,
    public readonly currentStatus: RegistryItemStatus,
    public readonly attemptedStatus: RegistryItemStatus,
  ) {
    super(
      `Invalid registry status transition for "${entryId}": ${currentStatus} → ${attemptedStatus}`,
    );
    this.name = "RegistryStatusError";
  }
}
