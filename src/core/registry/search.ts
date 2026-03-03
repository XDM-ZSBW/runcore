/**
 * Template & Skill Sharing Registry — Search and filtering.
 *
 * Provides text search, faceted filtering, and relevance scoring
 * for registry entries. Operates on the in-memory store.
 */

import type {
  RegistryEntry,
  RegistrySearchQuery,
  RegistrySearchResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Tokenize text into lowercase words for matching. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

/**
 * Score an entry against a free-text query.
 * Returns 0 if no match, higher for better matches.
 * Weights: name match > tag match > description match.
 */
function scoreEntry(entry: RegistryEntry, queryTokens: string[]): number {
  if (queryTokens.length === 0) return 1; // No query = match all

  let score = 0;
  const nameTokens = new Set(tokenize(entry.name));
  const descTokens = new Set(tokenize(entry.description));
  const tagTokens = new Set(entry.tags.flatMap((t) => tokenize(t)));

  for (const qt of queryTokens) {
    // Exact name match (highest weight)
    if (nameTokens.has(qt)) {
      score += 3;
    }
    // Partial name match
    else if ([...nameTokens].some((nt) => nt.includes(qt) || qt.includes(nt))) {
      score += 2;
    }

    // Tag match
    if (tagTokens.has(qt)) {
      score += 2;
    }

    // Description match
    if (descTokens.has(qt)) {
      score += 1;
    }
  }

  // Normalize by query length to get a 0–1 ish score
  return score / (queryTokens.length * 3);
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

/** Apply all filters from a search query to an entry list. */
function applyFilters(
  entries: RegistryEntry[],
  query: RegistrySearchQuery,
): RegistryEntry[] {
  return entries.filter((entry) => {
    // Status filter (default: published)
    const targetStatus = query.status ?? "published";
    if (entry.status !== targetStatus) return false;

    // Type filter
    if (query.type && entry.type !== query.type) return false;

    // Category filter
    if (query.category && entry.category !== query.category) return false;

    // Author filter
    if (query.author && entry.author !== query.author) return false;

    // Tags filter (all specified tags must be present)
    if (query.tags && query.tags.length > 0) {
      const entryTagSet = new Set(entry.tags.map((t) => t.toLowerCase()));
      for (const tag of query.tags) {
        if (!entryTagSet.has(tag.toLowerCase())) return false;
      }
    }

    return true;
  });
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

type ScoredEntry = { entry: RegistryEntry; relevance: number };

/** Sort scored entries by the requested field and direction. */
function sortEntries(
  scored: ScoredEntry[],
  sortBy: RegistrySearchQuery["sortBy"],
  sortOrder: RegistrySearchQuery["sortOrder"],
): ScoredEntry[] {
  const dir = sortOrder === "desc" ? -1 : 1;

  return scored.sort((a, b) => {
    switch (sortBy) {
      case "name":
        return dir * a.entry.name.localeCompare(b.entry.name);
      case "publishedAt":
        return dir * a.entry.publishedAt.localeCompare(b.entry.publishedAt);
      case "downloads":
        return dir * (a.entry.downloads - b.entry.downloads);
      case "relevance":
      default:
        // Relevance: higher is better, so reverse the default
        return -dir * (a.relevance - b.relevance);
    }
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Search the registry with filtering, scoring, sorting, and pagination.
 */
export function searchRegistry(
  allEntries: RegistryEntry[],
  query: RegistrySearchQuery,
): RegistrySearchResult {
  // 1. Apply hard filters
  const filtered = applyFilters(allEntries, query);

  // 2. Score against free-text query
  const queryTokens = query.query ? tokenize(query.query) : [];
  let scored: ScoredEntry[] = filtered.map((entry) => ({
    entry,
    relevance: scoreEntry(entry, queryTokens),
  }));

  // 3. If there's a query, filter out zero-relevance entries
  if (queryTokens.length > 0) {
    scored = scored.filter((s) => s.relevance > 0);
  }

  // 4. Sort
  const sortBy = query.sortBy ?? (queryTokens.length > 0 ? "relevance" : "publishedAt");
  const sortOrder = query.sortOrder ?? (sortBy === "publishedAt" ? "desc" : "asc");
  const sorted = sortEntries(scored, sortBy, sortOrder);

  // 5. Paginate
  const offset = query.offset ?? 0;
  const limit = query.limit ?? 20;
  const page = sorted.slice(offset, offset + limit);

  return {
    entries: page.map((s) => s.entry),
    total: sorted.length,
    query,
  };
}
