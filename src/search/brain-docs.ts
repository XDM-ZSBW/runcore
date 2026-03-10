/**
 * Brain document finder — auto-detects document references in user messages
 * and resolves them to actual brain files.
 *
 * Two search modes:
 * 1. Filename match — triggered by explicit references ("read my paper", "show the draft")
 * 2. Content search — triggered by questions about brain knowledge ("which book", "what does X say")
 *
 * Scans brain/files/ (v2) or legacy brain/knowledge/, brain/content/, etc.
 */

import { readdir, stat as fsStat } from "node:fs/promises";
import { join, basename, relative } from "node:path";
import { readBrainFile } from "../lib/brain-io.js";

import { BRAIN_DIR, FILES_DIR, resolveBrainDir } from "../lib/paths.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("brain-docs");

/**
 * Directories to scan for documents.
 * v2 brain: everything is under brain/files/. Legacy: scattered across subdirs.
 */
const DOC_DIRS = [
  FILES_DIR,
  resolveBrainDir("content"),
  resolveBrainDir("knowledge"),
  resolveBrainDir("identity"),
  resolveBrainDir("operations"),
  resolveBrainDir("skills"),
  resolveBrainDir("templates"),
];

/** Explicit document reference — "read my paper", "show the draft", etc. */
const DOC_REF_PATTERN =
  /\b(read|show|open|pull up|find|get|load|look at|check)\b.*\b(paper|draft|doc|document|note|post|thread|whitepaper|positioning|writeup|write-?up|article|research|report|book|chapter|spec)\b/i;

/** Question about brain knowledge — "which book", "what does X say", "where is the" */
const KNOWLEDGE_QUESTION_PATTERN =
  /\b(which|what|where|how|did|does|do|have|is|are|tell me|remind me)\b.*\b(book|chapter|spec|paper|draft|note|plan|goal|roadmap|decision|protocol|template|principle|identity|series|write|wrote|writing|document|research)\b/i;

interface DocMatch {
  path: string;
  filename: string;
  content: string;
}

/**
 * Tokenize a user message into searchable keywords.
 * Strips common verbs/articles, returns lowercase stems.
 */
function extractKeywords(message: string): string[] {
  const stopWords = new Set([
    "the", "a", "an", "my", "our", "that", "this", "it", "its",
    "read", "show", "open", "pull", "up", "find", "get", "load",
    "look", "at", "check", "can", "you", "me", "for", "about",
    "please", "and", "or", "in", "on", "to", "of", "with",
    "which", "what", "where", "how", "did", "does", "have",
    "is", "are", "tell", "remind", "we", "were", "was", "been",
    "do", "not", "but", "from", "who", "they",
  ]);
  const tokens = message
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  const keywords: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    // Keep numbers (even single digits) — "book 2" needs the "2"
    if (/^\d+$/.test(t)) {
      keywords.push(t);
      // Fuse with previous token: "book" + "2" → "book2"
      if (i > 0 && keywords.length >= 2) {
        const prev = keywords[keywords.length - 2];
        if (!/^\d+$/.test(prev)) {
          keywords.push(prev + t);
        }
      }
    } else if (t.length > 2 && !stopWords.has(t)) {
      keywords.push(t);
    }
  }
  return keywords;
}

/**
 * Score how well a filename matches a set of keywords.
 */
function scoreFilename(filename: string, keywords: string[]): number {
  const parts = basename(filename, ".md")
    .toLowerCase()
    .split(/[-_.]/)
    .filter((p) => p.length > 2);

  let score = 0;
  for (const kw of keywords) {
    for (const part of parts) {
      if (part.includes(kw) || kw.includes(part)) score++;
    }
  }
  return score;
}

/** Readable file extensions for content search. */
const SEARCHABLE_EXTS = new Set([".md", ".yaml", ".yml", ".txt", ".json"]);

/** Directories to skip during recursive scan. */
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".obsidian", "logs", "tasks",
  "daily", "hourly", "memory", "ops", "metrics", "ledger",
]);

/**
 * Recursively collect all searchable files from a directory.
 */
async function collectFiles(dir: string): Promise<{ path: string; filename: string }[]> {
  const results: { path: string; filename: string }[] = [];

  async function walk(d: string): Promise<void> {
    let entries: string[];
    try { entries = await readdir(d); } catch { return; }
    for (const name of entries) {
      if (name.startsWith(".") && name !== ".config") continue;
      if (SKIP_DIRS.has(name)) continue;
      const full = join(d, name);
      try {
        const s = await fsStat(full);
        if (s.isDirectory()) {
          await walk(full);
        } else {
          const ext = name.substring(name.lastIndexOf(".")).toLowerCase();
          if (SEARCHABLE_EXTS.has(ext) && s.size < 500_000) {
            results.push({ path: full, filename: name });
          }
        }
      } catch { continue; }
    }
  }

  await walk(dir);
  return results;
}

