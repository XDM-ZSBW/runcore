/**
 * Skills Library — Skill registry.
 *
 * In-memory registry of all known skills with file-backed discovery.
 * Mirrors the AgentRegistry pattern: in-memory Map, scan directories on init,
 * lazy body loading, resolution by intent.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  Skill,
  SkillMeta,
  SkillState,
  SkillSlot,
  SkillResolution,
  SkillValidation,
} from "./types.js";
import { SKILL_TRANSITIONS, SkillLifecycleError } from "./types.js";
import { parseSkillMeta } from "./loader.js";
import { validateSkill, extractReferences } from "./validator.js";

// ---------------------------------------------------------------------------
// Context type for matchSkills
// ---------------------------------------------------------------------------

/** Task context used for skill matching. */
export interface SkillMatchContext {
  /** Free-text description of the task (e.g., "write a blog post about AI"). */
  description: string;
  /** File paths relevant to the task (used for reference-skill auto-loading). */
  filePaths?: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Tokenize a string into lowercase words for intent matching. */
function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
}

/** Jaccard similarity between two token sets. */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Source priority for resolution ordering. */
function sourcePriority(skill: Skill): number {
  switch (skill.meta.source.type) {
    case "local":
      return 0;
    case "inline":
      return 5;
    case "registry":
      return 10;
  }
}

/** Writing-related keywords for auto-loading reference skills. */
const WRITING_KEYWORDS = new Set([
  "write",
  "draft",
  "edit",
  "blog",
  "post",
  "email",
  "thread",
  "article",
  "copy",
  "content",
]);

/** Architecture/identity keywords for auto-loading self-knowledge skills. */
const IDENTITY_KEYWORDS = new Set([
  "architecture",
  "whitepaper",
  "core",
  "design",
  "philosophy",
  "identity",
  "metabolic",
  "metabolism",
  "reflection",
  "autonomy",
  "autonomous",
  "governance",
  "entropy",
  "loop",
  "loops",
  "pillar",
  "yourself",
  "how",
]);

// ---------------------------------------------------------------------------
// SkillRegistry
// ---------------------------------------------------------------------------

export class SkillRegistry {
  /** In-memory skill map, keyed by skill name. */
  private readonly skills = new Map<string, Skill>();

  /** Ordered list of source directories (priority order). */
  private readonly sourceDirs: string[];

  /** Path to brain directory. */
  private readonly brainDir: string;

  private initialized = false;

  constructor(opts: { skillsDir: string; brainDir: string }) {
    this.brainDir = opts.brainDir;
    this.sourceDirs = [
      opts.skillsDir, // Priority 0: local
      join(opts.brainDir, "registry", "installed"), // Priority 1: registry
    ];
  }

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------

  /**
   * Scan all source directories and register discovered skills.
   * Loads metadata eagerly, body lazily.
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    await this.scanDirectories();
    this.initialized = true;
  }

  /**
   * Load all skills from the configured source directories, validating each
   * against the skill schema. Logs debug information about discovered skills,
   * validation errors, and warnings.
   *
   * This is the high-level entry point — wraps `init()` with validation and
   * debug output. Safe to call multiple times; subsequent calls refresh from disk.
   *
   * @returns Array of validation results for each discovered skill file.
   */
  async loadSkills(): Promise<{ file: string; validation: SkillValidation }[]> {
    const results: { file: string; validation: SkillValidation }[] = [];

    for (const dir of this.sourceDirs) {
      let files: string[];
      try {
        files = await readdir(dir);
      } catch {
        console.debug(`[skills] Directory not found, skipping: ${dir}`);
        continue;
      }

      const mdFiles = files.filter(
        (f) => f.endsWith(".md") && f !== "README.md",
      );
      console.debug(`[skills] Found ${mdFiles.length} skill file(s) in ${dir}`);

      for (const file of mdFiles) {
        const filePath = join(dir, file);
        try {
          const content = await readFile(filePath, "utf-8");
          const validation = validateSkill(filePath, content);
          results.push({ file: filePath, validation });

          if (!validation.valid) {
            console.debug(
              `[skills] INVALID ${file}: ${validation.errors.join("; ")}`,
            );
          } else {
            console.debug(`[skills] Loaded ${file}`);
            if (validation.warnings.length > 0) {
              console.debug(
                `[skills]   warnings: ${validation.warnings.join("; ")}`,
              );
            }
          }
        } catch (err) {
          console.debug(`[skills] Failed to read ${filePath}: ${err}`);
        }
      }
    }

    // Perform the actual registration (idempotent)
    if (!this.initialized) {
      await this.init();
    } else {
      await this.refresh();
    }

    console.debug(
      `[skills] Registry loaded: ${this.size} skill(s) — ${JSON.stringify(this.countByState())}`,
    );

    return results;
  }

