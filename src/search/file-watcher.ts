/**
 * Brain file watcher — triggers re-indexing on file changes.
 * Debounces rapid saves. Watches brain/files/ and legacy dirs.
 */

import { watch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "../utils/logger.js";
import { FILES_DIR, resolveBrainDir } from "../lib/paths.js";
import type { BrainRAG } from "./brain-rag.js";

const log = createLogger("file-watcher");

const DEBOUNCE_MS = 2000;
const SEARCHABLE_EXTS = new Set([".md", ".yaml", ".yml", ".txt"]);

const WATCH_DIRS = [
  FILES_DIR,
  resolveBrainDir("content"),
  resolveBrainDir("knowledge"),
  resolveBrainDir("identity"),
  resolveBrainDir("operations"),
  resolveBrainDir("skills"),
  resolveBrainDir("templates"),
];

/**
 * Watch brain directories for changes and trigger re-indexing.
 * Returns a cleanup function that stops all watchers.
 */
export function watchBrain(rag: BrainRAG): () => void {
  const watchers: FSWatcher[] = [];
  const pending = new Map<string, NodeJS.Timeout>();

  function handleChange(dir: string, filename: string | null) {
    if (!filename) return;
    const ext = filename.substring(filename.lastIndexOf(".")).toLowerCase();
    if (!SEARCHABLE_EXTS.has(ext)) return;

    const fullPath = join(dir, filename);
    const key = fullPath;

    // Debounce: clear previous timer for this file
    const existing = pending.get(key);
    if (existing) clearTimeout(existing);

    pending.set(key, setTimeout(async () => {
      pending.delete(key);
      try {
        // Check if file still exists (might have been deleted)
        const s = await stat(fullPath).catch(() => null);
        if (!s || !s.isFile()) {
          log.info(`File removed or not a file: ${filename}`);
          return;
        }
        log.info(`Re-indexing changed file: ${filename}`);
        await rag.indexFile(fullPath);
      } catch (err) {
        log.error(`Failed to re-index ${filename}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, DEBOUNCE_MS));
  }

  // Deduplicate dirs
  const seen = new Set<string>();
  for (const dir of WATCH_DIRS) {
    if (seen.has(dir)) continue;
    seen.add(dir);

    try {
      const watcher = watch(dir, { recursive: true }, (_event, filename) => {
        handleChange(dir, filename);
      });
      watchers.push(watcher);
      log.info(`Watching: ${dir}`);
    } catch {
      // Directory might not exist — skip
    }
  }

  return () => {
    for (const w of watchers) w.close();
    for (const timer of pending.values()) clearTimeout(timer);
    pending.clear();
    log.info("File watchers stopped");
  };
}
