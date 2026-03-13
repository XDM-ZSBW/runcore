/**
 * SensitiveRegistry — loads sensitive terms from brain/knowledge/sensitive.yaml
 * plus built-in pattern rules (SSN, cards, API keys, etc.).
 *
 * Terms are sorted longest-first so longer matches take priority.
 * Hand-rolled YAML parse — no external dependency.
 */

import { readFile, appendFile, mkdir } from "node:fs/promises";
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
  // ── PII ──
  { pattern: /\b\d{3}[-\s]\d{2}[-\s]\d{4}\b/g, category: "SSN" },
  { pattern: /\b(?:\d[ -]*?){13,19}\b/g, category: "CARD" },
  { pattern: /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g, category: "PHONE" },
  { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, category: "EMAIL" },
  { pattern: /\b\d{1,5}\s+(?:[NSEW]\.?\s+)?(?:[A-Z][a-z]+\.?\s+){1,3}(?:St(?:reet)?|Ave(?:nue)?|Blvd|Boulevard|Dr(?:ive)?|Ln|Lane|Rd|Road|Ct|Court|Cir(?:cle)?|Way|Pl(?:ace)?|Pkwy|Parkway|Terr?(?:ace)?|Hwy|Highway|Pike|Trail|Tr|Run|Loop|Pass|Crossing|Xing)\.?\b(?:\s*,?\s*(?:Apt|Suite|Ste|Unit|#|Bldg)\s*\.?\s*[A-Za-z0-9-]+)?/g, category: "ADDRESS" },
  { pattern: /\bP\.?\s*O\.?\s*Box\s+\d+/gi, category: "ADDRESS" },
  { pattern: /\b\d{5}(?:-\d{4})?\b/g, category: "ZIP_CODE" },
  { pattern: /\b(?:0[1-9]|1[0-2])[\/\-](?:0[1-9]|[12]\d|3[01])[\/\-](?:19|20)\d{2}\b/g, category: "DOB" },
  { pattern: /\b(?:19|20)\d{2}[\/\-](?:0[1-9]|1[0-2])[\/\-](?:0[1-9]|[12]\d|3[01])\b/g, category: "DOB" },
  { pattern: /\b[A-Z]\d{7,8}\b/g, category: "PASSPORT" },
  { pattern: /\b[A-Z]{1,2}\d{4,8}\b/g, category: "DRIVERS_LICENSE" },
  { pattern: /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g, category: "CARD" },
  { pattern: /\b\d{9}\b/g, category: "ROUTING_NUMBER" },
  { pattern: /\b\d{3,4}[-\s]?\d{6,7}[-\s]?\d{1}\b/g, category: "ACCOUNT_NUMBER" },

  // ── PHI (HIPAA) ──
  { pattern: /\b(?:MRN|Medical Record|Patient ID|Member ID)[#:\s]*[A-Z0-9-]{4,}\b/gi, category: "MEDICAL_ID" },
  { pattern: /\b(?:NPI)[#:\s]*\d{10}\b/gi, category: "NPI" },
  { pattern: /\b(?:DEA)[#:\s]*[A-Z]{2}\d{7}\b/gi, category: "DEA_NUMBER" },
  { pattern: /\b(?:Medicare|Medicaid)[#:\s]*[A-Z0-9-]{6,}\b/gi, category: "MEDICARE_MEDICAID" },
  { pattern: /\b(?:Policy|Group|Subscriber|Insurance)\s*(?:Number|ID|#)[#:\s]*[A-Z0-9-]{4,}\b/gi, category: "INSURANCE_ID" },
  { pattern: /\b(?:Rx|prescription)\s*(?:#|number|no)[:\s]*\d{4,}\b/gi, category: "PRESCRIPTION_ID" },
  { pattern: /\b(?:ICD[-\s]?10|CPT|HCPCS)[:\s]*[A-Z0-9.]{3,7}\b/gi, category: "MEDICAL_CODE" },

  // ── Credentials / secrets ──
  { pattern: /\b(?:sk|pk|api|key|token)[_-][A-Za-z0-9_-]{20,}\b/g, category: "API_KEY" },
  { pattern: /\bBearer\s+[A-Za-z0-9_.-]{20,}\b/g, category: "BEARER_TOKEN" },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, category: "AWS_KEY" },
  { pattern: /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(RSA\s+)?PRIVATE\s+KEY-----/g, category: "PRIVATE_KEY" },
  { pattern: /\b[A-Fa-f0-9]{40,}\b/g, category: "HEX_SECRET" },
  { pattern: /\bghp_[A-Za-z0-9]{36,}\b/g, category: "GITHUB_TOKEN" },
  { pattern: /\bxox[bpras]-[A-Za-z0-9-]{10,}\b/g, category: "SLACK_TOKEN" },
];

export class SensitiveRegistry {
  private terms: SensitiveTerm[] = [];
  private customPatterns: SensitivePattern[] = [];
  private loaded = false;
  private brainRoot: string | null = null;

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
    this.brainRoot = brainRoot;
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

  /**
   * Add a term at runtime (user-flagged). Immediately active + persisted to YAML.
   * Returns true if the term was new, false if it already existed.
   */
  async addTerm(value: string, category: string): Promise<boolean> {
    const cat = category.toUpperCase();
    const trimmed = value.trim();
    if (trimmed.length < 2) return false;

    // Skip if already known
    if (this.terms.some((t) => t.value === trimmed && t.category === cat)) {
      return false;
    }

    // Add to in-memory list, re-sort longest-first
    this.terms.push({ value: trimmed, category: cat });
    this.terms.sort((a, b) => b.value.length - a.value.length);

    // Persist to sensitive.yaml (append)
    if (this.brainRoot) {
      const dir = join(this.brainRoot, "knowledge");
      const filePath = join(dir, "sensitive.yaml");
      try {
        await mkdir(dir, { recursive: true });
        const escaped = trimmed.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const entry = `\n- value: "${escaped}"\n  category: ${cat}\n`;
        await appendFile(filePath, entry, "utf-8");
        log.info("Flagged sensitive term persisted", { category: cat });
      } catch (err: any) {
        log.warn("Failed to persist flagged term", { error: err.message });
      }
    }

    log.info("Sensitive term added at runtime", { category: cat, length: trimmed.length });
    return true;
  }
}
