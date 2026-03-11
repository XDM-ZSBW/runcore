/**
 * Gemini Search — Google AI with Search grounding.
 *
 * Uses the Gemini API with the google_search tool to get grounded,
 * web-sourced answers. Fast, concise, cite-backed.
 *
 * Requires: GEMINI_API_KEY in vault/env.
 */

import { createLogger } from "../utils/logger.js";

const log = createLogger("search.gemini");

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_MODEL = "gemini-2.0-flash";

export interface GeminiSearchResult {
  ok: boolean;
  answer: string;
  sources: Array<{ title: string; url: string }>;
  message: string;
}

/**
 * Check if Gemini search is available (API key set).
 */
export function isGeminiAvailable(): boolean {
  return !!process.env.GEMINI_API_KEY;
}

/**
 * Search using Gemini with Google Search grounding.
 * Returns a grounded answer with source citations.
 */
export async function geminiSearch(query: string): Promise<GeminiSearchResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { ok: false, answer: "", sources: [], message: "GEMINI_API_KEY not set" };
  }

  const model = process.env.GEMINI_MODEL ?? DEFAULT_MODEL;
  const url = `${API_BASE}/${model}:generateContent?key=${apiKey}`;

  log.debug("Gemini search", { query, model });

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: query }],
          },
        ],
        tools: [{ google_search: {} }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 1024,
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log.error("Gemini API error", { status: res.status, body: body.slice(0, 200) });
      return { ok: false, answer: "", sources: [], message: `Gemini error (${res.status})` };
    }

    const data = await res.json() as any;

    // Extract answer text
    const candidate = data.candidates?.[0];
    if (!candidate?.content?.parts) {
      return { ok: false, answer: "", sources: [], message: "No response from Gemini" };
    }

    const answer = candidate.content.parts
      .filter((p: any) => p.text)
      .map((p: any) => p.text)
      .join("\n");

    // Extract grounding sources
    const sources: Array<{ title: string; url: string }> = [];
    const metadata = candidate.groundingMetadata;
    if (metadata?.groundingChunks) {
      for (const chunk of metadata.groundingChunks) {
        if (chunk.web?.uri) {
          sources.push({
            title: chunk.web.title ?? chunk.web.uri,
            url: chunk.web.uri,
          });
        }
      }
    }
    // Deduplicate sources by URL
    const seen = new Set<string>();
    const uniqueSources = sources.filter((s) => {
      if (seen.has(s.url)) return false;
      seen.add(s.url);
      return true;
    });

    log.info("Gemini search complete", { query, answerLength: answer.length, sourceCount: uniqueSources.length });

    return {
      ok: true,
      answer,
      sources: uniqueSources,
      message: "Search complete",
    };
  } catch (err: any) {
    if (err.name === "TimeoutError") {
      log.warn("Gemini search timeout", { query });
      return { ok: false, answer: "", sources: [], message: "Search timed out" };
    }
    log.error("Gemini search failed", { query, error: err.message });
    return { ok: false, answer: "", sources: [], message: `Search failed: ${err.message}` };
  }
}
