/**
 * Registry — Discovery and search.
 *
 * Provides search functionality over the registry store.
 * Uses the same Jaccard similarity approach as the skills registry
 * for intent-based matching, plus exact-name and tag matching.
 */

import type {
  RegistryEntry,
  SearchResult,
  SearchOptions,
} from "./types.js";

// ---------------------------------------------------------------------------
// Helpers (same tokenization pattern as skills/registry.ts)
// ---------------------------------------------------------------------------

/** Tokenize a string into lowercase words for matching. */
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

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Search the registry for packages matching the given options.
 *
 * Search strategy (in order):
 * 1. Exact name match → score 1.0
 * 2. Tag intersection → score based on overlap ratio
 * 3. Description similarity → Jaccard on tokenized description
 * 4. Kind filter → applied as a post-filter
 *
 * Results are sorted by score descending.
 */
export function search(
  entries: RegistryEntry[],
  options: SearchOptions,
): SearchResult[] {
  const results: SearchResult[] = [];
  const limit = options.limit ?? 20;
  const queryTokens = options.query ? tokenize(options.query) : new Set<string>();

  for (const entry of entries) {
    // Apply status filter
    if (options.status && entry.status !== options.status) continue;

    // Apply kind filter
    if (options.kind && entry.manifest.kind !== options.kind) continue;

    // Score the match
    const result = scoreEntry(entry, queryTokens, options.tags);
    if (result) {
      results.push(result);
    }
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);

  return results.slice(0, limit);
}

/** Score a single entry against the search criteria. */
function scoreEntry(
  entry: RegistryEntry,
  queryTokens: Set<string>,
  filterTags?: string[],
): SearchResult | null {
  const { manifest } = entry;

  // No query and no tags → return everything with a neutral score
  if (queryTokens.size === 0 && (!filterTags || filterTags.length === 0)) {
    return {
      entry,
      score: 0.5,
      matchReason: "kind-match",
    };
  }

  let bestScore = 0;
  let bestReason: SearchResult["matchReason"] = "description-match";

  // 1. Exact name match
  if (queryTokens.size > 0) {
    const queryStr = [...queryTokens].join(" ");
    const nameNormalized = manifest.name.replace(/-/g, " ");
    if (nameNormalized === queryStr || manifest.name === queryStr) {
      return {
        entry,
        score: 1.0,
        matchReason: "exact-name",
      };
    }
  }

  // 2. Tag match
  if (filterTags && filterTags.length > 0) {
    const entryTags = new Set(manifest.tags.map((t) => t.toLowerCase()));
    let tagMatches = 0;
    for (const tag of filterTags) {
      if (entryTags.has(tag.toLowerCase())) tagMatches++;
    }
    if (tagMatches > 0) {
      const tagScore = tagMatches / filterTags.length;
      if (tagScore > bestScore) {
        bestScore = tagScore;
        bestReason = "tag-match";
      }
    }
  }

  // Also check query tokens against tags
  if (queryTokens.size > 0 && manifest.tags.length > 0) {
    const tagTokens = new Set(manifest.tags.map((t) => t.toLowerCase()));
    let tagOverlap = 0;
    for (const token of queryTokens) {
      if (tagTokens.has(token)) tagOverlap++;
    }
    if (tagOverlap > 0) {
      const tagScore = 0.6 + 0.3 * (tagOverlap / queryTokens.size);
      if (tagScore > bestScore) {
        bestScore = tagScore;
        bestReason = "tag-match";
      }
    }
  }

  // 3. Description similarity
  if (queryTokens.size > 0) {
    const descTokens = tokenize(manifest.description);
    const descScore = jaccard(queryTokens, descTokens);
    if (descScore > bestScore) {
      bestScore = descScore;
      bestReason = "description-match";
    }

    // Also check name tokens for partial matching
    const nameTokens = tokenize(manifest.name.replace(/-/g, " "));
    const nameScore = jaccard(queryTokens, nameTokens);
    if (nameScore > 0 && nameScore * 0.9 > bestScore) {
      bestScore = nameScore * 0.9;
      bestReason = "exact-name";
    }
  }

  // Minimum threshold
  if (bestScore < 0.1) return null;

  return {
    entry,
    score: bestScore,
    matchReason: bestReason,
  };
}

/**
 * List all unique tags across all entries.
 * Useful for discovery / browsing.
 */
export function listTags(entries: RegistryEntry[]): string[] {
  const tags = new Set<string>();
  for (const entry of entries) {
    for (const tag of entry.manifest.tags) {
      tags.add(tag);
    }
  }
  return [...tags].sort();
}

/**
 * List all unique authors across all entries.
 */
export function listAuthors(entries: RegistryEntry[]): string[] {
  const authors = new Set<string>();
  for (const entry of entries) {
    authors.add(entry.manifest.author);
  }
  return [...authors].sort();
}