  /**
   * Re-scan source directories. Picks up new/changed/removed files.
   * Does not unregister skills that were loaded programmatically (inline).
   */
  async refresh(): Promise<void> {
    // Snapshot refresh timestamps before scan to detect stale entries
    const preRefresh = new Map<string, string>();
    for (const [name, skill] of this.skills) {
      if (skill.meta.source.type !== "inline") {
        preRefresh.set(name, skill.refreshedAt);
      }
    }

    await this.scanDirectories();

    // Archive file-backed skills whose refreshedAt was NOT updated by the scan.
    // scanDirectories() sets a new refreshedAt on every skill it finds on disk,
    // so an unchanged timestamp means the source file no longer exists.
    for (const [name, oldTimestamp] of preRefresh) {
      const skill = this.skills.get(name);
      if (!skill) continue;
      if (skill.state === "archived") continue;
      if (skill.refreshedAt === oldTimestamp) {
        // Source file was not found during scan — archive the skill
        skill.state = "archived";
      }
    }
  }

  // -------------------------------------------------------------------------
  // CRUD
  // -------------------------------------------------------------------------

  /** Get a skill by name. */
  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  /** Check if a skill is registered. */
  has(name: string): boolean {
    return this.skills.has(name);
  }

  /** Register a skill (from loader or programmatic creation). */
  register(skill: Skill): void {
    const existing = this.skills.get(skill.meta.name);
    if (existing) {
      // Local skills win over registry skills
      if (
        sourcePriority(skill) >= sourcePriority(existing) &&
        existing.meta.source.type !== skill.meta.source.type
      ) {
        return; // Keep existing higher-priority skill
      }
    }
    this.skills.set(skill.meta.name, skill);
  }

  /** Archive a skill (terminal state — append-only, never removed). */
  archive(name: string): void {
    const skill = this.skills.get(name);
    if (!skill) return;
    this.transition(skill, "archived");
  }

  /** Enable a previously disabled skill. */
  enable(name: string): void {
    const skill = this.skills.get(name);
    if (!skill) return;
    this.transition(skill, "registered");
  }

  /** Disable a skill (skipped during resolution). */
  disable(name: string): void {
    const skill = this.skills.get(name);
    if (!skill) return;
    this.transition(skill, "disabled");
  }

  /** List all skills, optionally filtered. */
  list(filter?: {
    state?: SkillState;
    slot?: SkillSlot;
    source?: "local" | "registry" | "inline";
  }): Skill[] {
    const all = Array.from(this.skills.values());
    if (!filter) return all;

    return all.filter((skill) => {
      if (filter.state && skill.state !== filter.state) return false;
      if (filter.slot && skill.meta.slot !== filter.slot) return false;
      if (filter.source && skill.meta.source.type !== filter.source)
        return false;
      return true;
    });
  }

  // -------------------------------------------------------------------------
  // Body loading (lazy)
  // -------------------------------------------------------------------------

