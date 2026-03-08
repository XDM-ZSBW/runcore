/**
 * Dictionary spec matcher — keyword-based selective injection.
 *
 * Instead of dumping all specs (~92K tokens) into every chat message,
 * matches user messages against spec keywords and injects only relevant ones.
 */

import type { DictionarySpec } from "./types.js";

export interface IndexedSpec {
  name: string;
  title: string;
  content: string;
  keywords: Set<string>;
  summary: string;
}

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "must", "to", "of",
  "in", "for", "on", "with", "at", "by", "from", "as", "into", "through",
  "during", "before", "after", "above", "below", "between", "out", "off",
  "over", "under", "again", "further", "then", "once", "here", "there",
  "when", "where", "why", "how", "all", "each", "every", "both", "few",
  "more", "most", "other", "some", "such", "no", "not", "only", "own",
  "same", "so", "than", "too", "very", "just", "but", "and", "or", "if",
  "that", "this", "what", "which", "who", "whom", "these", "those", "it",
  "its", "they", "them", "their", "we", "our", "you", "your", "he", "she",
  "him", "her", "his", "my", "me", "i",
]);

function extractKeywords(spec: DictionarySpec): Set<string> {
  const words = new Set<string>();
  for (const part of spec.name.replace(/-spec$/, "").split("-")) {
    if (part.length > 2) words.add(part.toLowerCase());
  }
  for (const w of tokenize(spec.title)) words.add(w);
  for (const w of tokenize(spec.content.slice(0, 500))) words.add(w);
  for (const sw of STOP_WORDS) words.delete(sw);
  return words;
}

function extractSummary(spec: DictionarySpec): string {
  const whatMatch = spec.content.match(/## What\s*\n+(.+?)(?:\n\n|\n##)/s);
  if (whatMatch) {
    const firstPara = whatMatch[1].trim().split("\n")[0];
    return firstPara.length > 120 ? firstPara.slice(0, 117) + "..." : firstPara;
  }
  const quoteMatch = spec.content.match(/^>\s*(.+)/m);
  if (quoteMatch) {
    const q = quoteMatch[1].trim();
    if (q.length > 10) return q.length > 120 ? q.slice(0, 117) + "..." : q;
  }
  for (const line of spec.content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && trimmed !== "---" && !trimmed.startsWith("#") && !trimmed.startsWith(">") && !trimmed.startsWith("|") && !trimmed.startsWith("```")) {
      return trimmed.length > 120 ? trimmed.slice(0, 117) + "..." : trimmed;
    }
  }
  return spec.title;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

export function indexSpecs(specs: DictionarySpec[]): IndexedSpec[] {
  return specs.map(spec => ({
    name: spec.name,
    title: spec.title,
    content: spec.content,
    keywords: extractKeywords(spec),
    summary: extractSummary(spec),
  }));
}

export function buildSpecIndex(indexed: IndexedSpec[]): string {
  const lines = [
    `Core dictionary (${indexed.length} specs — architecture reference, injected when relevant):`,
    indexed.map(s => `- ${s.name}: ${s.summary}`).join("\n"),
    `Relevant specs are auto-injected when your conversation touches their topics. Do not invent architectural details — if unsure, say you need to check the dictionary.`,
  ];
  return lines.join("\n");
}

export function matchSpecs(message: string, indexed: IndexedSpec[], maxResults = 2): IndexedSpec[] {
  const messageTokens = new Set(tokenize(message));
  if (messageTokens.size === 0) return [];

  const scored: Array<{ spec: IndexedSpec; score: number }> = [];

  for (const spec of indexed) {
    let score = 0;
    for (const token of messageTokens) {
      if (spec.keywords.has(token)) score++;
      if (spec.name.replace(/-spec$/, "").split("-").includes(token)) score += 2;
    }
    if (score > 0) scored.push({ spec, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxResults).map(s => s.spec);
}
