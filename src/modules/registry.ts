/**
 * ModuleRegistry — discovers brain modules via module.json manifests.
 *
 * Mirrors the SkillRegistry singleton pattern. Scans brain/ subdirectories
 * for module.json files, validates them, and provides:
 * - System prompt fragments (getPromptFragments)
 * - Per-turn keyword resolution (resolve)
 * - Simple lookups (list, get)
 */

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import type {
  BrainModuleManifest,
  BrainModule,
  ModuleResolution,
} from "./types.js";

const INSTRUCTION_FILENAMES = [
  "README.md",
  "CONTENT.md",
  "OPERATIONS.md",
  "TRAINING.md",
  "AGENTS.md",
  "METRICS.md",
];

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildKeywordPattern(keywords: string[]): RegExp {
  const parts = keywords.map(
    (kw) => `\\b${escapeRegex(kw)}\\b`
  );
  return new RegExp(parts.join("|"), "i");
}

function detectInstructionFile(dir: string): string | null {
  for (const name of INSTRUCTION_FILENAMES) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return null;
}

export class ModuleRegistry {
  private readonly brainDir: string;
  private readonly modules = new Map<string, BrainModule>();
  private initialized = false;

  constructor(brainDir: string) {
    this.brainDir = brainDir;
  }

  init(): void {
    if (this.initialized) return;
    this.scanBrainDir();
    this.initialized = true;
  }

  private scanBrainDir(): void {
    let entries: string[];
    try {
      entries = readdirSync(this.brainDir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const dir = join(this.brainDir, entry);
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }

      const manifestPath = join(dir, "module.json");
      if (!existsSync(manifestPath)) continue;

      try {
        const raw = readFileSync(manifestPath, "utf-8");
        const manifest: BrainModuleManifest = JSON.parse(raw);

        if (!manifest.name || !manifest.description || !Array.isArray(manifest.keywords)) {
          continue;
        }

        if (manifest.promptOrder === undefined) {
          manifest.promptOrder = 50;
        }

        this.modules.set(manifest.name, {
          manifest,
          dir,
          instructionFile: detectInstructionFile(dir),
          keywordPattern: buildKeywordPattern(manifest.keywords),
        });
      } catch {
        // Invalid JSON or read error — skip
      }
    }
  }

  /**
   * Test each module's keyword regex against a user message.
   * Returns matches sorted by promptOrder.
   */
  resolve(message: string): ModuleResolution[] {
    const results: ModuleResolution[] = [];
    for (const mod of this.modules.values()) {
      const match = mod.keywordPattern.exec(message);
      if (match) {
        results.push({ module: mod, matchedKeyword: match[0] });
      }
    }
    results.sort(
      (a, b) => (a.module.manifest.promptOrder ?? 50) - (b.module.manifest.promptOrder ?? 50)
    );
    return results;
  }

  /**
   * Collect all modules' prompt fields (or auto-generate from description + files),
   * interpolate {name}, sort by promptOrder.
   */
  getPromptFragments(vars: { name: string }): string[] {
    const sorted = [...this.modules.values()].sort(
      (a, b) => (a.manifest.promptOrder ?? 50) - (b.manifest.promptOrder ?? 50)
    );

    return sorted.map((mod) => {
      let text = mod.manifest.prompt;
      if (!text) {
        // Auto-generate from description + files + endpoints
        const parts = [`## ${mod.manifest.name}`, mod.manifest.description];
        if (mod.manifest.files?.length) {
          const filePaths = mod.manifest.files
            .map((f) => `brain/${mod.manifest.name}/${f.path}`)
            .join(", ");
          parts.push(`Data: ${filePaths}.`);
        }
        if (mod.manifest.endpoints?.length) {
          const eps = mod.manifest.endpoints
            .map((e) => `${e.method} ${e.path}`)
            .join(", ");
          parts.push(`Endpoints: ${eps}.`);
        }
        text = parts.join("\n");
      }

      // Interpolate {name}
      return text.replace(/\{name\}/g, vars.name);
    });
  }

  list(): BrainModule[] {
    return [...this.modules.values()];
  }

  get(name: string): BrainModule | null {
    return this.modules.get(name) ?? null;
  }

  get size(): number {
    return this.modules.size;
  }
}

// --- Singleton ---

let _registry: ModuleRegistry | null = null;

export function createModuleRegistry(brainDir: string): ModuleRegistry {
  if (_registry) return _registry;
  _registry = new ModuleRegistry(brainDir);
  _registry.init();
  return _registry;
}

export function getModuleRegistry(): ModuleRegistry | null {
  return _registry;
}
