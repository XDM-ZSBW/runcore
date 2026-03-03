/**
 * Perplexity Sonar API client.
 * Uses the chat completions endpoint with model "sonar" for web search.
 * Safe: never throws, returns null on any error.
 */

import type { SearchResult } from "./client.js";

const PERPLEXITY_URL = "https://api.perplexity.ai/chat/completions";

/**
 * Search the web via Perplexity Sonar.
 * Requires PERPLEXITY_API_KEY in process.env (hydrated by vault).
 * 15-second timeout. Returns null on any failure.
 */
export async function perplexitySearch(query: string): Promise<SearchResult | null> {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) return null;

  try {
    const res = await fetch(PERPLEXITY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "sonar",
        messages: [{ role: "user", content: query }],
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) return null;

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;

    return { results: content, query };
  } catch {
    return null;
  }
}
