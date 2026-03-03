/**
 * Template & Skill Sharing Registry — Publishing and validation.
 *
 * Validates publish requests, generates IDs and checksums, and creates
 * registry entries. Handles both initial publishes and version bumps.
 */

import { createHash } from "node:crypto";
import type {
  RegistryEntry,
  RegistryVersion,
  PublishRequest,
  PublishResult,
  ValidationResult,
  RegistryItemType,
  TemplateCategory,
} from "./types.js";
import type { RegistryStore } from "./store.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const NAME_RE = /^[a-z][a-z0-9\-]{1,63}$/;
const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---/;

const VALID_CATEGORIES: Set<string> = new Set<TemplateCategory>([
  "code-review",
  "bug-investigation",
  "feature-implementation",
  "testing",
  "deployment-ops",
  "integration",
  "custom",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a unique entry ID. */
export function generateEntryId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `reg_${ts}_${rand}`;
}

/** Compute SHA-256 hex digest of content. */
export function computeChecksum(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

/**
 * Compare two semver strings.
 * Returns positive if a > b, negative if a < b, 0 if equal.
 */
export function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Validate a publish request without side effects. */
export function validatePublishRequest(
  req: PublishRequest,
  store: RegistryStore,
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Required fields
  if (!req.name) errors.push("Missing required field: name");
  if (!req.version) errors.push("Missing required field: version");
  if (!req.description) errors.push("Missing required field: description");
  if (!req.author) errors.push("Missing required field: author");
  if (!req.content) errors.push("Missing required field: content");
  if (!req.type) errors.push("Missing required field: type");

  // Name format
  if (req.name && !NAME_RE.test(req.name)) {
    errors.push(
      `Invalid name "${req.name}" — must be lowercase alphanumeric with hyphens, 2-64 chars`,
    );
  }

  // Version format
  if (req.version && !SEMVER_RE.test(req.version)) {
    errors.push(`Invalid version "${req.version}" — must be semver (e.g., 1.0.0)`);
  }

  // Type validation
  if (req.type && req.type !== "template" && req.type !== "skill") {
    errors.push(`Invalid type "${req.type}" — must be "template" or "skill"`);
  }

  // Category validation (templates only)
  if (req.category) {
    if (req.type !== "template") {
      warnings.push("Category is only meaningful for templates");
    } else if (!VALID_CATEGORIES.has(req.category)) {
      errors.push(`Invalid category "${req.category}"`);
    }
  }

  // Content validation based on type
  if (req.content && req.type === "skill") {
    if (!FRONTMATTER_RE.test(req.content)) {
      warnings.push("Skill content should have YAML frontmatter (--- delimiters)");
    }
  }

  if (req.content && req.type === "template") {
    // Templates should contain structural markers
    const hasContext = /\[CONTEXT\]/i.test(req.content);
    const hasTask = /\[TASK\]/i.test(req.content);
    if (!hasContext && !hasTask) {
      warnings.push(
        "Template content should include [CONTEXT] and [TASK] sections per prompt anatomy",
      );
    }
  }

  // Description length
  if (req.description && req.description.length > 500) {
    warnings.push("Description exceeds 500 chars — consider shortening for search results");
  }

  // Version bump check for existing entries
  if (req.name && req.type && req.version) {
    const existing = store.findEntry(req.name, req.type);
    if (existing) {
      if (compareSemver(req.version, existing.version) <= 0) {
        errors.push(
          `Version ${req.version} must be greater than current version ${existing.version}`,
        );
      }
    }
  }

  // Tags sanity
  if (req.tags) {
    for (const tag of req.tags) {
      if (tag.length > 30) {
        warnings.push(`Tag "${tag}" is very long — keep tags short for search`);
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

/** Publish a new entry or new version of an existing entry. */
export async function publishEntry(
  req: PublishRequest,
  store: RegistryStore,
): Promise<PublishResult> {
  // Validate first
  const validation = validatePublishRequest(req, store);
  if (!validation.valid) {
    return { ok: false, errors: validation.errors, warnings: validation.warnings };
  }

  const now = new Date().toISOString();
  const checksum = computeChecksum(req.content);
  const existing = store.findEntry(req.name, req.type);

  let entry: RegistryEntry;

  if (existing) {
    // Version bump — update existing entry
    entry = {
      ...existing,
      version: req.version,
      description: req.description,
      content: req.content,
      tags: req.tags ?? existing.tags,
      category: req.category ?? existing.category,
      dependencies: req.dependencies ?? existing.dependencies,
      checksum,
      status: "published",
      updatedAt: now,
    };
  } else {
    // New entry
    entry = {
      id: generateEntryId(),
      type: req.type,
      name: req.name,
      version: req.version,
      description: req.description,
      author: req.author,
      content: req.content,
      tags: req.tags ?? [],
      category: req.type === "template" ? (req.category ?? "custom") : undefined,
      dependencies: req.dependencies ?? [],
      status: "published",
      checksum,
      downloads: 0,
      publishedAt: now,
      updatedAt: now,
    };
  }

  // Persist entry
  await store.saveEntry(entry);

  // Record version snapshot
  const version: RegistryVersion = {
    entryId: entry.id,
    version: req.version,
    content: req.content,
    checksum,
    changelog: req.changelog ?? "",
    publishedAt: now,
  };
  await store.addVersion(version);

  return {
    ok: true,
    entry,
    errors: [],
    warnings: validation.warnings,
  };
}
