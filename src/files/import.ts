/**
 * Brain import — scan external folders and map them to brain structure.
 *
 * Adapts whatever the user already has — Obsidian vaults, loose documents,
 * project folders — into Core's brain layout. Copies, never moves.
 * The source files stay untouched.
 *
 * Mapping rules:
 * - Markdown files → brain/knowledge/notes/
 * - Daily notes (YYYY-MM-DD.md pattern) → brain/memory/ (as experiences)
 * - PDFs, research → brain/knowledge/research/
 * - Images → brain/knowledge/assets/
 * - Config/dotfiles → skipped
 * - Templates → brain/content/templates/
 * - Bookmarks, links → brain/knowledge/bookmarks/
 * - Everything else readable → brain/knowledge/notes/
 *
 * After copying, generates a manifest (brain/.core/import-manifest.json)
 * so Core knows what was imported and from where.
 */

import { readdir, readFile, copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import { join, extname, basename, relative, dirname } from "node:path";
import { existsSync } from "node:fs";
import { createLogger } from "../utils/logger.js";

const log = createLogger("import");

// ── File classification ─────────────────────────────────────────────────────

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", ".next", ".turbo", "__pycache__",
  ".obsidian", ".trash", ".vscode", ".idea",
]);

const SKIP_FILES = new Set([
  ".DS_Store", "Thumbs.db", "desktop.ini", ".gitignore", ".env",
]);

const DAILY_NOTE_PATTERN = /^\d{4}-\d{2}-\d{2}\.md$/;
const TEMPLATE_INDICATORS = ["template", "templates", "tmpl"];

interface ClassifiedFile {
  sourcePath: string;
  relativePath: string;
  destination: string; // relative to brain/
  category: "note" | "daily" | "research" | "asset" | "template" | "bookmark";
}

function classifyFile(relPath: string, sourceRoot: string): ClassifiedFile | null {
  const name = basename(relPath);
  const ext = extname(name).toLowerCase();
  const parts = relPath.split(/[/\\]/);

  // Skip hidden and system files
  if (SKIP_FILES.has(name)) return null;
  if (name.startsWith(".")) return null;
  if (parts.some(p => SKIP_DIRS.has(p))) return null;

  // Daily notes → memory experiences
  if (DAILY_NOTE_PATTERN.test(name)) {
    return {
      sourcePath: join(sourceRoot, relPath),
      relativePath: relPath,
      destination: join("memory", "imported", name),
      category: "daily",
    };
  }

  // Templates folder
  if (parts.some(p => TEMPLATE_INDICATORS.includes(p.toLowerCase()))) {
    if (ext === ".md" || ext === ".txt") {
      return {
        sourcePath: join(sourceRoot, relPath),
        relativePath: relPath,
        destination: join("content", "templates", name),
        category: "template",
      };
    }
  }

  // PDFs → research
  if (ext === ".pdf") {
    return {
      sourcePath: join(sourceRoot, relPath),
      relativePath: relPath,
      destination: join("knowledge", "research", name),
      category: "research",
    };
  }

  // Images → assets
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(ext)) {
    return {
      sourcePath: join(sourceRoot, relPath),
      relativePath: relPath,
      destination: join("knowledge", "assets", name),
      category: "asset",
    };
  }

  // Bookmark files
  if (name.toLowerCase().includes("bookmark") || ext === ".webloc" || ext === ".url") {
    return {
      sourcePath: join(sourceRoot, relPath),
      relativePath: relPath,
      destination: join("knowledge", "bookmarks", name),
      category: "bookmark",
    };
  }

  // Markdown and text → notes (preserve subfolder structure)
  if ([".md", ".txt", ".yaml", ".yml"].includes(ext)) {
    // Preserve one level of subfolder for organization
    const subPath = parts.length > 1
      ? join(parts.slice(0, -1).join("/"), name)
      : name;
    return {
      sourcePath: join(sourceRoot, relPath),
      relativePath: relPath,
      destination: join("knowledge", "notes", subPath),
      category: "note",
    };
  }

  // Other readable files → notes
  if ([".json", ".csv", ".toml", ".ini", ".xml"].includes(ext)) {
    return {
      sourcePath: join(sourceRoot, relPath),
      relativePath: relPath,
      destination: join("knowledge", "notes", name),
      category: "note",
    };
  }

  return null;
}