/**
 * Search brain files by content — find files containing the query keywords.
 * Returns the best match with content loaded.
 */
async function searchByContent(keywords: string[]): Promise<DocMatch | null> {
  if (keywords.length === 0) return null;

  interface Hit { path: string; filename: string; score: number }
  const hits: Hit[] = [];

  // Deduplicate dirs
  const seen = new Set<string>();
  for (const dir of DOC_DIRS) {
    if (seen.has(dir)) continue;
    seen.add(dir);

    const files = await collectFiles(dir);
    for (const file of files) {
      try {
        const content = await readBrainFile(file.path);
        const lower = content.toLowerCase();
        const relPath = file.path.toLowerCase();
        let score = 0;
        let distinctHits = 0;
        for (const term of keywords) {
          // Exact match
          if (lower.includes(term)) {
            distinctHits++;
            score += 1;
            if (file.filename.toLowerCase().includes(term)) score += 1;
            if (relPath.includes(term)) score += 1;
            if (lower.substring(0, 500).includes(term)) score += 0.5;
          } else if (term.length >= 5) {
            // Stem match — check if the first 5+ chars appear (catches finances→financial, etc.)
            const stem = term.substring(0, Math.min(term.length - 1, 6));
            if (lower.includes(stem)) {
              distinctHits++;
              score += 0.5;
              if (file.filename.toLowerCase().includes(stem)) score += 0.5;
            }
          }
        }
        // Bonus for matching more distinct keywords — a file matching 3/3 terms
        // beats a file matching 1/3 very strongly
        if (distinctHits > 1) {
          score *= (1 + distinctHits * 0.5);
        }
        if (score > 0) {
          hits.push({ path: file.path, filename: file.filename, score });
        }
      } catch { continue; }
    }
  }

  log.info(`Content search: scanned files, found ${hits.length} hits`);
  if (hits.length === 0) return null;

  hits.sort((a, b) => b.score - a.score);
  const best = hits[0];
  log.info(`Best hit: ${best.filename} (score: ${best.score})`);

  // Require at least 2 keyword hits for content search
  if (best.score < 2) return null;

  try {
    const content = await readBrainFile(best.path);
    return { path: best.path, filename: best.filename, content };
  } catch {
    return null;
  }
}

/**
 * Search brain document directories for files matching the user's message.
 * Returns the best match (if any) with its content loaded.
 *
 * Strategy:
 * 1. If message explicitly references a document → filename match
 * 2. If message asks a question about brain knowledge → content search
 * 3. Otherwise → null (no injection)
 */
export async function findBrainDocument(message: string): Promise<DocMatch | null> {
  const keywords = extractKeywords(message);
  const docMatch = DOC_REF_PATTERN.test(message);
  const knowledgeMatch = KNOWLEDGE_QUESTION_PATTERN.test(message);
  log.info(`findBrainDocument: keywords=[${keywords.join(",")}] docRef=${docMatch} knowledgeQ=${knowledgeMatch}`);
  if (keywords.length === 0) return null;

  // Mode 1: Explicit document reference — try filename match first
  if (docMatch) {
    const candidates: { path: string; filename: string; score: number }[] = [];

    const seen = new Set<string>();
    for (const dir of DOC_DIRS) {
      if (seen.has(dir)) continue;
      seen.add(dir);

      const files = await collectFiles(dir);
      for (const file of files) {
        // Score against filename + parent directory (catches book2-drafts/ch1.md)
        const parentDir = basename(join(file.path, ".."));
        const score = scoreFilename(file.filename, keywords) + scoreFilename(parentDir, keywords);
        if (score > 0) {
          candidates.push({ ...file, score });
        }
      }
    }

    log.info(`Filename match: ${candidates.length} candidates, top 5: ${candidates.sort((a, b) => b.score - a.score).slice(0, 5).map(c => `${c.filename}@${basename(join(c.path, ".."))}=${c.score}`).join(", ")}`);
    if (candidates.length > 0) {
      if (candidates[0].score >= 2) {
        try {
          const content = await readBrainFile(candidates[0].path);
          return { path: candidates[0].path, filename: candidates[0].filename, content };
        } catch {}
      }
    }

    // Filename match failed — fall through to content search
  }

  // Mode 2: Knowledge question — search file content
  if (docMatch || knowledgeMatch) {
    log.info("Searching brain files by content...");
    const result = await searchByContent(keywords);
    log.info(`Content search result: ${result ? result.filename : "null"}`);
    return result;
  }

  log.info("No pattern matched — skipping brain doc search");

  return null;
}
