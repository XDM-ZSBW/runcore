/**
 * Brain document finder — auto-detects document references in user messages
 * and resolves them to actual brain files.
 *
 * Parallels how calendar/email/board keywords trigger context injection.
 * Scans brain/content/drafts, brain/knowledge/notes, brain/knowledge/research,
 * and brain/knowledge/protocols for matching filenames.
 */

import { readdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { readBrainFile } from "../lib/brain-io.js";
import { resolveEnv } from "../instance.js";

import { BRAIN_DIR, FILES_DIR, resolveBrainDir } from "../lib/paths.js";

/**
 * Directories to scan for documents the user might reference by description.
 * v2 brain: everything is under brain/files/. Legacy: scattered across subdirs.
 * We check both — resolveBrainDir handles fallback.
 */
const DOC_DIRS = [
  // v2 structure — flat files dir
  FILES_DIR,
  // Legacy paths (resolveBrainDir returns v2 or legacy, whichever exists)
  resolveBrainDir("content"),
  resolveBrainDir("knowledge"),
  resolveBrainDir("identity"),
  resolveBrainDir("operations"),
  resolveBrainDir("skills"),
  resolveBrainDir("templates"),
];

/** Does the message reference a document, paper, draft, note, or similar? */
const DOC_REF_PATTERN =
  /\b(read|show|open|pull up|find|get|load|look at|check)\b.*\b(paper|draft|doc|document|note|post|thread|whitepaper|positioning|writeup|write-?up|article|research|report)\b/i;

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
  ]);
  return message
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w));
}

/**
 * Score how well a filename matches a set of keywords.
 * Filename is split on hyphens/underscores/dots and compared to keywords.
 */
function scoreMatch(filename: string, keywords: string[]): number {
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

/**
 * Search brain document directories for files matching the user's message.
 * Returns the best match (if any) with its content loaded.
 */
export async function findBrainDocument(message: string): Promise<DocMatch | null> {
  // Only trigger on messages that reference a document
  if (!DOC_REF_PATTERN.test(message)) return null;

  const keywords = extractKeywords(message);
  if (keywords.length === 0) return null;

  // Scan all doc directories, collect candidates
  const candidates: { path: string; filename: string; score: number }[] = [];

  async function scanForDocs(dir: string): Promise<void> {
    let entries: string[];
    try { entries = await readdir(dir); } catch { return; }
    for (const entry of entries) {
      const full = join(dir, entry);
      try {
        const { statSync } = await import("node:fs");
        const s = statSync(full);
        if (s.isDirectory()) {
          await scanForDocs(full);
        } else if (entry.endsWith(".md") || entry.endsWith(".yaml") || entry.endsWith(".yml")) {
          const score = scoreMatch(entry, keywords);
          if (score > 0) {
            candidates.push({ path: full, filename: entry, score });
          }
        }
      } catch { continue; }
    }
  }

  // Deduplicate dirs (v2 and legacy may resolve to the same path)
  const seen = new Set<string>();
  for (const dir of DOC_DIRS) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    await scanForDocs(dir);
  }

  if (candidates.length === 0) return null;

  // Sort by score descending, take the best match
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];

  // Require at least 2 keyword hits to avoid false positives
  if (best.score < 2) return null;

  try {
    const content = await readBrainFile(best.path);
    return { path: best.path, filename: best.filename, content };
  } catch {
    return null;
  }
}
