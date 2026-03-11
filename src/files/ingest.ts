/**
 * File ingestion: read a directory recursively and return structured text
 * suitable for injecting into an LLM context window.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, extname, relative } from "node:path";
// extract.js is hosted-tier (tesseract/OCR) — dynamic import with graceful fallback
let _extract: typeof import("./extract.js") | null = null;
async function getExtract() {
  if (!_extract) {
    try { _extract = await import("./extract.js"); } catch { _extract = null; }
  }
  return _extract;
}

const READABLE_EXTENSIONS = new Set([
  ".md", ".txt", ".json", ".yaml", ".yml", ".csv",
  ".ts", ".js", ".html", ".css", ".xml", ".toml",
  ".env.example", ".cfg", ".ini", ".log", ".sh",
  ".py", ".rs", ".go", ".sql", ".graphql", ".prisma",
  ".pdf",
]);

const IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".tiff", ".bmp", ".webp",
]);

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".next", ".turbo", "__pycache__"]);

const MAX_FILE_SIZE = 50 * 1024;          // 50KB for text files
const MAX_BINARY_FILE_SIZE = 5 * 1024 * 1024; // 5MB for PDFs and images
const DEFAULT_BUDGET = 12_000;   // ~3,000 tokens

export interface IngestResult {
  content: string;
  files: string[];
  truncated: boolean;
}

export async function ingestDirectory(
  dirPath: string,
  options?: { budget?: number }
): Promise<IngestResult> {
  const budget = options?.budget ?? DEFAULT_BUDGET;

  // Verify directory exists
  const dirStat = await stat(dirPath).catch(() => null);
  if (!dirStat || !dirStat.isDirectory()) {
    throw new Error(`Not a directory: ${dirPath}`);
  }

  // Recursively list all files
  const entries = await readdir(dirPath, { recursive: true, withFileTypes: true });

  // Filter to readable files, skip excluded dirs
  const filePaths: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;

    // Build relative path from the entry
    const relPath = entry.parentPath
      ? relative(dirPath, join(entry.parentPath, entry.name))
      : entry.name;

    // Skip excluded directories
    const parts = relPath.split(/[/\\]/);
    if (parts.some((p) => SKIP_DIRS.has(p))) continue;

    // Check extension
    const ext = extname(entry.name).toLowerCase();
    // Special case: files with no extension but common names
    const baseName = entry.name.toLowerCase();
    if (!READABLE_EXTENSIONS.has(ext) && !IMAGE_EXTENSIONS.has(ext) && !["makefile", "dockerfile", "readme", "license", "changelog"].includes(baseName)) {
      continue;
    }

    filePaths.push(relPath);
  }

  // Sort by path for stable output, shorter paths first (prioritize shallower files)
  filePaths.sort((a, b) => {
    const depthA = a.split(/[/\\]/).length;
    const depthB = b.split(/[/\\]/).length;
    if (depthA !== depthB) return depthA - depthB;
    return a.localeCompare(b);
  });

  // Read files, respecting individual size limits
  const fileContents: { path: string; content: string; size: number }[] = [];
  for (const relPath of filePaths) {
    const fullPath = join(dirPath, relPath);
    try {
      const ext = extname(relPath).toLowerCase();
      const isBinary = ext === ".pdf" || IMAGE_EXTENSIONS.has(ext);
      const sizeLimit = isBinary ? MAX_BINARY_FILE_SIZE : MAX_FILE_SIZE;

      const fileStat = await stat(fullPath);
      if (fileStat.size > sizeLimit) continue;

      let content: string;
      if (ext === ".pdf") {
        const extract = await getExtract();
        if (!extract) continue; // OCR not available on this tier
        const buf = await readFile(fullPath);
        content = await extract.extractPdfText(buf);
      } else if (IMAGE_EXTENSIONS.has(ext)) {
        const extract = await getExtract();
        if (!extract) continue; // OCR not available on this tier
        const buf = await readFile(fullPath);
        content = await extract.extractImageText(buf);
      } else {
        content = await readFile(fullPath, "utf-8");
        // Skip files that look binary (contain null bytes)
        if (content.includes("\0")) continue;
      }

      if (!content) continue;
      fileContents.push({ path: relPath, content, size: content.length });
    } catch {
      // Skip unreadable files
    }
  }

  // Build output, respecting total budget
  let totalChars = 0;
  let truncated = false;
  const included: string[] = [];
  const sections: string[] = [];

  for (const file of fileContents) {
    const header = `=== ${file.path} ===\n`;
    const headerLen = header.length;

    if (totalChars + headerLen >= budget) {
      truncated = true;
      break;
    }

    const remaining = budget - totalChars - headerLen;
    let body = file.content;

    if (body.length > remaining) {
      body = body.slice(0, remaining) + "\n... [truncated]";
      truncated = true;
    }

    sections.push(header + body);
    totalChars += header.length + body.length;
    included.push(file.path);

    if (totalChars >= budget) {
      truncated = true;
      break;
    }
  }

  return {
    content: sections.join("\n\n"),
    files: included,
    truncated,
  };
}