// ── Scan ─────────────────────────────────────────────────────────────────────

async function scanDirectory(dirPath: string): Promise<ClassifiedFile[]> {
  const results: ClassifiedFile[] = [];

  const entries = await readdir(dirPath, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;

    const relPath = entry.parentPath
      ? relative(dirPath, join(entry.parentPath, entry.name))
      : entry.name;

    const classified = classifyFile(relPath, dirPath);
    if (classified) results.push(classified);
  }

  return results;
}

// ── Import manifest ──────────────────────────────────────────────────────────

interface ImportManifest {
  importedAt: string;
  sources: string[];
  files: {
    source: string;
    destination: string;
    category: string;
  }[];
  counts: Record<string, number>;
}

// ── Main import function ─────────────────────────────────────────────────────

export interface ImportOptions {
  /** Directories to scan */
  sources: string[];
  /** Brain root directory */
  brainRoot: string;
  /** Dry run — show what would be imported without copying */
  dryRun?: boolean;
  /** Max total files to import (safety limit) */
  maxFiles?: number;
  /** Max single file size in bytes */
  maxFileSize?: number;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  categories: Record<string, number>;
  files: { source: string; destination: string; category: string }[];
}

export async function importToBrain(options: ImportOptions): Promise<ImportResult> {
  const {
    sources,
    brainRoot,
    dryRun = false,
    maxFiles = 500,
    maxFileSize = 10 * 1024 * 1024, // 10MB
  } = options;

  const brainDir = join(brainRoot, "brain");
  const allFiles: ClassifiedFile[] = [];

  // Scan all source directories
  for (const source of sources) {
    const absSource = join(source); // resolve
    const dirStat = await stat(absSource).catch(() => null);
    if (!dirStat?.isDirectory()) {
      log.warn(`Skipping ${source} — not a directory`);
      continue;
    }

    log.info(`Scanning ${source}...`);
    const files = await scanDirectory(absSource);
    allFiles.push(...files);
  }

  if (allFiles.length === 0) {
    return { imported: 0, skipped: 0, categories: {}, files: [] };
  }

  // Deduplicate by destination (first one wins)
  const seen = new Set<string>();
  const unique = allFiles.filter(f => {
    if (seen.has(f.destination)) return false;
    seen.add(f.destination);
    return true;
  });

  // Apply limits
  const toImport = unique.slice(0, maxFiles);
  const skipped = unique.length - toImport.length;

  if (dryRun) {
    const categories: Record<string, number> = {};
    const files = toImport.map(f => {
      categories[f.category] = (categories[f.category] || 0) + 1;
      return { source: f.relativePath, destination: f.destination, category: f.category };
    });
    return { imported: toImport.length, skipped, categories, files };
  }

  // Copy files
  const categories: Record<string, number> = {};
  const importedFiles: { source: string; destination: string; category: string }[] = [];
  let imported = 0;

  for (const file of toImport) {
    try {
      // Check file size
      const fileStat = await stat(file.sourcePath);
      if (fileStat.size > maxFileSize) continue;

      const destPath = join(brainDir, file.destination);
      await mkdir(dirname(destPath), { recursive: true });

      // Don't overwrite existing brain files
      if (existsSync(destPath)) continue;

      await copyFile(file.sourcePath, destPath);
      categories[file.category] = (categories[file.category] || 0) + 1;
      importedFiles.push({
        source: file.relativePath,
        destination: file.destination,
        category: file.category,
      });
      imported++;
    } catch (err) {
      log.warn(`Failed to import ${file.relativePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Write manifest
  const manifest: ImportManifest = {
    importedAt: new Date().toISOString(),
    sources,
    files: importedFiles,
    counts: categories,
  };
  const manifestDir = join(brainDir, ".core");
  await mkdir(manifestDir, { recursive: true });
  await writeFile(
    join(manifestDir, "import-manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf-8"
  );

  return { imported, skipped, categories, files: importedFiles };
}
