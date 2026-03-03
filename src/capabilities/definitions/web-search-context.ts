/**
 * Web search context provider — injects search results into the LLM prompt
 * when the user's message warrants a web search.
 *
 * Uses a factory pattern because the search classifier and search client
 * are wired up in server.ts (not importable as singletons).
 */

import { logActivity } from "../../activity/log.js";
import type { ContextProviderCapability, ContextInjection, ActionContext } from "../types.js";

export interface SearchClassification {
  needsSearch: boolean;
  trigger?: string;
  query: string;
}

export interface WebSearchDeps {
  isAvailable: () => boolean;
  classify: (message: string) => Promise<SearchClassification>;
  search: (query: string) => Promise<{ results: string } | null>;
}

export function createWebSearchContextProvider(deps: WebSearchDeps): ContextProviderCapability {
  // Cache classification result between shouldInject and getContext for the same message
  let cachedClassification: { message: string; result: SearchClassification } | null = null;

  return {
    id: "web-search-context",
    pattern: "context",
    keywords: ["search", "look up", "find", "what is", "who is", "how to", "news", "latest", "current"],

    getPromptInstructions(_ctx: ActionContext): string {
      return ""; // Context providers inject data, not prompt instructions
    },

    async shouldInject(message: string, ctx: ActionContext): Promise<boolean> {
      if (!deps.isAvailable()) return false;
      // Skip if a URL was detected or a brain doc was found (per-request hints)
      if (ctx.hints?.detectedUrl || ctx.hints?.brainDocFound) return false;

      const classification = await deps.classify(message);
      cachedClassification = { message, result: classification };
      return classification.needsSearch;
    },

    async getContext(message: string): Promise<ContextInjection | null> {
      // Use cached classification if available for this message
      const classification = cachedClassification?.message === message
        ? cachedClassification.result
        : await deps.classify(message);
      cachedClassification = null;

      if (!classification.needsSearch) return null;

      logActivity({
        source: "search",
        summary: `${classification.trigger}: "${classification.query}"`,
        actionLabel: "PROMPTED",
        reason: "user message triggered search",
      });

      const searchResult = await deps.search(classification.query);
      if (!searchResult) return null;

      const today = new Date().toISOString().slice(0, 10);
      return {
        label: `Web search: ${classification.query}`,
        content: [
          `--- Web search results for "${classification.query}" (searched ${today}) ---`,
          searchResult.results,
          `--- End search results ---`,
          `IMPORTANT: For this question, use ONLY the search results above. Do NOT supplement with your training data — it is likely outdated.`,
          `If the search results don't contain the answer, say clearly that you couldn't find it rather than guessing.`,
        ].join("\n"),
      };
    },
  };
}
