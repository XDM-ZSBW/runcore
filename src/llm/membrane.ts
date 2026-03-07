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

    const result = text.replace(PLACEHOLDER_RE, (match) => {
      const original = this.reverse.get(match);
      if (original) {
        const cat = match.replace(/<<|_\d+>>/g, "");
        categoryCounts[cat] = (categoryCounts[cat] ?? 0) + 1;
        return original;
      }
      return match; // unknown placeholder — leave as-is
    });

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
