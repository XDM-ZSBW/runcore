/**
 * Skills Library — Public API.
 */

// Types
export type {
  Skill,
  SkillMeta,
  SkillSlot,
  SkillState,
  SkillSource,
  SkillResolution,
  SkillValidation,
} from "./types.js";
export { SKILL_TRANSITIONS, SkillLifecycleError } from "./types.js";

// Loader
export { parseSkill, parseSkillMeta } from "./loader.js";

// Validator
export {
  validateSkill,
  extractReferences,
  parseFrontmatter,
} from "./validator.js";

// Registry (YAML-based brain skills)
export {
  SkillRegistry,
  skillRegistry,
  scanSkills,
} from "./registry.js";
export type { SkillEntry } from "./registry.js";
