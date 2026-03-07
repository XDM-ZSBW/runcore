/**
 * SensitiveRegistry — loads sensitive terms from brain/knowledge/sensitive.yaml
 * plus built-in pattern rules (SSN, cards, API keys, etc.).
 *
 * Terms are sorted longest-first so longer matches take priority.
 * Hand-rolled YAML parse — no external dependency.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "../utils/logger.js";

const log = createLogger("llm.sensitive-registry");

export interface SensitiveTerm {
  value: string;
  category: string;
}

export interface SensitivePattern {
  pattern: RegExp;
  category: string;
}

/** Built-in patterns — carried over from redact.ts */
const BUILTIN_PATTERNS: SensitivePattern[] = [
  { pattern: /\b\d{3}[-\s]\d{2}[-\s]\d{4}\b/g, category: "SSN" },
  { pattern: /\b(?:\d[ -]*?){13,19}\b/g, category: "CARD" },
  { pattern: /\b(?:sk|pk|api|key|token)[_-][A-Za-z0-9_-]{20,}\b/g, category: "API_KEY" },
  { pattern: /\bBearer\s+[A-Za-z0-9_.-]{20,}\b/g, category: "BEARER_TOKEN" },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, category: "AWS_KEY" },
  { pattern: /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(RSA\s+)?PRIVATE\s+KEY-----/g, category: "PRIVATE_KEY" },
  { pattern: /\b[A-Fa-f0-9]{40,}\b/g, category: "HEX_SECRET" },
];

export class SensitiveRegistry {
  private terms: SensitiveTerm[] = [];
  private customPatterns: SensitivePattern[] = [];
  private loaded = false;

  /** All built-in + custom regex patterns. */
  get patterns(): SensitivePattern[] {
    return [...BUILTIN_PATTERNS, ...this.customPatterns];
  }

  /** All explicit terms, sorted longest-first. */
  get sensitiveTerms(): SensitiveTerm[] {
    return this.terms;
  }

  /** Load sensitive.yaml from brain/knowledge/. Graceful if missing. */
  async load(brainRoot: string): Promise<void> {
    const filePath = join(brainRoot, "knowledge", "sensitive.yaml");
    try {
      const raw = await readFile(filePath, "utf-8");
      this.parseYaml(raw);
      this.loaded = true;
      log.info("Loaded sensitive registry", {
        terms: this.terms.length,
        customPatterns: this.customPatterns.length,
      });
    } catch (err: any) {
      if (err.code === "ENOENT") {
        log.debug("No sensitive.yaml found — using built-in patterns only");
      } else {
        log.warn("Failed to parse sensitive.yaml — using built-in patterns only", { error: err.message });
      }
      this.loaded = true; // graceful degradation
    }
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * Hand-rolled YAML parser for our simple format.
   * Expects a list of entries with `value`, `category`, and optionally `pattern` fields.
   */
  private parseYaml(raw: string): void {
    const terms: SensitiveTerm[] = [];
    const customPatterns: SensitivePattern[] = [];

    // Split into entries by "- " at start of line (top-level list items)
    const entries = raw.split(/^(?=\s*- )/m).filter((s) => s.trim());

    for (const entry of entries) {
      const lines = entry.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

      let value: string | undefined;
      let category: string | undefined;
      let pattern: string | undefined;

      for (const line of lines) {
        // Strip leading "- " for the first field in a list item
        const cleaned = line.replace(/^-\s*/, "");
        const kvMatch = cleaned.match(/^(\w+)\s*:\s*(.+)$/);
        if (!kvMatch) continue;
        const [, key, val] = kvMatch;
        const unquoted = val.replace(/^["']|["']$/g, "").trim();
        if (key === "value") value = unquoted;
        else if (key === "category") category = unquoted;
        else if (key === "pattern") pattern = unquoted;
      }

      if (pattern && category) {
        try {
          customPatterns.push({ pattern: new RegExp(pattern, "g"), category: category.toUpperCase() });
        } catch {
          log.warn("Invalid regex in sensitive.yaml", { pattern, category });
        }
      } else if (value && category) {
        terms.push({ value, category: category.toUpperCase() });
      }
    }

    // Sort terms longest-first so longer matches take priority
    terms.sort((a, b) => b.value.length - a.value.length);

    this.terms = terms;
    this.customPatterns = customPatterns;
  }
}
