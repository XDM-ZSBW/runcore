/**
 * Search client — unified entry point for web search.
 * Prefers Perplexity Sonar API when PERPLEXITY_API_KEY is set,
 * falls back to DuckDuckGo via the Python sidecar.
 * All functions are safe — they return null on any failure.
 */

import { isSidecarAvailable } from "./sidecar.js";
// perplexity.js is byok-tier — dynamic import
let _perplexity: typeof import("./perplexity.js") | null = null;
import { resolveEnv } from "../instance.js";

const SIDECAR_URL = `http://127.0.0.1:${resolveEnv("SEARCH_PORT") ?? "3578"}`;

export interface SearchResult {
  results: string;
  query: string;
}

/**
 * Health probe — checks if the sidecar is running.
 * 2-second timeout, returns false on any failure.
 */
export async function checkSearchSidecar(): Promise<boolean> {
  try {
    const res = await fetch(`${SIDECAR_URL}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { status?: string };
    return data.status === "ok";
  } catch {
    return false;
  }
}

/**
 * Run a web search via the sidecar.
 * 15-second timeout, returns null on any failure.
 */
export async function webSearch(query: string): Promise<SearchResult | null> {
  try {
    const res = await fetch(`${SIDECAR_URL}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, max_results: 5 }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as SearchResult;
  } catch {
    return null;
  }
}

/**
 * Is any search backend available?
 * True if Perplexity API key is set OR the sidecar is running.
 */
export function isSearchAvailable(): boolean {
  return !!process.env.PERPLEXITY_API_KEY || isSidecarAvailable();
}

/**
 * Unified search entry point.
 * Tries Perplexity first (when key is set), falls back to sidecar.
 * Returns null if no backend is available or both fail.
 */
export async function search(query: string): Promise<SearchResult | null> {
  if (process.env.PERPLEXITY_API_KEY) {
    if (!_perplexity) { try { _perplexity = await import("./perplexity.js"); } catch {} }
    if (_perplexity) {
      const result = await _perplexity.perplexitySearch(query);
      if (result) return result;
    }
  }

  if (isSidecarAvailable()) {
    return webSearch(query);
  }

  return null;
}
