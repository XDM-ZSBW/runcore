/**
 * Skills Library — Skill registry.
 *
 * Discovers, indexes, and serves YAML-based skill files from the brain's
 * skills/ directory. Scans for .yaml/.yml files, parses their metadata,
 * and provides lookup by id, trigger, or full content retrieval.
 */

import { readdir, readFile } from "node:fs/promises";
import { join, basename, extname } from "node:path";
import { BRAIN_DIR } from "../lib/paths.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single skill entry parsed from a YAML file. */
export interface SkillEntry {
  /** Filename without extension. */
  id: string;
  /** Human-readable name from YAML. */
  name: string;
  /** reference = auto-load, task = user-invoked. */
  type: "reference" | "task";
  /** What this skill does. */
  description: string;
  /** Slash commands or keywords that invoke this skill. */
  triggers?: string[];
  /** Brain files this skill references. */
  loads?: string[];
  /** Absolute path to the YAML file. */
  filePath: string;
}

// ---------------------------------------------------------------------------
// YAML parsing helpers
// ---------------------------------------------------------------------------

/** Brain-path regex for extracting referenced files. */
const BRAIN_PATH_RE = /brain\/[\w\-\/]+\.\w+/g;

/**
 * Parse a simple YAML file into a key-value record.
 *
 * Handles scalars (`key: value`), folded scalars (`key: >`),
 * and arrays (`key:` followed by `- item` lines). If the content
 * has `---` frontmatter delimiters, parses only the frontmatter block.
 */
