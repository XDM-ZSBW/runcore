/**
 * Brain Shadow Files — read-only viewer for whitelisted brain directories.
 * Mounted at /api/library/brain in server.ts.
 * Pure GET routes, zero mutation surface.
 */

import { Hono } from "hono";
import { readdir, stat, readFile } from "node:fs/promises";
import { join, basename, extname } from "node:path";
import { createLogger } from "../utils/logger.js";
import { forbidden, notFound } from "../middleware/error-handler.js";

const log = createLogger("library.brain-shadow");

// ── Whitelist config ────────────────────────────────────────────────────

interface CategoryConfig {
  key: string;
  label: string;
  icon: string;
  relPath: string;
  mdOnly?: boolean; // e.g. identity — only expose .md files
}

const CATEGORIES: CategoryConfig[] = [
  { key: "research", label: "Research", icon: "🔬", relPath: "knowledge/research" },
  { key: "notes", label: "Notes", icon: "📝", relPath: "knowledge/notes" },
  { key: "protocols", label: "Protocols", icon: "📐", relPath: "knowledge/protocols" },
  { key: "identity", label: "Identity", icon: "🧬", relPath: "identity", mdOnly: true },
  { key: "templates", label: "Templates", icon: "📋", relPath: "content/templates" },
];

const CATEGORY_MAP = new Map(CATEGORIES.map((c) => [c.key, c]));

const ALLOWED_EXTENSIONS = new Set([".md", ".yaml", ".yml"]);
const BLOCKED_FILES = new Set([".session-key", "human.json"]);

let brainDir = "";

/** Call once during server init to set the brain directory root. */
export function initBrainShadow(dir: string) {
  brainDir = dir;
  log.info(`Brain shadow initialized: ${dir}`);
}

// ── Helpers ─────────────────────────────────────────────────────────────

function isAllowed(filename: string, mdOnly?: boolean): boolean {
  const base = basename(filename);
  if (base.startsWith(".")) return false;
  if (BLOCKED_FILES.has(base)) return false;
  const ext = extname(base).toLowerCase();
  if (mdOnly) return ext === ".md";
  return ALLOWED_EXTENSIONS.has(ext);
}

function mimeForExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case ".md":
      return "text/markdown";
    case ".yaml":
    case ".yml":
      return "text/yaml";
    default:
      return "text/plain";
  }
}

interface ShadowFile {
  id: string;
  name: string;
  sizeBytes: number;
  mimeType: string;
  modifiedAt: string;
  textPreview: string;
}

async function scanCategory(cat: CategoryConfig): Promise<ShadowFile[]> {
  const dirPath = join(brainDir, cat.relPath);
  let entries: string[];
  try {
    entries = await readdir(dirPath);
  } catch {
    return [];
  }

  const files: ShadowFile[] = [];
  for (const entry of entries) {
    if (!isAllowed(entry, cat.mdOnly)) continue;

    const filePath = join(dirPath, entry);
    try {
      const st = await stat(filePath);
      if (!st.isFile()) continue;

      const content = await readFile(filePath, "utf-8");
      files.push({
        id: `shadow_${cat.key}_${entry}`,
        name: entry,
        sizeBytes: st.size,
        mimeType: mimeForExt(extname(entry)),
        modifiedAt: st.mtime.toISOString(),
        textPreview: content.slice(0, 500),
      });
    } catch {
      // Skip files we can't read
    }
  }

  // Sort by modified date descending
  files.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());
  return files;
}

// ── Routes ──────────────────────────────────────────────────────────────

export const brainShadowRoutes = new Hono();

/** GET / — List categories with file counts */
brainShadowRoutes.get("/", async (c) => {
  try {
    const categories = await Promise.all(
      CATEGORIES.map(async (cat) => {
        const files = await scanCategory(cat);
        return {
          key: cat.key,
          label: cat.label,
          icon: cat.icon,
          fileCount: files.length,
          totalBytes: files.reduce((sum, f) => sum + f.sizeBytes, 0),
        };
      }),
    );
    return c.json({ categories });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Failed to list brain categories: ${msg}`);
    return c.json({ error: msg }, 500);
  }
});

/** GET /:category — List files in category */
brainShadowRoutes.get("/:category", async (c) => {
  try {
    const key = c.req.param("category");
    const cat = CATEGORY_MAP.get(key);
    if (!cat) return notFound("Unknown category");

    const files = await scanCategory(cat);
    return c.json({
      category: { key: cat.key, label: cat.label, icon: cat.icon },
      files,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Failed to list brain files: ${msg}`);
    return c.json({ error: msg }, 500);
  }
});

/** GET /:category/:filename/download — Serve file with path traversal protection */
brainShadowRoutes.get("/:category/:filename/download", async (c) => {
  try {
    const key = c.req.param("category");
    const cat = CATEGORY_MAP.get(key);
    if (!cat) return notFound("Unknown category");

    const rawFilename = c.req.param("filename");
    const safe = basename(rawFilename);

    if (!isAllowed(safe, cat.mdOnly)) {
      return forbidden("File type not allowed");
    }

    const filePath = join(brainDir, cat.relPath, safe);
    const content = await readFile(filePath);

    return new Response(content, {
      headers: {
        "Content-Type": mimeForExt(extname(safe)),
        "Content-Disposition": `attachment; filename="${safe}"`,
        "Content-Length": content.length.toString(),
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("ENOENT")) return notFound("File not found");
    log.error(`Failed to download brain file: ${msg}`);
    return c.json({ error: msg }, 500);
  }
});
