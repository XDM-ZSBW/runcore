/**
 * NLP entity detection — catches unstructured sensitive data that regex misses.
 * Uses compromise.js (pure JS, ~200KB, MIT, no external models).
 *
 * Detects: places (addresses), people (names), organizations.
 * Runs locally, synchronously, ~1ms per message.
 */

import nlp from "compromise";

export interface DetectedEntity {
  value: string;
  category: string;
}

/**
 * Extract sensitive entities from text using NLP.
 * Returns entities sorted longest-first (same convention as SensitiveRegistry terms).
 */
export function detectEntities(text: string): DetectedEntity[] {
  const entities: DetectedEntity[] = [];
  const seen = new Set<string>();

  const doc = nlp(text);

  // Places — addresses, cities, locations
  for (const place of doc.places().out("array") as string[]) {
    const trimmed = place.trim();
    if (trimmed.length < 3 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    entities.push({ value: trimmed, category: "ADDRESS" });
  }

  // People — person names
  for (const person of doc.people().out("array") as string[]) {
    const trimmed = person.trim();
    if (trimmed.length < 3 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    entities.push({ value: trimmed, category: "PERSON" });
  }

  // Organizations
  for (const org of doc.organizations().out("array") as string[]) {
    const trimmed = org.trim();
    if (trimmed.length < 3 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    entities.push({ value: trimmed, category: "ORG" });
  }

  // Longest-first so longer matches take priority
  entities.sort((a, b) => b.value.length - a.value.length);

  return entities;
}