function parseYaml(content: string): Record<string, string | string[]> {
  // If frontmatter-delimited, extract just the frontmatter
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const raw = fmMatch ? fmMatch[1] : content;

  const result: Record<string, string | string[]> = {};
  const lines = raw.split("\n");

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
    if (line.trimStart().startsWith("#")) continue;

    // Top-level key detection (not indented)
    const topMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)/);
    if (topMatch) {
      flushFolded();
      const key = topMatch[1];
      const rest = topMatch[2].trim();

      currentKey = key;

      if (rest === ">") {
        currentMode = "folded";
        foldedLines = [];
      } else if (rest === "" || rest === "|") {
        currentMode = "array";
        result[key] = [];
      } else {
        currentMode = "scalar";
        result[key] = rest.replace(/^["']|["']$/g, "");
      }
      continue;
    }

    // Indented content
    if (currentKey && line.match(/^\s+/)) {
      const trimmed = line.trim();
      if (trimmed === "") continue;

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

    // Blank non-indented line — keep collecting folded if active
    if (line.trim() === "" && currentMode === "folded") continue;
  }

  flushFolded();
  return result;
}

/**
 * Extract brain file references from content.
 * Scans for patterns like `brain/identity/tone-of-voice.md`.
 */
function extractBrainRefs(content: string): string[] {
  const matches = content.match(BRAIN_PATH_RE);
  if (!matches) return [];
  return [...new Set(matches)];
}

/**
 * Determine skill type from parsed YAML data.
 *
 * - Explicit `type` field takes priority.
 * - `user-invocable: true` → "task"
 * - `slot: task` → "task"
 * - Otherwise "reference" (auto-loaded by context).
 */
function inferType(
  data: Record<string, string | string[]>,
): "reference" | "task" {
  const typeVal =
    typeof data.type === "string" ? data.type.toLowerCase() : undefined;
  if (typeVal === "task") return "task";
  if (typeVal === "reference") return "reference";

  const slot =
    typeof data.slot === "string" ? data.slot.toLowerCase() : undefined;
  if (slot === "task") return "task";
  if (slot === "reference") return "reference";

  const userInvocable =
    typeof data["user-invocable"] === "string"
      ? data["user-invocable"]
      : undefined;
  if (userInvocable === "true" || userInvocable === "yes") return "task";

  // Default: task skills are invoked by the user, reference skills auto-load.
  // Files with context_patterns are typically task skills.
  if (data.context_patterns && Array.isArray(data.context_patterns)) {
    return "task";
  }

  return "reference";
}

// ---------------------------------------------------------------------------
// scanSkills
// ---------------------------------------------------------------------------

/**
 * Scan the brain's skills directory for .yaml/.yml files and parse them
 * into SkillEntry objects.
 *
 * Gracefully handles missing directories and malformed files — logs
 * warnings to stderr and skips invalid entries.
 *
 * @returns Array of parsed skill entries.
 */
export async function scanSkills(): Promise<SkillEntry[]> {
  const skillsDir = join(BRAIN_DIR, "skills");
  const entries: SkillEntry[] = [];

  let files: string[];
  try {
    files = await readdir(skillsDir);
  } catch {
    // Directory doesn't exist — not an error, just no skills
    return entries;
  }

  const yamlFiles = files.filter((f) => {
    const ext = extname(f).toLowerCase();
    return (ext === ".yaml" || ext === ".yml") && f !== "schema.yml";
  });

  const results = await Promise.allSettled(
    yamlFiles.map((f) => readFile(join(skillsDir, f), "utf-8")),
  );

  for (let i = 0; i < yamlFiles.length; i++) {
    const result = results[i];
    if (result.status !== "fulfilled") continue;

    const file = yamlFiles[i];
    const filePath = join(skillsDir, file);
    const content = result.value;

    try {
      const data = parseYaml(content);

      const id = basename(file, extname(file));
      const name =
        typeof data.name === "string" ? data.name : id;
      const description =
        typeof data.description === "string" ? data.description : "";

      const type = inferType(data);

      // Triggers: context_patterns array, categories, or tags
      let triggers: string[] | undefined;
      if (Array.isArray(data.context_patterns)) {
        triggers = data.context_patterns as string[];
      } else if (Array.isArray(data.categories)) {
        triggers = data.categories as string[];
      } else if (Array.isArray(data.tags)) {
        triggers = data.tags as string[];
      }

      // Loads: brain paths found in the full file content
      const brainRefs = extractBrainRefs(content);
      const loads = brainRefs.length > 0 ? brainRefs : undefined;

      entries.push({
        id,
        name,
        type,
        description,
        triggers,
        loads,
        filePath,
      });
    } catch (err) {
      console.debug(
        `[skills] Failed to parse ${file}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// SkillRegistry
// ---------------------------------------------------------------------------

/**
 * In-memory registry for YAML-based brain skills.
 *
 * Discovers skills from `{BRAIN_DIR}/skills/`, indexes them by id and
 * trigger, and provides content retrieval. Call `refresh()` to re-scan
 * from disk.
 */
export class SkillRegistry {
  private entries: SkillEntry[] = [];
  private byId = new Map<string, SkillEntry>();
  private initialized = false;

  /** Re-scan the skills directory and rebuild the index. */
  async refresh(): Promise<void> {
    this.entries = await scanSkills();
    this.byId.clear();
    for (const entry of this.entries) {
      this.byId.set(entry.id, entry);
    }
    this.initialized = true;
  }

  /** Return all skill entries. Initializes on first call if needed. */
  async list(): Promise<SkillEntry[]> {
    if (!this.initialized) await this.refresh();
    return this.entries;
  }

  /** Get a single skill entry by id, or undefined if not found. */
  async get(id: string): Promise<SkillEntry | undefined> {
    if (!this.initialized) await this.refresh();
    return this.byId.get(id);
  }

  /**
   * Find a skill matching a slash command or keyword trigger.
   *
   * Checks each skill's `triggers` array for an exact match (case-insensitive).
   * Also matches against skill id and name.
   *
   * @param trigger - The slash command (e.g., "/debug") or keyword to match.
   * @returns The first matching SkillEntry, or undefined.
   */
  async findByTrigger(trigger: string): Promise<SkillEntry | undefined> {
    if (!this.initialized) await this.refresh();

    const normalized = trigger.replace(/^\//, "").toLowerCase();

    // Exact id match
    for (const entry of this.entries) {
      if (entry.id.toLowerCase() === normalized) return entry;
    }

    // Name match
    for (const entry of this.entries) {
      if (entry.name.toLowerCase() === normalized) return entry;
    }

    // Trigger match
    for (const entry of this.entries) {
      if (!entry.triggers) continue;
      for (const t of entry.triggers) {
        if (t.toLowerCase() === normalized) return entry;
      }
    }

    // Substring match on triggers
    for (const entry of this.entries) {
      if (!entry.triggers) continue;
      for (const t of entry.triggers) {
        if (t.toLowerCase().includes(normalized) || normalized.includes(t.toLowerCase())) {
          return entry;
        }
      }
    }

    return undefined;
  }

  /**
   * Read and return the full content of a skill file.
   *
   * @param id - The skill id (filename without extension).
   * @returns The raw file content as a string, or null if not found.
   */
  async getContent(id: string): Promise<string | null> {
    if (!this.initialized) await this.refresh();

    const entry = this.byId.get(id);
    if (!entry) return null;

    try {
      return await readFile(entry.filePath, "utf-8");
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

/** Pre-configured singleton. Lazily initializes on first use. */
export const skillRegistry = new SkillRegistry();
