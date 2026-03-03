/**
 * Skills Library — Validation logic.
 *
 * Validates skill files against the schema: required fields, valid values,
 * body content, referenced paths, and duplicate name detection.
 * Separated from the loader for single-responsibility and reuse.
 */

import type { SkillValidation } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const BRAIN_PATH_RE = /brain\/[\w\-\/]+\.\w+/g;

// ---------------------------------------------------------------------------
// Frontmatter parsing (shared with loader)
// ---------------------------------------------------------------------------

/**
 * Parse simple YAML frontmatter into a key-value record.
 * Handles: strings (optionally quoted), booleans, unquoted values.
 */
export function parseFrontmatter(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx < 0) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    let value = trimmed.slice(colonIdx + 1).trim();
    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

/** Convert a string value to boolean with a fallback. */
export function toBool(val: string | undefined, fallback: boolean): boolean {
  if (val === undefined) return fallback;
  return val === "true" || val === "yes";
}

/** Regex for splitting frontmatter from body. */
export { FRONTMATTER_RE };

// ---------------------------------------------------------------------------
// Reference extraction
// ---------------------------------------------------------------------------

/**
 * Extract referenced file paths from skill body content.
 * Scans for patterns like `brain/identity/tone-of-voice.md`.
 */
export function extractReferences(body: string): string[] {
  const matches = body.match(BRAIN_PATH_RE);
  if (!matches) return [];
  return [...new Set(matches)];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a skill file against the schema.
 *
 * Checks:
 * - Required fields (name, description)
 * - Body not empty
 * - user-invocable + disable-model-invocation consistency
 * - Referenced files use brain/ paths
 *
 * Optionally checks for duplicate names against a set of known names.
 */
export function validateSkill(
  filePath: string,
  content: string,
  knownNames?: Set<string>,
): SkillValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  const match = content.match(FRONTMATTER_RE);
  if (!match) {
    errors.push("Missing YAML frontmatter (expected --- delimiters)");
    return { valid: false, errors, warnings };
  }

  const fm = parseFrontmatter(match[1]);
  const body = match[2].trim();

  // Required fields
  if (!fm.name) errors.push("Missing required field: name");
  if (!fm.description) errors.push("Missing required field: description");

  // Body check
  if (!body) errors.push("Skill body is empty — a skill with no instructions is useless");

  // Duplicate name check
  if (fm.name && knownNames?.has(fm.name)) {
    errors.push(`Duplicate skill name "${fm.name}" — names must be unique within a source`);
  }

  // Warnings
  const userInvocable = toBool(fm["user-invocable"], false);
  const disableModel = toBool(fm["disable-model-invocation"], false);
  if (userInvocable && !disableModel) {
    warnings.push(
      "user-invocable: true but disable-model-invocation: false — task skills should typically disable model invocation",
    );
  }

  // Check referenced files
  if (body) {
    const refs = extractReferences(body);
    for (const ref of refs) {
      if (!ref.startsWith("brain/")) {
        warnings.push(`Referenced file outside brain/: ${ref}`);
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}
