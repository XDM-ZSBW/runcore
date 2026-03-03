/**
 * Skill schema validation for Core agent skills.
 *
 * Validates `.yml` skill files in `brain/skills/` against the schema
 * defined in `brain/skills/schema.yml`.
 *
 * @example
 * ```ts
 * import { validateSkill, parseSkillYaml } from "./brain/skills.js";
 *
 * const raw = fs.readFileSync("brain/skills/file-editing.yml", "utf-8");
 * const parsed = parseSkillYaml(raw);
 * const result = validateSkill(parsed);
 *
 * if (!result.valid) {
 *   console.error("Validation errors:", result.errors);
 * }
 * ```
 *
 * @example
 * ```ts
 * import { validateSkillFile } from "./brain/skills.js";
 *
 * const result = await validateSkillFile("brain/skills/git-operations.yml");
 * if (result.valid) {
 *   console.log("Skill:", result.skill!.name);
 * }
 * ```
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/** A validated skill definition. */
export interface SkillDefinition {
  name: string;
  description: string;
  tools: string[];
  context_patterns: string[];
  example_prompt: string;
  version?: string;
  tags?: string[];
  depends_on?: string[];
  notes?: string;
}

/** Result of validating a skill file. */
export interface SkillValidationResult {
  valid: boolean;
  errors: string[];
  skill: SkillDefinition | null;
}

const REQUIRED_FIELDS = [
  "name",
  "description",
  "tools",
  "context_patterns",
  "example_prompt",
] as const;

const ARRAY_FIELDS = new Set([
  "tools",
  "context_patterns",
  "tags",
  "depends_on",
]);

const ALL_KNOWN_FIELDS = new Set([
  ...REQUIRED_FIELDS,
  "version",
  "tags",
  "depends_on",
  "notes",
]);

const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * Parse a flat YAML skill file into a key-value record.
 *
 * Handles simple scalars (`key: value`), folded scalars (`key: >`),
 * and arrays (`key:` + `- item` lines). Not a general-purpose YAML
 * parser — designed for the specific structure of Core skill files.
 *
 * @example
 * ```ts
 * const parsed = parseSkillYaml(`
 * name: my-skill
 * tools:
 *   - git
 *   - npm
 * description: >
 *   A multi-line
 *   description here.
 * `);
 * // { name: "my-skill", tools: ["git", "npm"], description: "A multi-line description here." }
 * ```
 */
