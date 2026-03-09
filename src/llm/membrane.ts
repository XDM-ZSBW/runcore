/**
 * PrivacyMembrane — reversible typed-placeholder redaction.
 *
 * Outbound: replaces sensitive spans with `<<CATEGORY_N>>` placeholders.
 * Inbound: restores placeholders to original values.
 *
 * Same value always maps to the same placeholder across turns.
 * Audit log tracks categories + counts (never raw values).
 */

import type { SensitiveRegistry } from "./sensitive-registry.js";
import { detectEntities } from "./nlp-detect.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("llm.membrane");

/** Matches our placeholder format: <<CATEGORY_N>> */
const PLACEHOLDER_RE = /<<([A-Z_]+_\d+)>>/g;

interface AuditEntry {
  timestamp: string;
  direction: "apply" | "rehydrate";
  categories: Record<string, number>;
}

export class PrivacyMembrane {
  /** original value → placeholder */
  private readonly forward = new Map<string, string>();
  /** placeholder → original value */
  private readonly reverse = new Map<string, string>();
  /** category → next index counter */
  private readonly counters = new Map<string, number>();
  /** audit log (categories + counts only, never values) */
  private readonly audit: AuditEntry[] = [];

  constructor(private readonly registry: SensitiveRegistry) {}

  /**
   * Replace sensitive content with typed placeholders.
   * Same value always gets the same placeholder.
   */
  apply(text: string): string {
    let result = text;
    const categoryCounts: Record<string, number> = {};

    // 1. Explicit terms (longest-first, from registry)
    for (const term of this.registry.sensitiveTerms) {
      if (!result.includes(term.value)) continue;
      const ph = this.getOrCreatePlaceholder(term.value, term.category);
      // Use split+join for literal replacement (no regex escaping needed)
      const before = result;
      result = result.split(term.value).join(ph);
      if (result !== before) {
        const count = (before.length - result.length + ph.length * ((before.length - result.length) / (term.value.length - ph.length) || 1));
        categoryCounts[term.category] = (categoryCounts[term.category] ?? 0) + 1;
      }
    }

    // 2. Pattern-based detection (built-in + custom from registry)
    for (const rule of this.registry.patterns) {
      rule.pattern.lastIndex = 0;
      const matches = result.match(rule.pattern);
      rule.pattern.lastIndex = 0;
      if (!matches) continue;

      for (const match of matches) {
        // Skip false positives for CARD rule
        if (rule.category === "CARD" && match.replace(/[\s-]/g, "").length < 13) continue;
        // Don't re-redact something already replaced with a placeholder
        if (match.startsWith("<<") && match.endsWith(">>")) continue;

        const ph = this.getOrCreatePlaceholder(match, rule.category);
        result = result.replace(match, ph);
        categoryCounts[rule.category] = (categoryCounts[rule.category] ?? 0) + 1;
      }
    }

    // 3. NLP entity detection (catches what regex missed — addresses, names, orgs)
    const nlpEntities = detectEntities(result);
    for (const entity of nlpEntities) {
      // Skip if already inside a placeholder or too short
      if (entity.value.length < 3) continue;
      if (!result.includes(entity.value)) continue;
      // Skip if this span is already redacted (inside a <<...>>)
      const idx = result.indexOf(entity.value);
      const before = result.slice(Math.max(0, idx - 2), idx);
      if (before.endsWith("<<")) continue;

      const ph = this.getOrCreatePlaceholder(entity.value, entity.category);
      result = result.split(entity.value).join(ph);
      categoryCounts[entity.category] = (categoryCounts[entity.category] ?? 0) + 1;
    }

    if (Object.keys(categoryCounts).length > 0) {
      this.audit.push({
        timestamp: new Date().toISOString(),
        direction: "apply",
        categories: categoryCounts,
      });
      log.info("Membrane applied", { categories: categoryCounts });
    }

    return result;
  }

  /**
   * Restore placeholders to original values.
   */
  rehydrate(text: string): string {
    const categoryCounts: Record<string, number> = {};
    let result = text;

    // Direct string replacement — no regex, no lastIndex issues
    for (const [placeholder, original] of this.reverse) {
      if (!result.includes(placeholder)) continue;
      const cat = placeholder.replace(/^<<|_\d+>>$/g, "");
      let count = 0;
      while (result.includes(placeholder)) {
        result = result.replace(placeholder, original);
        count++;
      }
      categoryCounts[cat] = (categoryCounts[cat] ?? 0) + count;
    }

    if (Object.keys(categoryCounts).length === 0 && text.includes("<<") && text.includes(">>")) {
      log.warn("Rehydrate found no mappings", {
        reverseMapSize: this.reverse.size,
        snippet: text.slice(0, 200),
        keys: [...this.reverse.keys()].slice(0, 10),
      });
    }

    if (Object.keys(categoryCounts).length > 0) {
      this.audit.push({
        timestamp: new Date().toISOString(),
        direction: "rehydrate",
        categories: categoryCounts,
      });
      log.debug("Membrane rehydrated", { categories: categoryCounts });
    }

    return result;
  }

  /** Get audit log (safe — no raw values). */
  getAuditLog(): readonly AuditEntry[] {
    return this.audit;
  }

  /** Number of unique sensitive values tracked. */
  get size(): number {
    return this.forward.size;
  }

  /**
   * Get existing placeholder or create a new one for a value+category pair.
   */
  private getOrCreatePlaceholder(value: string, category: string): string {
    const existing = this.forward.get(value);
    if (existing) return existing;

    const idx = this.counters.get(category) ?? 0;
    this.counters.set(category, idx + 1);

    const placeholder = `<<${category}_${idx}>>`;
    this.forward.set(value, placeholder);
    this.reverse.set(placeholder, value);
    return placeholder;
  }
}
