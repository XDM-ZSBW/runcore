/**
 * Document template management — DASH-65.
 * Templates live in storage/templates/<name>/ with versioned files.
 * Supports {{variable}} substitution for Markdown templates.
 */

import { readFile, writeFile, readdir, mkdir, stat } from "node:fs/promises";
import { join, extname } from "node:path";
import { createHash } from "node:crypto";
import { createLogger } from "../utils/logger.js";
import type { FileEntry } from "./types.js";
import type { FileStore } from "./store.js";
import { slugify } from "./validate.js";

const log = createLogger("files.templates");

export interface TemplateInfo {
  name: string;
  slug: string;
  latestVersion: number;
  mimeType: string;
  storagePath: string;
  fileId: string | null;
  createdAt: string;
}

export interface TemplateGenerateResult {
  ok: boolean;
  content?: string;
  file?: FileEntry;
  message: string;
}

// ── Template CRUD ───────────────────────────────────────────────────────────

/**
 * Create a new template from a buffer.
 * Stores at storage/templates/<slug>/v1.<ext>
 */
export async function createTemplate(
  name: string,
  buffer: Buffer,
  mimeType: string,
  storageRoot: string,
  store: FileStore,
): Promise<{ ok: boolean; template?: TemplateInfo; message: string }> {
  try {
    const slug = slugify(name);
    if (!slug) return { ok: false, message: "Invalid template name" };

    const ext = extensionForMime(mimeType);
    const templateDir = join(storageRoot, "templates", slug);
    await mkdir(templateDir, { recursive: true });

    const version = 1;
    const fileName = `v${version}${ext}`;
    const filePath = join(templateDir, fileName);
    await writeFile(filePath, buffer);

    // Register in file store
    const checksum = createHash("sha256").update(buffer).digest("hex");
    const storagePath = join("templates", slug, fileName);

    const entry = await store.create({
      name,
      slug,
      mimeType,
      sizeBytes: buffer.length,
      category: "template",
      tags: ["template"],
      origin: "system",
      ownerId: null,
      taskId: null,
      parentId: null,
      version,
      storagePath,
      checksum,
      encrypted: false,
      visibility: "agents",
      status: "active",
    });

    log.info("template created", { name, slug, fileId: entry.id });
    return {
      ok: true,
      template: {
        name,
        slug,
        latestVersion: version,
        mimeType,
        storagePath,
        fileId: entry.id,
        createdAt: entry.createdAt,
      },
      message: `Template '${name}' created`,
    };
  } catch (err: any) {
    log.error("template creation failed", { name, error: err.message });
    return { ok: false, message: `Failed: ${err.message}` };
  }
}

/**
 * List all templates.
 */
export async function listTemplates(
  storageRoot: string,
  store: FileStore,
): Promise<TemplateInfo[]> {
  const files = await store.list({ category: "template" });
  return files.map((f) => ({
    name: f.name,
    slug: f.slug,
    latestVersion: f.version,
    mimeType: f.mimeType,
    storagePath: f.storagePath,
    fileId: f.id,
    createdAt: f.createdAt,
  }));
}

/**
 * Get a template by name/slug.
 */
export async function getTemplate(
  nameOrSlug: string,
  store: FileStore,
): Promise<TemplateInfo | null> {
  const slug = slugify(nameOrSlug);
  const files = await store.list({ category: "template" });
  const match = files.find((f) => f.slug === slug || f.name === nameOrSlug);
  if (!match) return null;

  return {
    name: match.name,
    slug: match.slug,
    latestVersion: match.version,
    mimeType: match.mimeType,
    storagePath: match.storagePath,
    fileId: match.id,
    createdAt: match.createdAt,
  };
}

/**
 * Generate a document from a template by filling {{variable}} placeholders.
 * Currently supports Markdown and plain text templates.
 */
export async function generateFromTemplate(
  nameOrSlug: string,
  variables: Record<string, string>,
  storageRoot: string,
  store: FileStore,
): Promise<TemplateGenerateResult> {
  const template = await getTemplate(nameOrSlug, store);
  if (!template) return { ok: false, message: `Template not found: ${nameOrSlug}` };

  try {
    const templatePath = join(storageRoot, template.storagePath);
    const content = await readFile(templatePath, "utf-8");

    // Replace {{variable}} placeholders
    let filled = content;
    for (const [key, value] of Object.entries(variables)) {
      filled = filled.replace(new RegExp(`\\{\\{${escapeRegex(key)}\\}\\}`, "g"), value);
    }

    // Warn about unfilled placeholders
    const unfilled = filled.match(/\{\{[^}]+\}\}/g);
    if (unfilled) {
      log.warn("template has unfilled placeholders", { template: template.name, unfilled });
    }

    // Register the generated file
    const buffer = Buffer.from(filled, "utf-8");
    const checksum = createHash("sha256").update(buffer).digest("hex");

    const now = new Date();
    const year = now.getFullYear().toString();
    const month = (now.getMonth() + 1).toString().padStart(2, "0");
    const slug = slugify(template.name + "-generated");
    const ext = extensionForMime(template.mimeType);
    const storagePath = join("generated", year, month, `${slug}${ext}`);
    const fullPath = join(storageRoot, storagePath);

    await mkdir(join(storageRoot, "generated", year, month), { recursive: true });
    await writeFile(fullPath, buffer);

    const entry = await store.create({
      name: `${template.name} (generated)`,
      slug,
      mimeType: template.mimeType,
      sizeBytes: buffer.length,
      category: "report",
      tags: ["generated", `from:${template.slug}`],
      origin: "template",
      ownerId: null,
      taskId: null,
      parentId: template.fileId,
      version: 1,
      storagePath,
      checksum,
      encrypted: false,
      visibility: "agents",
      status: "active",
    });

    log.info("template generated", { template: template.name, fileId: entry.id });
    return { ok: true, content: filled, file: entry, message: "Generated from template" };
  } catch (err: any) {
    log.error("template generation failed", { template: template.name, error: err.message });
    return { ok: false, message: `Generation failed: ${err.message}` };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function extensionForMime(mimeType: string): string {
  const map: Record<string, string> = {
    "text/markdown": ".md",
    "text/plain": ".txt",
    "text/csv": ".csv",
    "application/json": ".json",
    "application/x-yaml": ".yaml",
    "application/pdf": ".pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  };
  return map[mimeType] ?? ".txt";
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
