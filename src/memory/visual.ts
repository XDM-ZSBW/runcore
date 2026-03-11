/**
 * Visual memory — persist images to FileManager + LTM with searchable descriptions.
 * On retrieval, re-injects actual image data into LLM context as multimodal blocks.
 */

import { join } from "node:path";
import { FileManager } from "../files/manager.js";
import { FileSystemLongTermMemory } from "./file-backed.js";
import { completeChat } from "../llm/complete.js";
import { getEncryptionKey } from "../lib/key-store.js";
import { createLogger } from "../utils/logger.js";
import type { MemoryEntry } from "../types.js";
import type { ProviderName } from "../llm/providers/types.js";
import type { FileEntry } from "../files/types.js";
import { BRAIN_DIR } from "../lib/paths.js";

const log = createLogger("visual-memory");

const MEMORY_DIR = join(BRAIN_DIR, "memory");

// ── Types ───────────────────────────────────────────────────────────────────

export interface VisualMemorySaveOptions {
  imageData: string;       // raw base64 (no data: prefix)
  mimeType: string;
  userContext: string;     // what the user said alongside the image
  provider: ProviderName;
  model?: string;
  maxImageBytes?: number;  // override from settings
}

export interface VisualMemorySaveResult {
  ok: boolean;
  fileEntry?: FileEntry;
  description?: string;
  error?: string;
}

export interface HydratedVisualMemory {
  entry: MemoryEntry;
  description: string;
  dataUri: string;
  sizeBytes: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Lazy LTM factory — same pattern as agents/memory.ts */
function getLtm(): FileSystemLongTermMemory {
  return new FileSystemLongTermMemory(MEMORY_DIR, getEncryptionKey() ?? undefined);
}

/** Map mimeType to file extension. */
function extFromMime(mime: string): string {
  const map: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "image/bmp": "bmp",
  };
  return map[mime] ?? "png";
}

// ── Type guard ──────────────────────────────────────────────────────────────

/** Check if a memory entry is a visual memory (has fileId + source marker). */
export function isVisualMemory(entry: MemoryEntry): boolean {
  return (
    entry.meta?.source === "visual-memory" &&
    typeof entry.meta?.fileId === "string"
  );
}

// ── Save ────────────────────────────────────────────────────────────────────

/**
 * Persist an image to FileManager and create a searchable episodic memory.
 * Fire-and-forget safe — never throws, returns { ok: false } on failure.
 */
export async function saveVisualMemory(
  opts: VisualMemorySaveOptions,
): Promise<VisualMemorySaveResult> {
  try {
    // 1. Validate
    if (!opts.mimeType.startsWith("image/")) {
      return { ok: false, error: "Not an image mimeType" };
    }

    const buffer = Buffer.from(opts.imageData, "base64");
    const maxBytes = opts.maxImageBytes ?? 10 * 1024 * 1024;
    if (buffer.length > maxBytes) {
      return { ok: false, error: `Image too large: ${buffer.length} bytes (max ${maxBytes})` };
    }

    // 2. Upload to FileManager
    const fm = FileManager.getInstance();
    if (!fm) {
      return { ok: false, error: "FileManager not initialized" };
    }

    const ext = extFromMime(opts.mimeType);
    const ts = Date.now();
    const uploadResult = await fm.upload({
      buffer,
      originalName: `chat-image-${ts}.${ext}`,
      mimeType: opts.mimeType,
      category: "media",
      origin: "user-upload",
      tags: ["visual-memory"],
    });

    if (!uploadResult.ok || !uploadResult.file) {
      return { ok: false, error: `Upload failed: ${uploadResult.message}` };
    }

    const fileEntry = uploadResult.file;

    // 3. Generate description via vision model
    let description: string;
    try {
      description = await describeImage(
        opts.imageData,
        opts.mimeType,
        opts.userContext,
        opts.provider,
        opts.model,
      );
    } catch (err) {
      // Fallback if vision model unavailable
      log.warn("Vision description failed, using fallback", {
        error: err instanceof Error ? err.message : String(err),
      });
      description = opts.userContext
        ? `Image shared by user. Context: ${opts.userContext.slice(0, 500)}`
        : "Image shared by user (no description available).";
    }

    // 4. Persist to episodic memory
    await getLtm().add({
      type: "episodic",
      content: description,
      meta: {
        source: "visual-memory",
        fileId: fileEntry.id,
        mimeType: opts.mimeType,
        originalContext: opts.userContext.slice(0, 500),
      },
    });

    log.info("Visual memory saved", { fileId: fileEntry.id, descLength: description.length });

    return { ok: true, fileEntry, description };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("saveVisualMemory failed", { error: msg });
    return { ok: false, error: msg };
  }
}

