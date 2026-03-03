/**
 * Search-need classifier for Core.
 * Determines whether a user message needs a web search and extracts the query.
 *
 * Three-tier approach:
 * 1. Regex fast-path — explicit commands like "search for ...", "google ..."
 * 2. Heuristic skip — short messages, greetings, obvious non-search patterns
 * 3. LLM classifier — cheap model decides if web info would help
 *
 * Never throws — defaults to { needsSearch: false } on any error.
 */

import type { ProviderName } from "../llm/providers/types.js";
import { completeChat } from "../llm/complete.js";

export interface ClassifyResult {
  needsSearch: boolean;
  query: string;
  trigger: "explicit" | "auto" | "none";
}

// --- Tier 1: Regex fast-path (explicit commands) ---

const EXPLICIT_PATTERNS = [
  /^search\s+(?:for\s+)?(.+)/i,
  /^google\s+(.+)/i,
  /^look\s*up\s+(.+)/i,
  /^find\s+(?:info|information)\s+(?:on|about)\s+(.+)/i,
  /^what(?:'s| is)\s+the\s+latest\s+(.+)/i,
];

function matchExplicit(message: string): string | null {
  for (const pattern of EXPLICIT_PATTERNS) {
    const match = message.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

// --- Tier 2: Heuristic skip ---

const SKIP_PATTERNS = [
  /^(hi|hey|hello|yo|sup|thanks|thank you|ok|okay|sure|yes|no|bye|goodbye|good morning|good night)\b/i,
  /^(how are you|what's up|how's it going)\??$/i,
  /^learn\s+/i, // "learn <path>" is a file command, not a search
  /https?:\/\/\S+/, // URLs are handled by browse module, not search
  // Retry/re-examine cues — user wants the agent to look at conversation/context, not the web
  /^(again|look again|try again|check again|re-?read|re-?check|look back|look harder)\b/i,
];

function shouldSkip(message: string): boolean {
  if (message.length < 10) return true;
  return SKIP_PATTERNS.some((p) => p.test(message));
}

// --- Tier 3: LLM classifier ---

const CLASSIFY_PROMPT = `You are a classifier. Given a user message, decide if it requires a web search to answer well.

Answer YES if the message asks about:
- Current events, news, recent happenings
- Latest versions, releases, or updates of software/products
- Sports scores, election results, or other time-sensitive facts
- Prices, stock values, or market data
- People, companies, or organizations (current info)
- Weather or real-time conditions
- "Who won", "what happened", "when is" style questions about recent events

Answer NO if the message is:
- Personal conversation, greetings, emotional support
- Requests about the user's own files, projects, or data
- Questions the AI can answer from general knowledge (math, definitions, basic facts)
- Creative writing, brainstorming, or opinion requests
- Instructions or commands for the AI itself
- Retry or re-examine cues like "again", "look again", "try again", "check again" — these mean the user wants you to re-read conversation context or local files, NOT search the web

Respond with ONLY a JSON object: {"needsSearch": true, "query": "search query"} or {"needsSearch": false}
No markdown fences. No explanation.`;

async function classifyWithLlm(
  message: string,
  provider: ProviderName,
  model?: string,
): Promise<ClassifyResult> {
  const raw = await completeChat({
    messages: [
      { role: "system", content: CLASSIFY_PROMPT },
      { role: "user", content: message },
    ],
    provider,
    model,
  });

  // Parse response
  let cleaned = raw.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");

  const parsed = JSON.parse(cleaned);
  if (parsed.needsSearch && typeof parsed.query === "string") {
    return { needsSearch: true, query: parsed.query, trigger: "auto" };
  }
  return { needsSearch: false, query: "", trigger: "none" };
}

// --- Query enhancement ---

const TIME_SENSITIVE_PATTERNS = [
  /\b(latest|recent|current|last|new|newest|this year|today|now|20\d{2})\b/i,
  /\b(who won|who is|what happened|score|results|winner)\b/i,
  /\b(super bowl|world cup|election|oscars|grammy|championship)\b/i,
  /\b(version|release|update|price|stock)\b/i,
];

/**
 * Append the current year to queries that seem time-sensitive,
 * so DuckDuckGo returns fresher results.
 */
function enhanceQuery(query: string): string {
  const year = new Date().getFullYear();
  const yearStr = String(year);
  // Don't add if query already contains a recent year
  if (/20\d{2}/.test(query)) return query;
  const isTimeSensitive = TIME_SENSITIVE_PATTERNS.some((p) => p.test(query));
  if (isTimeSensitive) return `${query} ${yearStr}`;
  return query;
}

// --- Public API ---

/**
 * Classify whether a user message needs a web search.
 * Never throws — returns { needsSearch: false } on any error.
 */
export async function classifySearchNeed(
  message: string,
  provider: ProviderName,
  model?: string,
): Promise<ClassifyResult> {
  try {
    // Tier 1: explicit command
    const explicit = matchExplicit(message);
    if (explicit) {
      return { needsSearch: true, query: enhanceQuery(explicit), trigger: "explicit" };
    }

    // Tier 2: heuristic skip
    if (shouldSkip(message)) {
      return { needsSearch: false, query: "", trigger: "none" };
    }

    // Tier 3: LLM classifier
    const result = await classifyWithLlm(message, provider, model);
    if (result.needsSearch) {
      result.query = enhanceQuery(result.query);
    }
    return result;
  } catch {
    return { needsSearch: false, query: "", trigger: "none" };
  }
}
