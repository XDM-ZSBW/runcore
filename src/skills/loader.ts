/**
 * Skills Library — Skill loader.
 *
 * Parses skill files (YAML frontmatter + Markdown body) into Skill objects.
 * Stateless — pure functions. Delegates frontmatter parsing and validation
 * to validator.ts.
 */

import type { Skill, SkillMeta, SkillSource, SkillValidation } from "./types.js";
import {
  parseFrontmatter,
  toBool,
  FRONTMATTER_RE,
  extractReferences,
  validateSkill,
} from "./validator.js";

// Re-export for backwards compatibility and public API
export { validateSkill, extractReferences };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a skill file into a full Skill object (metadata + body).
 * Returns null if the file has no valid frontmatter.
 */
export function parseSkill(filePath: string, content: string): Skill | null {
  const meta = parseSkillMeta(filePath, content);
  if (!meta) return null;

  const match = content.match(FRONTMATTER_RE);
  const body = match ? match[2].trim() : null;
  const referencedFiles = body ? extractReferences(body) : [];

  const now = new Date().toISOString();
  return {
    meta,
    body: body || null,
    referencedFiles,
    state: "registered",
    registeredAt: now,
    refreshedAt: now,
  };
}

/**
 * Parse only the frontmatter metadata from a skill file.
 * Cheaper than full parse — skips body processing.
 * Returns null if the file has no valid frontmatter or is missing required fields.
 */
export function parseSkillMeta(
  filePath: string,
  content: string,
): SkillMeta | null {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return null;

  const fm = parseFrontmatter(match[1]);
  if (!fm.name || !fm.description) return null;

  const userInvocable = toBool(fm["user-invocable"], false);

  const source: SkillSource = filePath.includes("brain/registry/installed")
    ? {
        type: "registry",
        package: fm.name,
        path: filePath,
      }
    : { type: "local", path: filePath };

  return {
    name: fm.name,
    description: fm.description,
    userInvocable,
    disableModelInvocation: toBool(fm["disable-model-invocation"], false),
    slot: userInvocable ? "task" : "reference",
    version: fm.version,
    source,
  };
}
