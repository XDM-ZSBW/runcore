/**
 * Brain document finder — auto-detects document references in user messages
 * and resolves them to actual brain files.
 *
 * Three search modes (in priority order):
 * 1. RAG semantic search — fast, uses pre-computed embeddings
 * 2. Filename/path match — keyword scoring on filenames and directories
 * 3. Keyword content scan — REMOVED (replaced by RAG)
 *
 * Returns best matching file + sibling listing (option B from spec).
 */

import { readdir } from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import { readBrainFile } from "../lib/brain-io.js";
import { createLogger } from "../utils/logger.js";
import type { BrainRAG } from "./brain-rag.js";

const log = createLogger("brain-docs");

// ── Module-level RAG reference (set during server init) ──────────────────────

let _rag: BrainRAG | null = null;

/** Wire the BrainRAG instance. Called once during server startup. */
export function setBrainRAG(rag: BrainRAG): void {
  _rag = rag;
}

// ── Patterns ─────────────────────────────────────────────────────────────────

/** Explicit document reference — "read my paper", "show the draft", etc. */
const DOC_REF_PATTERN =
  /\b(read|show|open|pull up|find|get|load|look at|check)\b.*\b(paper|draft|doc|document|note|post|thread|whitepaper|positioning|writeup|write-?up|article|research|report|book|chapter|spec)\b/i;

/** Question about brain knowledge — "which book", "what does X say", "where is the" */
const KNOWLEDGE_QUESTION_PATTERN =
  /\b(which|what|where|how|did|does|do|have|is|are|tell me|remind me)\b.*\b(book|chapter|spec|paper|draft|note|plan|goal|roadmap|decision|protocol|template|principle|identity|series|write|wrote|writing|document|research|finance|govern)\b/i;

// ── Types ────────────────────────────────────────────────────────────────────

export interface DocMatch {
  path: string;
  filename: string;
  content: string;
  /** Other files in the same directory */
  siblings?: string[];
}

// ── Keyword extraction ───────────────────────────────────────────────────────

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
    if (/^\d+$/.test(t)) {
      keywords.push(t);
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

// ── Main search ──────────────────────────────────────────────────────────────

/**
 * Search brain files for the best match to the user's message.
 *
 * Priority:
 * 1. RAG semantic search (if available and indexed)
 * 2. Keyword filename match (fallback)
 */
export async function findBrainDocument(message: string): Promise<DocMatch | null> {
  const keywords = extractKeywords(message);
  const docMatch = DOC_REF_PATTERN.test(message);
  const knowledgeMatch = KNOWLEDGE_QUESTION_PATTERN.test(message);
  log.info(`findBrainDocument: keywords=[${keywords.join(",")}] docRef=${docMatch} knowledgeQ=${knowledgeMatch}`);

  if (!docMatch && !knowledgeMatch) {
    log.info("No pattern matched — skipping brain doc search");
    return null;
  }

  // ── Mode 1: RAG semantic search ──────────────────────────────────────────
  if (_rag && _rag.ready) {
    try {
      log.info("Trying RAG semantic search...");
      const results = await _rag.query(message, 5);
      if (results.length > 0) {
        const best = results[0];
        log.info(`RAG hit: ${best.filePath} (score: ${best.score.toFixed(3)})${best.siblings ? `, ${best.siblings.length} siblings` : ""}`);

        const content = await readBrainFile(best.fullPath);
        const filename = basename(best.filePath);

        // Build sibling listing
        let siblings: string[] | undefined;
        if (best.siblings && best.siblings.length > 0) {
          siblings = best.siblings;
        }

        return { path: best.fullPath, filename, content, siblings };
      }
      log.info("RAG returned no results above threshold");
    } catch (err) {
      log.error("RAG search failed, falling back to keyword match", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } else {
    log.info("RAG not available, using keyword fallback");
  }

  // ── Mode 2: Keyword filename match (fallback) ───────────────────────────
  if (keywords.length === 0) return null;
  return keywordFilenameSearch(keywords);
}

// ── Keyword filename fallback ────────────────────────────────────────────────

import { stat as fsStat } from "node:fs/promises";
import { FILES_DIR, resolveBrainDir } from "../lib/paths.js";

const DOC_DIRS = [
  FILES_DIR,
  resolveBrainDir("content"),
  resolveBrainDir("knowledge"),
  resolveBrainDir("identity"),
  resolveBrainDir("operations"),
  resolveBrainDir("skills"),
  resolveBrainDir("templates"),
];

const SEARCHABLE_EXTS = new Set([".md", ".yaml", ".yml", ".txt", ".json"]);
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".obsidian", "logs", "tasks",
  "daily", "hourly", "memory", "ops", "metrics", "ledger",
]);

function scoreFilename(filename: string, keywords: string[]): number {
  const parts = basename(filename, ".md")
    .toLowerCase()
    .split(/[-_.]/)
    .filter((p) => p.length > 0);

  let score = 0;
  for (const kw of keywords) {
    for (const part of parts) {
      if (part.includes(kw) || kw.includes(part)) score++;
    }
  }
  return score;
}

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

async function keywordFilenameSearch(keywords: string[]): Promise<DocMatch | null> {
  const candidates: { path: string; filename: string; score: number }[] = [];

  const seen = new Set<string>();
  for (const dir of DOC_DIRS) {
    if (seen.has(dir)) continue;
    seen.add(dir);

    const files = await collectFiles(dir);
    for (const file of files) {
      const parentDir = basename(dirname(file.path));
      const score = scoreFilename(file.filename, keywords) + scoreFilename(parentDir, keywords);
      if (score > 0) {
        candidates.push({ ...file, score });
      }
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score);

  log.info(`Keyword fallback: ${candidates.length} candidates, best: ${candidates[0].filename} (score: ${candidates[0].score})`);

  if (candidates[0].score < 2) return null;

  try {
    const best = candidates[0];
    const content = await readBrainFile(best.path);

    // Sibling listing
    const dir = dirname(best.path);
    let siblings: string[] | undefined;
    try {
      const entries = await readdir(dir);
      const sibs = entries.filter((e) => e !== best.filename);
      if (sibs.length > 0) siblings = sibs;
    } catch { /* ignore */ }

    return { path: best.path, filename: best.filename, content, siblings };
  } catch {
    return null;
  }
}