// ── Describe ────────────────────────────────────────────────────────────────

/** Use a vision-capable model to generate a searchable text description of an image. */
async function describeImage(
  imageData: string,
  mimeType: string,
  userContext: string,
  provider: ProviderName,
  model?: string,
): Promise<string> {
  const dataUri = `data:${mimeType};base64,${imageData}`;

  const contextHint = userContext
    ? `\nThe user said alongside this image: "${userContext.slice(0, 300)}"`
    : "";

  const response = await completeChat({
    messages: [
      {
        role: "system",
        content: "You describe images for a personal memory system. Be factual and concise.",
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: [
              "Describe this image in 2-4 factual sentences for future search and retrieval.",
              "Cover: image type, key visual elements, any visible text or data, and apparent purpose.",
              contextHint,
            ].join("\n"),
          },
          {
            type: "image_url",
            image_url: { url: dataUri },
          },
        ],
      },
    ],
    provider,
    model,
    noCache: true,
  });

  return response.trim();
}

// ── Hydrate ─────────────────────────────────────────────────────────────────

/**
 * Re-hydrate visual memory entries with actual image data for LLM injection.
 * Entries should already be relevance-sorted (from LTM search).
 * Returns empty array on any failure — never throws.
 */
export async function hydrateVisualMemories(
  entries: MemoryEntry[],
  maxImages: number = 2,
): Promise<HydratedVisualMemory[]> {
  const fm = FileManager.getInstance();
  if (!fm) return [];

  const visual = entries.filter(isVisualMemory).slice(0, maxImages);
  const results: HydratedVisualMemory[] = [];

  for (const entry of visual) {
    try {
      const fileId = entry.meta!.fileId as string;
      const readResult = await fm.read(fileId);

      if (!readResult.ok || !readResult.data) {
        log.debug("Skipping visual memory — file not found", { fileId });
        continue;
      }

      const mimeType = (entry.meta!.mimeType as string) || "image/png";
      const dataUri = `data:${mimeType};base64,${readResult.data.toString("base64")}`;

      results.push({
        entry,
        description: entry.content,
        dataUri,
        sizeBytes: readResult.data.length,
      });
    } catch (err) {
      log.debug("Skipping visual memory — read error", {
        entryId: entry.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}

// ── Targeted search ─────────────────────────────────────────────────────────

/**
 * Search LTM specifically for visual memory entries.
 * Used as a fallback when the generic Brain.retrieve() didn't surface any
 * visual memories (they got crowded out by other episodic entries).
 *
 * Two-pass strategy:
 *  1. Try keyword match (user query) + meta filter — finds visuals relevant to what the user asked
 *  2. If nothing, fetch ALL visual memories sorted by recency — ensures we always surface something
 *
 * Returns entries sorted by recency (newest first).
 */
export async function searchVisualMemories(
  query: string,
  max: number = 5,
): Promise<MemoryEntry[]> {
  try {
    const ltm = getLtm();

    // Pass 1: keyword + meta — relevant visuals
    const keywordHits = await ltm.search({
      type: "episodic",
      contentSubstring: query,
      meta: { source: "visual-memory" },
    });
    const relevant = keywordHits.filter(isVisualMemory);
    if (relevant.length > 0) return relevant.slice(0, max);

    // Pass 2 removed — don't inject unrelated visual memories every turn.
    // Only return visual memories that actually match the user's query.
    return [];
  } catch (err) {
    log.debug("searchVisualMemories failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