export function parseSkillYaml(
  content: string,
): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  const lines = content.split("\n");

  let currentKey: string | null = null;
  let currentMode: "scalar" | "folded" | "array" | null = null;
  let foldedLines: string[] = [];

  function flushFolded() {
    if (currentKey && currentMode === "folded" && foldedLines.length > 0) {
      result[currentKey] = foldedLines.join(" ").trim();
      foldedLines = [];
    }
  }

  for (const line of lines) {
    // Skip comments and blank lines at top level
    if (line.trimStart().startsWith("#")) continue;

    // Top-level key: detect `key: value`, `key: >`, or `key:` (array)
    const topMatch = line.match(/^([a-z_][a-z0-9_]*)\s*:\s*(.*)/);
    if (topMatch) {
      flushFolded();
      const key = topMatch[1];
      const rest = topMatch[2].trim();

      currentKey = key;

      if (rest === ">") {
        // Folded scalar — collect indented lines
        currentMode = "folded";
        foldedLines = [];
      } else if (rest === "" || rest === "|") {
        // Could be array (next lines are `- item`) or literal block
        currentMode = "array";
        result[key] = [];
      } else {
        // Simple scalar value — strip surrounding quotes
        currentMode = "scalar";
        result[key] = rest.replace(/^["']|["']$/g, "");
      }
      continue;
    }

    // Indented content: array items or folded continuation
    if (currentKey && line.match(/^\s+/)) {
      const trimmed = line.trim();
      if (trimmed === "") {
        // Blank line inside folded → paragraph break (ignored, just space)
        continue;
      }

      if (currentMode === "array") {
        const itemMatch = trimmed.match(/^-\s+(.*)/);
        if (itemMatch) {
          const val = itemMatch[1].replace(/^["']|["']$/g, "");
          (result[currentKey] as string[]).push(val);
        }
      } else if (currentMode === "folded") {
        foldedLines.push(trimmed);
      }
      continue;
    }

    // Non-indented non-key line (blank line) — flush folded
    if (line.trim() === "") {
      if (currentMode === "folded") {
        // Continue collecting — blank lines are paragraph breaks in folded
      }
    }
  }

  // Flush any remaining folded content
  flushFolded();

  return result;
}

/**
 * Validate a parsed skill object against the Core skill schema.
 *
 * Returns `{ valid: true, errors: [], skill }` on success, or
 * `{ valid: false, errors: [...], skill: null }` with descriptive
 * error messages for each violation.
 *
 * @example
 * ```ts
 * const result = validateSkill({ name: "my-skill", description: "Does stuff" });
 * // { valid: false, errors: ["Missing required field: tools", ...], skill: null }
 * ```
 */
export function validateSkill(
  data: Record<string, unknown>,
): SkillValidationResult {
  const errors: string[] = [];

  // Check required fields exist
  for (const field of REQUIRED_FIELDS) {
    if (!(field in data) || data[field] === undefined || data[field] === "") {
      errors.push(`Missing required field: ${field}`);
    }
  }

  // Warn on unknown fields
  for (const key of Object.keys(data)) {
    if (!ALL_KNOWN_FIELDS.has(key)) {
      errors.push(`Unknown field: ${key}`);
    }
  }

  // Type checks for present fields
  if (typeof data.name === "string") {
    if (!NAME_PATTERN.test(data.name)) {
      errors.push(
        `Invalid name: "${data.name}" — must be kebab-case (lowercase letters, digits, hyphens, starting with a letter)`,
      );
    }
  } else if ("name" in data) {
    errors.push(`Field "name" must be a string, got ${typeof data.name}`);
  }

  if ("description" in data && typeof data.description === "string") {
    if (data.description.length < 10) {
      errors.push(
        `Field "description" is too short (${data.description.length} chars, minimum 10)`,
      );
    }
  } else if ("description" in data) {
    errors.push(
      `Field "description" must be a string, got ${typeof data.description}`,
    );
  }

  if ("example_prompt" in data && typeof data.example_prompt === "string") {
    if (data.example_prompt.length < 10) {
      errors.push(
        `Field "example_prompt" is too short (${data.example_prompt.length} chars, minimum 10)`,
      );
    }
  } else if ("example_prompt" in data) {
    errors.push(
      `Field "example_prompt" must be a string, got ${typeof data.example_prompt}`,
    );
  }

  // Array field checks
  for (const field of ARRAY_FIELDS) {
    if (!(field in data)) continue;
    const value = data[field];

    if (!Array.isArray(value)) {
      errors.push(`Field "${field}" must be an array, got ${typeof value}`);
      continue;
    }

    if (!value.every((item) => typeof item === "string")) {
      errors.push(`Field "${field}" must contain only strings`);
      continue;
    }

    // Required arrays need at least one item
    if (
      (field === "tools" || field === "context_patterns") &&
      value.length === 0
    ) {
      errors.push(`Field "${field}" must have at least one item`);
    }
  }

  // Optional string fields
  for (const field of ["version", "notes"] as const) {
    if (field in data && typeof data[field] !== "string") {
      errors.push(
        `Field "${field}" must be a string, got ${typeof data[field]}`,
      );
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors, skill: null };
  }

  return {
    valid: true,
    errors: [],
    skill: data as unknown as SkillDefinition,
  };
}

/**
 * Read and validate a skill YAML file from disk.
 *
 * Combines parsing and validation in one step. Returns the validated
 * skill definition or a list of errors.
 *
 * @example
 * ```ts
 * const result = await validateSkillFile("brain/skills/file-editing.yml");
 * if (result.valid) {
 *   console.log(`Loaded skill: ${result.skill!.name}`);
 *   console.log(`Tools: ${result.skill!.tools.join(", ")}`);
 * } else {
 *   for (const err of result.errors) console.error(`  - ${err}`);
 * }
 * ```
 */
export async function validateSkillFile(
  filePath: string,
): Promise<SkillValidationResult> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Unknown read error";
    return {
      valid: false,
      errors: [`Failed to read file: ${message}`],
      skill: null,
    };
  }

  const parsed = parseSkillYaml(content);
  return validateSkill(parsed);
}

// ---------------------------------------------------------------------------
// Match context
// ---------------------------------------------------------------------------

/** Context passed to matchSkills for relevance scoring. */
export interface SkillMatchContext {
  /** File paths involved in the current task. */
  filePaths?: string[];
  /** Free-text description of what the agent is doing. */
  content?: string;
}

/** A matched skill with its relevance score. */
export interface SkillMatch {
  skill: SkillDefinition;
  /** Relevance score (0–1). Higher = more relevant. */
  score: number;
  /** Which context_patterns matched. */
  matchedPatterns: string[];
}

// ---------------------------------------------------------------------------
// SkillRegistry
// ---------------------------------------------------------------------------

/**
 * Registry for YAML-based brain skills (`brain/skills/*.yml`).
 *
 * Loads skill definitions from disk, validates them against the schema,
 * and provides context-aware matching and prompt formatting for agent
 * injection.
 */
export class SkillRegistry {
  private readonly skillsDir: string;
  private readonly skills = new Map<string, SkillDefinition>();
  private loaded = false;

  constructor(skillsDir: string) {
    this.skillsDir = skillsDir;
  }

  /**
   * Load all `.yml` skill files from the skills directory.
   * Validates each against the schema and registers valid skills.
   * Skips `schema.yml` itself. Safe to call multiple times — clears
   * and reloads on subsequent calls.
   */
  async loadSkills(): Promise<void> {
    this.skills.clear();

    let files: string[];
    try {
      files = await readdir(this.skillsDir);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.debug(`[brain/skills] Cannot read ${this.skillsDir}: ${message}`);
      this.loaded = true;
      return;
    }

    const ymlFiles = files.filter(
      (f) => f.endsWith(".yml") && f !== "schema.yml",
    );

    const results = await Promise.allSettled(
      ymlFiles.map((f) => readFile(join(this.skillsDir, f), "utf-8")),
    );

    for (let i = 0; i < ymlFiles.length; i++) {
      const result = results[i];
      if (result.status !== "fulfilled") {
        console.debug(`[brain/skills] Failed to read ${ymlFiles[i]}`);
        continue;
      }

      const parsed = parseSkillYaml(result.value);
      const validation = validateSkill(parsed);

      if (!validation.valid) {
        console.debug(
          `[brain/skills] Invalid ${ymlFiles[i]}: ${validation.errors.join("; ")}`,
        );
        continue;
      }

      this.skills.set(validation.skill!.name, validation.skill!);
    }

    this.loaded = true;
    console.debug(
      `[brain/skills] Loaded ${this.skills.size} skill(s) from ${this.skillsDir}`,
    );
  }

  /**
   * Match skills against a task context.
   *
   * Scores each skill by checking its `context_patterns` against the
   * provided file paths (glob-style prefix/suffix matching) and content
   * keywords (case-insensitive substring matching).
   *
   * Returns matches sorted by score descending. Skills with no matches
   * are excluded.
   */
  matchSkills(context: SkillMatchContext): SkillMatch[] {
    this.ensureLoaded();

    const matches: SkillMatch[] = [];
    const contentLower = context.content?.toLowerCase() ?? "";
    const normalizedPaths = (context.filePaths ?? []).map((p) =>
      p.replace(/\\/g, "/"),
    );

    for (const skill of this.skills.values()) {
      const matchedPatterns: string[] = [];

      for (const pattern of skill.context_patterns) {
        // Check against file paths
        if (normalizedPaths.length > 0 && this.patternMatchesPaths(pattern, normalizedPaths)) {
          matchedPatterns.push(pattern);
          continue;
        }

        // Check against content (keyword / substring match)
        if (contentLower && contentLower.includes(pattern.toLowerCase())) {
          matchedPatterns.push(pattern);
        }
      }

      if (matchedPatterns.length > 0) {
        const score = Math.min(
          1.0,
          matchedPatterns.length / skill.context_patterns.length,
        );
        matches.push({ skill, score, matchedPatterns });
      }
    }

    matches.sort((a, b) => b.score - a.score);
    return matches;
  }

  /**
   * Format a skill for injection into an agent prompt.
   *
   * Returns a structured block with the skill name, description, tools,
   * example prompt, and notes — ready for inclusion in an LLM system
   * message. Returns null if the skill is not found.
   */
  getSkillPrompt(skillName: string): string | null {
    this.ensureLoaded();

    const skill = this.skills.get(skillName);
    if (!skill) return null;

    const lines: string[] = [
      `<skill name="${skill.name}">`,
      `## ${skill.name}`,
      "",
      `> ${skill.description.trim()}`,
      "",
      `**Tools:** ${skill.tools.join(", ")}`,
      "",
      `**Example prompt:**`,
      skill.example_prompt.trim(),
    ];

    if (skill.tags && skill.tags.length > 0) {
      lines.push("", `**Tags:** ${skill.tags.join(", ")}`);
    }

    if (skill.notes) {
      lines.push("", `**Notes:**`, skill.notes.trim());
    }

    if (skill.depends_on && skill.depends_on.length > 0) {
      lines.push("", `**Depends on:** ${skill.depends_on.join(", ")}`);
    }

    lines.push("</skill>");

    return lines.join("\n");
  }

  /** Get a skill by name. */
  get(name: string): SkillDefinition | undefined {
    this.ensureLoaded();
    return this.skills.get(name);
  }

  /** Check if a skill is registered. */
  has(name: string): boolean {
    this.ensureLoaded();
    return this.skills.has(name);
  }

  /** List all loaded skill names. */
  list(): string[] {
    this.ensureLoaded();
    return Array.from(this.skills.keys());
  }

  /** Total number of loaded skills. */
  get size(): number {
    return this.skills.size;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  /**
   * Check whether a context_pattern matches any of the given file paths.
   *
   * Supports:
   *  - Extension patterns (`*.ts`, `*.yml`) — matches file suffix
   *  - Directory patterns (`src/`, `logs/`) — matches path containing the dir
   *  - Exact filenames (`CHANGELOG.md`) — matches basename or full path
   */
  private patternMatchesPaths(
    pattern: string,
    paths: string[],
  ): boolean {
    if (pattern.startsWith("*.")) {
      // Extension match: *.ts, *.log, *.yml
      const ext = pattern.slice(1); // ".ts", ".log"
      return paths.some((p) => p.endsWith(ext));
    }

    if (pattern.endsWith("/")) {
      // Directory match: src/, logs/, __tests__/
      return paths.some((p) => p.includes(pattern) || p.includes(pattern.slice(0, -1)));
    }

    if (pattern.includes("/") || pattern.includes(".")) {
      // Path or filename match: CHANGELOG.md, vitest.config.*
      if (pattern.includes("*")) {
        // Glob-like: vitest.config.*
        const prefix = pattern.split("*")[0];
        return paths.some((p) => p.includes(prefix));
      }
      return paths.some((p) => p.includes(pattern));
    }

    // Bare keyword — doesn't match paths, only content
    return false;
  }

  /** Throw if loadSkills() hasn't been called yet. */
  private ensureLoaded(): void {
    if (!this.loaded) {
      throw new Error(
        "SkillRegistry not loaded. Call loadSkills() before using the registry.",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

/** Pre-configured singleton for `brain/skills/`. */
export const brainSkillRegistry = new SkillRegistry("brain/skills");
