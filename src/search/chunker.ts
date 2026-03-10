/**
 * Markdown-aware chunking for brain files.
 * Splits on headers first, then paragraphs, with a 512-token target.
 * Pure function — no I/O, no side effects.
 */

import { createHash } from "node:crypto";

/** ~4 chars per token, 512 tokens */
const MAX_CHUNK_CHARS = 2048;
/** Overlap between consecutive chunks within a section */
const OVERLAP_CHARS = 200;

export interface Chunk {
  /** Content-addressed ID: sha256(filePath + ":" + index) truncated to 16 hex */
  id: string;
  /** Relative path to the source file (from brain root) */
  filePath: string;
  /** Nearest parent heading, or filename if no heading */
  heading: string;
  /** The chunk text */
  text: string;
  /** Position index within the file */
  index: number;
}

/**
 * Chunk a markdown file into pieces suitable for embedding.
 * @param filePath - relative path from brain root (used in chunk ID)
 * @param content - file content
 */
export function chunkMarkdown(filePath: string, content: string): Chunk[] {
  if (!content.trim()) return [];

  const chunks: Chunk[] = [];
  let globalIndex = 0;

  // Split into sections by ## headers (level 1 or 2)
  const sections = splitByHeaders(content, filePath);

  for (const section of sections) {
    if (section.text.length <= MAX_CHUNK_CHARS) {
      // Section fits in one chunk
      chunks.push(makeChunk(filePath, section.heading, section.text, globalIndex++));
    } else {
      // Split large sections by paragraphs, then by size
      const paragraphs = section.text.split(/\n\n+/);
      let buffer = "";

      for (const para of paragraphs) {
        if (buffer.length + para.length + 2 > MAX_CHUNK_CHARS && buffer.length > 0) {
          // Flush buffer
          chunks.push(makeChunk(filePath, section.heading, buffer.trim(), globalIndex++));
          // Overlap: keep tail of previous buffer
          buffer = buffer.length > OVERLAP_CHARS
            ? buffer.slice(-OVERLAP_CHARS) + "\n\n" + para
            : para;
        } else {
          buffer += (buffer ? "\n\n" : "") + para;
        }
      }

      // Flush remaining
      if (buffer.trim()) {
        chunks.push(makeChunk(filePath, section.heading, buffer.trim(), globalIndex++));
      }
    }
  }

  return chunks;
}

interface Section {
  heading: string;
  text: string;
}

function splitByHeaders(content: string, filePath: string): Section[] {
  // Extract filename without extension as fallback heading
  const fallbackHeading = filePath.split("/").pop()?.replace(/\.\w+$/, "") ?? filePath;

  const lines = content.split("\n");
  const sections: Section[] = [];
  let currentHeading = fallbackHeading;
  let currentLines: string[] = [];

  for (const line of lines) {
    const headerMatch = line.match(/^#{1,3}\s+(.+)/);
    if (headerMatch) {
      // Flush previous section
      if (currentLines.length > 0) {
        const text = currentLines.join("\n").trim();
        if (text) sections.push({ heading: currentHeading, text });
      }
      currentHeading = headerMatch[1].trim();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }

  // Flush last section
  if (currentLines.length > 0) {
    const text = currentLines.join("\n").trim();
    if (text) sections.push({ heading: currentHeading, text });
  }

  // If no sections found (no headers), treat entire content as one section
  if (sections.length === 0 && content.trim()) {
    sections.push({ heading: fallbackHeading, text: content.trim() });
  }

  return sections;
}

function makeChunk(filePath: string, heading: string, text: string, index: number): Chunk {
  const hash = createHash("sha256")
    .update(filePath + ":" + index)
    .digest("hex")
    .slice(0, 16);
  return { id: hash, filePath, heading, text, index };
}