  /**
   * Load the full body content for a skill.
   * No-op if body is already loaded.
   * Reads from the skill's source file path.
   */
  async loadBody(name: string): Promise<string | null> {
    const skill = this.skills.get(name);
    if (!skill) return null;
    if (skill.body !== null) return skill.body;

    // Inline skills have no file to read
    if (skill.meta.source.type === "inline") return null;

    const filePath = skill.meta.source.path;
    try {
      const content = await readFile(filePath, "utf-8");
      const fmMatch = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
      skill.body = fmMatch ? fmMatch[1].trim() : content;
      skill.referencedFiles = extractReferences(skill.body);
      skill.refreshedAt = new Date().toISOString();
      return skill.body;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Resolution
  // -------------------------------------------------------------------------

  /**
   * Resolve which skill(s) apply to a given intent.
   *
   * Resolution order:
   * 1. Exact name match (e.g., "/write-blog" → skill named "write-blog")
   * 2. Intent keyword matching against skill descriptions (task skills)
   * 3. Auto-load reference skills whose descriptions match the task type
   *
   * Returns results sorted by priority (local > registry) then confidence.
   */
  resolve(
    intent: string,
    opts?: { includeReference?: boolean; limit?: number },
  ): SkillResolution[] {
    const results: SkillResolution[] = [];
    const limit = opts?.limit ?? 5;
    const seen = new Set<string>();

    // 1. EXACT MATCH
    const stripped = intent.replace(/^\//, "");
    const exact = this.skills.get(stripped);
    if (exact && exact.state === "registered") {
      results.push({
        skill: exact,
        reason: "exact-match",
        confidence: 1.0,
        priority: sourcePriority(exact),
      });
      seen.add(exact.meta.name);
    }

    const intentTokens = tokenize(intent);

    // 2. INTENT MATCH (task skills only)
    for (const skill of this.skills.values()) {
      if (seen.has(skill.meta.name)) continue;
      if (skill.state !== "registered") continue;
      if (skill.meta.slot !== "task") continue;
      if (skill.meta.disableModelInvocation) continue; // Only user-invoked

      const descTokens = tokenize(skill.meta.description);
      const score = jaccard(intentTokens, descTokens);
      if (score > 0.3) {
        results.push({
          skill,
          reason: "intent-match",
          confidence: score,
          priority: sourcePriority(skill),
        });
        seen.add(skill.meta.name);
      }
    }

    // 3. AUTO-LOAD (reference skills, if requested)
    if (opts?.includeReference) {
      for (const skill of this.skills.values()) {
        if (seen.has(skill.meta.name)) continue;
        if (skill.state !== "registered") continue;
        if (skill.meta.slot !== "reference") continue;

        const descTokens = tokenize(skill.meta.description);

        // Strategy A: Keyword-set matching (writing OR identity keywords)
        const hasWritingKeyword = [...intentTokens].some((t) =>
          WRITING_KEYWORDS.has(t),
        );
        const descHasWriting = [...descTokens].some((t) =>
          WRITING_KEYWORDS.has(t),
        );
        const hasIdentityKeyword = [...intentTokens].some((t) =>
          IDENTITY_KEYWORDS.has(t),
        );
        const descHasIdentity = [...descTokens].some((t) =>
          IDENTITY_KEYWORDS.has(t),
        );

        if (
          (hasWritingKeyword && descHasWriting) ||
          (hasIdentityKeyword && descHasIdentity)
        ) {
          results.push({
            skill,
            reason: "auto-load",
            confidence: 0.5,
            priority: sourcePriority(skill),
          });
          seen.add(skill.meta.name);
          continue;
        }

        // Strategy B: Description keyword overlap (Jaccard between intent and
        // skill description). Fallback for intents that don't hit keyword sets
        // but still have meaningful overlap with the skill description.
        const descScore = jaccard(intentTokens, descTokens);
        if (descScore > 0.15) {
          results.push({
            skill,
            reason: "auto-load",
            confidence: descScore,
            priority: sourcePriority(skill),
          });
          seen.add(skill.meta.name);
        }
      }
    }

    // Sort: priority ASC, then confidence DESC
    results.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return b.confidence - a.confidence;
    });

    return results.slice(0, limit);
  }

  /** Resolve a single skill by exact name. */
  resolveByName(name: string): Skill | undefined {
    const stripped = name.replace(/^\//, "");
    const skill = this.skills.get(stripped);
    if (skill && skill.state !== "archived") return skill;
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Context-based matching
  // -------------------------------------------------------------------------

  /**
   * Match skills to a task context. Takes structured context (description and
   * optional file paths) and returns relevant skills ranked by relevance.
   *
   * File paths are used to boost reference skills that mention matching brain
   * module paths (e.g., a task touching `brain/identity/tone-of-voice.md`
   * will boost the `voice-guide` reference skill).
   *
   * @param context - Task context with description and optional file paths.
   * @returns Array of matching skill resolutions, sorted by priority then confidence.
   */
  matchSkills(context: SkillMatchContext): SkillResolution[] {
    // Start with intent-based resolution (includes reference skills)
    const results = this.resolve(context.description, {
      includeReference: true,
      limit: 10,
    });

    // Boost skills whose referenced files overlap with the task's file paths
    if (context.filePaths && context.filePaths.length > 0) {
      const taskPaths = new Set(
        context.filePaths.map((p) => p.replace(/\\/g, "/")),
      );

      for (const result of results) {
        const skill = result.skill;
        // If body isn't loaded yet, use empty refs (we don't want async here)
        const refs = skill.referencedFiles;
        if (refs.length === 0) continue;

        const overlap = refs.filter(
          (ref) =>
            taskPaths.has(ref) ||
            [...taskPaths].some((tp) => tp.includes(ref) || ref.includes(tp)),
        );

        if (overlap.length > 0) {
          // Boost confidence proportionally to reference overlap
          const boost = Math.min(0.3, overlap.length * 0.1);
          result.confidence = Math.min(1.0, result.confidence + boost);
        }
      }

      // Check for file-path-matched skills not yet in results
      for (const skill of this.skills.values()) {
        if (skill.state !== "registered") continue;
        if (results.some((r) => r.skill.meta.name === skill.meta.name))
          continue;

        const refs = skill.referencedFiles;
        const overlap = refs.filter(
          (ref) =>
            taskPaths.has(ref) ||
            [...taskPaths].some((tp) => tp.includes(ref) || ref.includes(tp)),
        );

        if (overlap.length > 0) {
          results.push({
            skill,
            reason: "rule-trigger",
            confidence: Math.min(0.8, overlap.length * 0.2),
            priority: sourcePriority(skill),
          });
        }
      }

      // Re-sort after boosting
      results.sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return b.confidence - a.confidence;
      });
    }

    return results;
  }

  // -------------------------------------------------------------------------
  // Prompt formatting
  // -------------------------------------------------------------------------

  /**
   * Format a skill's content for injection into an agent prompt.
   *
   * Returns a formatted string with the skill name, description, and full
   * instruction body wrapped in a clear delimiter. Returns null if the skill
   * is not found or has no loaded body.
   *
   * Call `loadBody(skillName)` first if the body hasn't been loaded yet.
   *
   * @param skillName - The name of the skill to format.
   * @returns Formatted prompt string, or null if skill/body unavailable.
   */
  getSkillPrompt(skillName: string): string | null {
    const skill = this.skills.get(skillName);
    if (!skill) return null;
    if (skill.body === null) return null;

    const lines: string[] = [
      `<skill name="${skill.meta.name}" slot="${skill.meta.slot}">`,
      `## ${skill.meta.name}`,
      "",
      `> ${skill.meta.description}`,
      "",
      skill.body,
    ];

    if (skill.referencedFiles.length > 0) {
      lines.push("", "### Referenced files");
      for (const ref of skill.referencedFiles) {
        lines.push(`- ${ref}`);
      }
    }

    lines.push("</skill>");

    return lines.join("\n");
  }

  // -------------------------------------------------------------------------
  // Debug / introspection
  // -------------------------------------------------------------------------

  /**
   * Return all loaded skills for debugging and introspection.
   *
   * Unlike `list()` which supports filtering, this returns every skill in the
   * registry regardless of state, along with summary metadata useful for
   * debugging (name, slot, state, source type, whether body is loaded).
   *
   * @returns Array of all skills with their current state.
   */
  getAllSkills(): Array<{
    name: string;
    slot: SkillSlot;
    state: SkillState;
    source: string;
    bodyLoaded: boolean;
    referencedFiles: string[];
  }> {
    return Array.from(this.skills.values()).map((skill) => ({
      name: skill.meta.name,
      slot: skill.meta.slot,
      state: skill.state,
      source: skill.meta.source.type,
      bodyLoaded: skill.body !== null,
      referencedFiles: skill.referencedFiles,
    }));
  }

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  /** Validate a skill file before registration. */
  validate(filePath: string, content: string): SkillValidation {
    return validateSkill(filePath, content);
  }

  // -------------------------------------------------------------------------
  // Metrics
  // -------------------------------------------------------------------------

  /** Count skills by state. */
  countByState(): Record<SkillState, number> {
    const counts: Record<string, number> = {
      discovered: 0,
      registered: 0,
      active: 0,
      disabled: 0,
      archived: 0,
    };
    for (const skill of this.skills.values()) {
      counts[skill.state] = (counts[skill.state] || 0) + 1;
    }
    return counts as Record<SkillState, number>;
  }

  /** Total registered skills. */
  get size(): number {
    return this.skills.size;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  /** Transition a skill's state, enforcing the state machine. */
  private transition(skill: Skill, to: SkillState): void {
    const allowed = SKILL_TRANSITIONS[skill.state];
    if (!allowed.includes(to)) {
      throw new SkillLifecycleError(skill.meta.name, skill.state, to);
    }
    skill.state = to;
  }

  /** Scan all source directories in parallel for .md skill files. */
  private async scanDirectories(): Promise<void> {
    await Promise.all(this.sourceDirs.map((dir) => this.scanDirectory(dir)));
  }

  /** Register a skill from parsed file content. */
  private registerFromFile(filePath: string, content: string): void {
    const meta = parseSkillMeta(filePath, content);
    if (!meta) return;

    const existing = this.skills.get(meta.name);
    if (existing) {
      existing.meta = meta;
      existing.body = null;
      existing.refreshedAt = new Date().toISOString();
    } else {
      const now = new Date().toISOString();
      this.skills.set(meta.name, {
        meta,
        body: null,
        referencedFiles: [],
        state: "registered",
        registeredAt: now,
        refreshedAt: now,
      });
    }
  }

  /** Scan a single directory for skill files and register them (parallel I/O). */
  private async scanDirectory(dir: string): Promise<void> {
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      return; // Directory doesn't exist yet — that's fine
    }

    const mdFiles = files.filter((f) => f.endsWith(".md") && f !== "README.md");
    const nonMdEntries = files.filter((f) => !f.endsWith(".md") && f !== "README.md");

    // Read all .md files in parallel
    if (mdFiles.length > 0) {
      const results = await Promise.allSettled(
        mdFiles.map((f) => readFile(join(dir, f), "utf-8")),
      );
      for (let i = 0; i < mdFiles.length; i++) {
        const result = results[i];
        if (result.status === "fulfilled") {
          this.registerFromFile(join(dir, mdFiles[i]), result.value);
        }
      }
    }

    // Scan subdirectories in parallel (for registry-installed packages)
    if (nonMdEntries.length > 0) {
      await Promise.allSettled(
        nonMdEntries.map(async (entry) => {
          const subDir = join(dir, entry);
          let subFiles: string[];
          try {
            subFiles = await readdir(subDir);
          } catch {
            return;
          }
          const subMdFiles = subFiles.filter((f) => f.endsWith(".md"));
          if (subMdFiles.length === 0) return;

          const subResults = await Promise.allSettled(
            subMdFiles.map((f) => readFile(join(subDir, f), "utf-8")),
          );
          for (let i = 0; i < subMdFiles.length; i++) {
            const result = subResults[i];
            if (result.status !== "fulfilled") continue;
            const filePath = join(subDir, subMdFiles[i]);
            const meta = parseSkillMeta(filePath, result.value);
            if (meta && !this.skills.has(meta.name)) {
              const now = new Date().toISOString();
              this.skills.set(meta.name, {
                meta,
                body: null,
                referencedFiles: [],
                state: "registered",
                registeredAt: now,
                refreshedAt: now,
              });
            }
          }
        }),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _registry: SkillRegistry | null = null;

/** Create and initialize the global skill registry. */
export async function createSkillRegistry(opts: {
  skillsDir: string;
  brainDir: string;
}): Promise<SkillRegistry> {
  if (_registry) return _registry;
  _registry = new SkillRegistry(opts);
  await _registry.init();
  return _registry;
}

/** Get the global skill registry (null if not initialized). */
export function getSkillRegistry(): SkillRegistry | null {
  return _registry;
}

/**
 * Pre-configured singleton using default paths (skills/ and brain/).
 * Call `skillRegistry.loadSkills()` or `skillRegistry.init()` before use.
 */
export const skillRegistry = new SkillRegistry({
  skillsDir: "skills",
  brainDir: "brain",
});
