/**
 * Ingest folder: drop-zone for documents to absorb.
 *
 * Files placed in `ingest/` are read, moved to `ingested/`, and all of
 * `ingested/` is returned as persistent background context.
 */

import { readdir, rename, mkdir, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { ingestDirectory } from "./ingest.js";

const INGEST_BUDGET = 50_000; // ~12,500 tokens — larger than learn command's 12K

export interface IngestFolderResult {
  /** Combined content from all ingested files */
  content: string;
  /** All files currently in the ingested archive */
  files: string[];
  /** Files that were newly moved from ingest/ this run */
  newFiles: string[];
}

/**
 * Process the ingest drop-zone:
 * 1. Ensure both folders exist
 * 2. Move any files from ingestDir → ingestedDir (preserving subdirectory structure)
 * 3. Read all of ingestedDir as persistent context
 */
export async function processIngestFolder(
  ingestDir: string,
  ingestedDir: string,
): Promise<IngestFolderResult> {
  // Ensure both directories exist
  await mkdir(ingestDir, { recursive: true });
  await mkdir(ingestedDir, { recursive: true });

  // Move new files from ingest/ → ingested/
  const newFiles: string[] = [];
  await moveFiles(ingestDir, ingestDir, ingestedDir, newFiles);

  // Read everything in ingested/ as persistent context
  let content = "";
  let files: string[] = [];

  try {
    const result = await ingestDirectory(ingestedDir, { budget: INGEST_BUDGET });
    content = result.content;
    files = result.files;
  } catch {
    // ingested/ is empty or unreadable — that's fine
  }

  return { content, files, newFiles };
}

/**
 * Recursively move files from source into the ingested archive,
 * preserving subdirectory structure.
 */
async function moveFiles(
  currentDir: string,
  baseIngestDir: string,
  ingestedDir: string,
  moved: string[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(currentDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const srcPath = join(currentDir, entry.name);

    if (entry.isDirectory()) {
      await moveFiles(srcPath, baseIngestDir, ingestedDir, moved);
      continue;
    }

    if (!entry.isFile()) continue;

    // Compute relative path from ingest root
    const relFromBase = srcPath.slice(baseIngestDir.length).replace(/^[/\\]+/, "");
    const destPath = join(ingestedDir, relFromBase);

    // Ensure destination subdirectory exists
    await mkdir(dirname(destPath), { recursive: true });

    try {
      await rename(srcPath, destPath);
      moved.push(relFromBase);
    } catch {
      // If rename fails (cross-device), skip silently
    }
  }
}
