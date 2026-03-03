/**
 * Registry — Package validation.
 *
 * Validates package manifests, skill content, and template content
 * before publishing to the registry. Checks required fields, format
 * constraints, and dependency availability.
 */

import type {
  PackageManifest,
  PackageValidation,
  PublishInput,
  PackageKind,
} from "./types.js";
import { validateSkill } from "../skills/validator.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Valid package name pattern: kebab-case, 2–64 chars. */
const NAME_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** Semver pattern (simplified). */
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

/** Max description length. */
const MAX_DESCRIPTION_LENGTH = 500;

/** Max tags per package. */
const MAX_TAGS = 20;

// ---------------------------------------------------------------------------
// Manifest validation
// ---------------------------------------------------------------------------

/** Validate a package manifest's structure and field values. */
export function validateManifest(manifest: PackageManifest): PackageValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Required fields
  if (!manifest.name) {
    errors.push("Missing required field: name");
  } else if (!NAME_RE.test(manifest.name)) {
    errors.push(
      `Invalid package name "${manifest.name}": must be kebab-case, start with a letter, 2+ chars`,
    );
  }

  if (!manifest.version) {
    errors.push("Missing required field: version");
  } else if (!SEMVER_RE.test(manifest.version)) {
    errors.push(
      `Invalid version "${manifest.version}": must be semver (e.g., 1.0.0)`,
    );
  }

  if (!manifest.kind) {
    errors.push("Missing required field: kind");
  } else if (manifest.kind !== "skill" && manifest.kind !== "template") {
    errors.push(`Invalid kind "${manifest.kind}": must be "skill" or "template"`);
  }

  if (!manifest.description) {
    errors.push("Missing required field: description");
  } else if (manifest.description.length > MAX_DESCRIPTION_LENGTH) {
    warnings.push(
      `Description is ${manifest.description.length} chars (max ${MAX_DESCRIPTION_LENGTH})`,
    );
  }

  if (!manifest.author) {
    errors.push("Missing required field: author");
  }

  // Files
  if (!manifest.files || manifest.files.length === 0) {
    errors.push("Package must contain at least one file");
  }

  // Tags
  if (manifest.tags && manifest.tags.length > MAX_TAGS) {
    warnings.push(`Too many tags (${manifest.tags.length}, max ${MAX_TAGS})`);
  }

  // Dependencies
  if (manifest.dependencies) {
    for (const dep of manifest.dependencies) {
      if (!dep.name) {
        errors.push("Dependency missing name");
      }
      if (!dep.version || !SEMVER_RE.test(dep.version)) {
        errors.push(
          `Dependency "${dep.name}" has invalid version: "${dep.version}"`,
        );
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ---------------------------------------------------------------------------
// Publish input validation
// ---------------------------------------------------------------------------

/** Validate a publish input before creating the package. */
export function validatePublishInput(input: PublishInput): PackageValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Validate manifest fields
  const manifestValidation = validateManifest({
    name: input.name,
    version: input.version,
    kind: input.kind,
    description: input.description,
    author: input.author,
    tags: input.tags ?? [],
    dependencies: input.dependencies ?? [],
    files: Object.keys(input.files),
    publishedAt: "",
    updatedAt: "",
  });
  errors.push(...manifestValidation.errors);
  warnings.push(...manifestValidation.warnings);

  // Validate file contents based on kind
  if (input.files && Object.keys(input.files).length > 0) {
    const contentValidation = validatePackageContent(
      input.kind,
      input.files,
    );
    errors.push(...contentValidation.errors);
    warnings.push(...contentValidation.warnings);
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ---------------------------------------------------------------------------
// Content validation
// ---------------------------------------------------------------------------

/**
 * Validate package content files based on the package kind.
 * Skills are validated with the existing skill validator.
 * Templates are validated for JSON structure.
 */
export function validatePackageContent(
  kind: PackageKind,
  files: Record<string, string>,
): PackageValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const [filename, content] of Object.entries(files)) {
    if (kind === "skill") {
      // Skills must be .md files with valid frontmatter
      if (!filename.endsWith(".md")) {
        warnings.push(`Skill file "${filename}" does not have .md extension`);
      }
      const skillValidation = validateSkill(filename, content);
      for (const err of skillValidation.errors) {
        errors.push(`${filename}: ${err}`);
      }
      for (const warn of skillValidation.warnings) {
        warnings.push(`${filename}: ${warn}`);
      }
    } else if (kind === "template") {
      // Templates must be valid JSON
      if (!filename.endsWith(".json") && !filename.endsWith(".md")) {
        warnings.push(
          `Template file "${filename}" should have .json or .md extension`,
        );
      }
      if (filename.endsWith(".json")) {
        try {
          const parsed = JSON.parse(content);
          const templateValidation = validateTemplateJson(parsed);
          for (const err of templateValidation.errors) {
            errors.push(`${filename}: ${err}`);
          }
          for (const warn of templateValidation.warnings) {
            warnings.push(`${filename}: ${warn}`);
          }
        } catch {
          errors.push(`${filename}: Invalid JSON`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ---------------------------------------------------------------------------
// Template JSON validation
// ---------------------------------------------------------------------------

/** Expected fields in a template JSON file. */
interface TemplateJson {
  name?: string;
  description?: string;
  category?: string;
  promptPattern?: string;
  inputs?: Array<{ field: string; required: boolean }>;
  outputs?: string[];
  constraints?: string[];
}

/** Validate a parsed template JSON structure. */
function validateTemplateJson(
  template: TemplateJson,
): PackageValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!template.name) {
    errors.push("Template missing required field: name");
  }
  if (!template.description) {
    errors.push("Template missing required field: description");
  }
  if (!template.promptPattern) {
    warnings.push("Template has no promptPattern — consider adding one");
  }
  if (template.category) {
    const validCategories = [
      "code-review",
      "bug-investigation",
      "feature-implementation",
      "testing",
      "deployment-ops",
      "integration",
    ];
    if (!validCategories.includes(template.category)) {
      warnings.push(
        `Unknown template category "${template.category}". Known: ${validCategories.join(", ")}`,
      );
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ---------------------------------------------------------------------------
// Dependency checking
// ---------------------------------------------------------------------------

/**
 * Check if all dependencies of a package are available in the registry.
 * Returns the names of missing dependencies.
 */
export function checkDependencies(
  manifest: PackageManifest,
  availablePackages: Map<string, PackageManifest>,
): string[] {
  const missing: string[] = [];
  for (const dep of manifest.dependencies) {
    const available = availablePackages.get(dep.name);
    if (!available) {
      missing.push(dep.name);
    } else if (available.version !== dep.version) {
      missing.push(`${dep.name}@${dep.version} (found ${available.version})`);
    }
  }
  return missing;
}
