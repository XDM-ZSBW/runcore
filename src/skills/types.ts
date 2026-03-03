/**
 * Skills Library — Type definitions.
 *
 * Defines the runtime representation of Core skills: metadata parsed from
 * YAML frontmatter, lifecycle states, resolution results, and validation.
 */

// ---------------------------------------------------------------------------
// Skill slot — how the skill is triggered
// ---------------------------------------------------------------------------

/** How the skill is invoked. */
export type SkillSlot = "task" | "reference";

/** Lifecycle state of a skill in the registry. */
export type SkillState =
  | "discovered" // Known but not loaded (registry metadata only)
  | "registered" // Parsed and in the registry map
  | "active" // Currently loaded into a turn's context
  | "disabled" // Explicitly disabled by the user
  | "archived"; // Soft-deleted (append-only — never removed)

/** Valid state transitions. */
export const SKILL_TRANSITIONS: Record<SkillState, SkillState[]> = {
  discovered: ["registered", "archived"],
  registered: ["active", "disabled", "archived"],
  active: ["registered"], // deactivate after turn
  disabled: ["registered", "archived"], // re-enable or archive
  archived: [], // terminal
};

// ---------------------------------------------------------------------------
// Skill metadata — parsed from YAML frontmatter
// ---------------------------------------------------------------------------

/** Where the skill came from. */
export type SkillSource =
  | { type: "local"; path: string } // skills/ directory
  | { type: "registry"; package: string; path: string } // brain/registry/installed/
  | { type: "inline" }; // programmatically created

/** Metadata extracted from a skill file's YAML frontmatter. */
export interface SkillMeta {
  /** Unique skill identifier (the `name` field in frontmatter). */
  name: string;

  /** Human-readable description / when to load. */
  description: string;

  /** Can the user invoke this skill by name or slash command? */
  userInvocable: boolean;

  /**
   * If true, the agent only runs this skill when the user explicitly
   * invokes it (not via auto-routing).
   */
  disableModelInvocation: boolean;

  /** Derived from frontmatter flags: userInvocable → "task", else "reference". */
  slot: SkillSlot;

  /** Version string (for registry-installed skills). */
  version?: string;

  /** Source origin. */
  source: SkillSource;
}

// ---------------------------------------------------------------------------
// Skill — the full runtime representation
// ---------------------------------------------------------------------------

/** A fully parsed skill: metadata + body content. */
export interface Skill {
  /** Metadata from frontmatter. */
  meta: SkillMeta;

  /** Markdown body (the instructions). Loaded lazily — null until loadBody(). */
  body: string | null;

  /** Files this skill references (extracted from body). */
  referencedFiles: string[];

  /** Current lifecycle state. */
  state: SkillState;

  /** When this skill was first registered (ISO). */
  registeredAt: string;

  /** When metadata or body was last refreshed from disk (ISO). */
  refreshedAt: string;
}

// ---------------------------------------------------------------------------
// Skill resolution
// ---------------------------------------------------------------------------

/** Result of resolving a skill for a given intent. */
export interface SkillResolution {
  /** The resolved skill. */
  skill: Skill;

  /** Why this skill was selected. */
  reason: "exact-match" | "intent-match" | "auto-load" | "rule-trigger";

  /** Confidence score (0–1). Exact match = 1. */
  confidence: number;

  /** Source priority (lower = higher priority). Local = 0, registry = 10. */
  priority: number;
}

// ---------------------------------------------------------------------------
// Skill validation
// ---------------------------------------------------------------------------

/** Result of validating a skill file. */
export interface SkillValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Lifecycle error
// ---------------------------------------------------------------------------

/** Thrown when an invalid state transition is attempted. */
export class SkillLifecycleError extends Error {
  constructor(
    public readonly skillName: string,
    public readonly currentState: SkillState,
    public readonly attemptedState: SkillState,
  ) {
    super(
      `Invalid skill state transition for "${skillName}": ${currentState} → ${attemptedState}`,
    );
    this.name = "SkillLifecycleError";
  }
}
