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

import { BRAIN_DIR } from "../lib/paths.js";

/** Directories to scan for documents the user might reference by description. */
const DOC_DIRS = [
  join(BRAIN_DIR, "content", "drafts"),
  join(BRAIN_DIR, "knowledge", "notes"),
  join(BRAIN_DIR, "knowledge", "research"),
  join(BRAIN_DIR, "knowledge", "protocols"),
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

  for (const dir of DOC_DIRS) {
    try {
      const files = await readdir(dir);
      for (const file of files) {
        if (!file.endsWith(".md")) continue;
        const score = scoreMatch(file, keywords);
        if (score > 0) {
          candidates.push({ path: join(dir, file), filename: file, score });
        }
      }
    } catch {
      // Directory might not exist — skip
    }
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
