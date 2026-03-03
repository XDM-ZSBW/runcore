/**
 * File compression and thumbnail generation — DASH-65.
 * Uses Node zlib for text compression. Image optimization deferred
 * until sharp dependency is added (see spec open question #1).
 * Never throws — returns CompressionResult or null.
 */

import { readFile, writeFile, stat } from "node:fs/promises";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../utils/logger.js";
import type { CompressionResult } from "./types.js";

const log = createLogger("files.compress");

const TEXT_COMPRESS_THRESHOLD = 100 * 1024; // 100 KB

// ── Text compression (gzip) ─────────────────────────────────────────────────

/**
 * Gzip a file if it's text-based and exceeds the threshold.
 * Creates a .gz companion file alongside the original.
 */
async function compressText(filePath: string): Promise<CompressionResult | null> {
  try {
    const fileStat = await stat(filePath);
    if (fileStat.size < TEXT_COMPRESS_THRESHOLD) return null;

    const gzPath = filePath + ".gz";
    const gzip = createGzip({ level: 6 });
    await pipeline(createReadStream(filePath), gzip, createWriteStream(gzPath));

    const gzStat = await stat(gzPath);
    const saved = Math.round((1 - gzStat.size / fileStat.size) * 100);

    log.info("text file compressed", { path: filePath, saved: `${saved}%` });
    return {
      originalBytes: fileStat.size,
      compressedBytes: gzStat.size,
      saved,
      action: "gzip-text",
    };
  } catch (err: any) {
    log.warn("text compression failed", { path: filePath, error: err.message });
    return null;
  }
}

// ── Main compression entry point ────────────────────────────────────────────

/**
 * Compress a file based on its MIME type.
 * Returns null if no compression was needed or applicable.
 */
export async function compressFile(
  storagePath: string,
  mimeType: string,
): Promise<CompressionResult | null> {
  const mimeBase = mimeType.split("/")[0];

  // Text > 100 KB: gzip alongside original
  if (mimeBase === "text" || mimeType === "application/json" || mimeType === "application/x-yaml") {
    return compressText(storagePath);
  }

  // PNG/JPEG: would use sharp for optimization.
  // Deferred until sharp is added as a dependency.
  // For now, log that optimization was skipped.
  if (mimeType === "image/png" || mimeType === "image/jpeg") {
    log.debug("image optimization skipped — sharp not installed", { path: storagePath, mime: mimeType });
    return null;
  }

  // WebP, PDF, DOCX/XLSX: no-op (already compressed or risky)
  return null;
}

// ── Thumbnail generation (placeholder) ──────────────────────────────────────

/**
 * Generate a thumbnail for a file.
 * Currently a no-op placeholder — requires sharp for images and
 * a PDF renderer for document first-page previews.
 * Returns the thumbnail path if generated, null otherwise.
 */
export async function generateThumbnail(
  storagePath: string,
  mimeType: string,
  thumbnailDir: string,
  fileId: string,
): Promise<string | null> {
  // Image thumbnails would use sharp to resize to 400px wide WebP
  // PDF thumbnails would render the first page
  // Both require sharp as a dependency

  const mimeBase = mimeType.split("/")[0];
  if (mimeBase === "image" || mimeType === "application/pdf") {
    log.debug("thumbnail generation skipped — sharp not installed", {
      fileId,
      mime: mimeType,
    });
  }

  return null;
}
