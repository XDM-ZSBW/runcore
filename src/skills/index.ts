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

// Registry
export {
  SkillRegistry,
  createSkillRegistry,
  getSkillRegistry,
  skillRegistry,
} from "./registry.js";
export type { SkillMatchContext } from "./registry.js";
