/**
 * File upload validation pipeline — DASH-65.
 * Filename sanitization, extension allowlist, magic byte detection, content scan.
 * Never throws — returns ValidationResult.
 */

import { createLogger } from "../utils/logger.js";
import type { ValidationResult } from "./types.js";

const log = createLogger("files.validate");

// ── MIME type allowlist ─────────────────────────────────────────────────────

export const ALLOWED_MIME_TYPES: Record<string, string[]> = {
  // Documents
  "application/pdf": [".pdf"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": [".pptx"],
  "text/plain": [".txt", ".log", ".csv", ".md"],
  "text/markdown": [".md"],
  "text/csv": [".csv"],
  "application/json": [".json"],
  "application/x-yaml": [".yaml", ".yml"],
  // Images
  "image/png": [".png"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/webp": [".webp"],
  "image/gif": [".gif"],
  "image/svg+xml": [".svg"],
  // Audio
  "audio/wav": [".wav"],
  "audio/mpeg": [".mp3"],
  "audio/webm": [".webm"],
  "audio/ogg": [".ogg"],
  // Archives
  "application/zip": [".zip"],
};

/** All allowed extensions (flat set for quick lookup). */
const ALLOWED_EXTENSIONS = new Set(
  Object.values(ALLOWED_MIME_TYPES).flat(),
);

// ── Magic byte signatures ───────────────────────────────────────────────────

interface MagicSignature {
  mime: string;
  bytes: number[];
  offset?: number;
}

const MAGIC_SIGNATURES: MagicSignature[] = [
  { mime: "application/pdf", bytes: [0x25, 0x50, 0x44, 0x46] },           // %PDF
  { mime: "image/png", bytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] },
  { mime: "image/jpeg", bytes: [0xFF, 0xD8, 0xFF] },
  { mime: "image/gif", bytes: [0x47, 0x49, 0x46, 0x38] },                 // GIF8
  { mime: "image/webp", bytes: [0x52, 0x49, 0x46, 0x46], offset: 0 },     // RIFF (check "WEBP" at offset 8)
  { mime: "application/zip", bytes: [0x50, 0x4B, 0x03, 0x04] },           // PK
  { mime: "audio/ogg", bytes: [0x4F, 0x67, 0x67, 0x53] },                 // OggS
  // ID3 tag for MP3
  { mime: "audio/mpeg", bytes: [0x49, 0x44, 0x33] },                      // ID3
  // RIFF for WAV
  { mime: "audio/wav", bytes: [0x52, 0x49, 0x46, 0x46] },
];

/** Detect MIME type from file header bytes. */
function detectMimeFromBytes(buffer: Buffer): string | null {
  for (const sig of MAGIC_SIGNATURES) {
    const offset = sig.offset ?? 0;
    if (buffer.length < offset + sig.bytes.length) continue;
    const match = sig.bytes.every((b, i) => buffer[offset + i] === b);
    if (!match) continue;

    // Disambiguate RIFF containers (WAV vs WebP)
    if (sig.mime === "audio/wav" || sig.mime === "image/webp") {
      if (buffer.length >= 12) {
        const tag = buffer.subarray(8, 12).toString("ascii");
        if (tag === "WEBP") return "image/webp";
        if (tag === "WAVE") return "audio/wav";
      }
      continue;
    }

    return sig.mime;
  }

  // DOCX/XLSX/PPTX are ZIP-based — check for PK header
  if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4B) {
    return "application/zip"; // Caller checks extension for OOXML types
  }

  return null;
}

// ── Filename sanitization ───────────────────────────────────────────────────

/** Slugify a filename for storage paths (keep extension separate). */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9.\-_]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 200);
}

function sanitizeFilename(name: string): string {
  // Strip path traversal and control chars
  let clean = name
    .replace(/\.\./g, "")
    .replace(/[/\\]/g, "")
    .replace(/[\x00-\x1F\x7F]/g, "")
    .trim();

  // Truncate to 255 chars
  if (clean.length > 255) clean = clean.slice(0, 255);

  // Fallback for empty result
  if (!clean) clean = "unnamed";

  return clean;
}

function getExtension(name: string): string {
  const lastDot = name.lastIndexOf(".");
  if (lastDot <= 0) return "";
  return name.slice(lastDot).toLowerCase();
}

// ── SVG sanitization ────────────────────────────────────────────────────────

function sanitizeSvg(content: string): string {
  return content
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
    .replace(/\bon\w+\s*=/gi, "data-removed=")
    .replace(/javascript\s*:/gi, "removed:");
}

// ── Main validation ─────────────────────────────────────────────────────────

export async function validateUpload(
  buffer: Buffer,
  originalName: string,
  declaredMime: string,
  maxUploadBytes: number,
): Promise<ValidationResult> {
  const sanitizedName = sanitizeFilename(originalName);
  const ext = getExtension(sanitizedName);

  // 1. Extension check
  if (!ext) {
    return { valid: false, rejected: "No file extension", sanitizedName, detectedMime: "", detectedExt: "" };
  }
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return { valid: false, rejected: `Extension not allowed: ${ext}`, sanitizedName, detectedMime: "", detectedExt: ext };
  }

  // 2. Double extension check (e.g., .pdf.exe)
  const parts = sanitizedName.split(".");
  if (parts.length > 2) {
    const suspiciousExts = [".exe", ".bat", ".cmd", ".com", ".scr", ".pif", ".vbs", ".js", ".ws", ".msi"];
    for (const part of parts.slice(1)) {
      if (suspiciousExts.includes("." + part.toLowerCase())) {
        return { valid: false, rejected: `Suspicious double extension detected`, sanitizedName, detectedMime: "", detectedExt: ext };
      }
    }
  }

  // 3. Size check
  if (buffer.length > maxUploadBytes) {
    const sizeMB = (buffer.length / (1024 * 1024)).toFixed(1);
    const limitMB = (maxUploadBytes / (1024 * 1024)).toFixed(1);
    return { valid: false, rejected: `File too large: ${sizeMB} MB (limit: ${limitMB} MB)`, sanitizedName, detectedMime: declaredMime, detectedExt: ext };
  }

  // 4. Magic byte verification
  const detectedMime = detectMimeFromBytes(buffer);

  // Text files won't have magic bytes — that's OK
  const textExts = new Set([".txt", ".log", ".csv", ".md", ".json", ".yaml", ".yml", ".svg"]);
  const isTextExt = textExts.has(ext);

  if (detectedMime && !isTextExt) {
    // OOXML files are ZIP-based — verify extension matches
    const ooxmlExts: Record<string, string> = {
      ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    };
    if (detectedMime === "application/zip" && ooxmlExts[ext]) {
      // ZIP-based OOXML — trust the extension
    } else {
      // Check declared MIME category matches detected
      const declaredBase = declaredMime.split("/")[0];
      const detectedBase = detectedMime.split("/")[0];
      if (declaredBase !== detectedBase && detectedBase !== "application") {
        log.warn("MIME mismatch detected", { declared: declaredMime, detected: detectedMime, name: sanitizedName });
        return {
          valid: false,
          rejected: `File type mismatch: declared ${declaredMime} but detected ${detectedMime}`,
          sanitizedName,
          detectedMime,
          detectedExt: ext,
        };
      }
    }
  }

  // 5. Content scan for text files
  if (isTextExt) {
    const text = buffer.toString("utf-8");
    // Reject binary masquerading as text
    if (text.includes("\0") && ext !== ".json") {
      return { valid: false, rejected: "Binary content in text file", sanitizedName, detectedMime: declaredMime, detectedExt: ext };
    }
    // SVG script stripping (sanitize in place — caller should use sanitized buffer)
    if (ext === ".svg") {
      const hasDangerousContent =
        /<script/i.test(text) ||
        /on\w+\s*=/i.test(text) ||
        /javascript\s*:/i.test(text);
      if (hasDangerousContent) {
        log.warn("SVG sanitized — dangerous content stripped", { name: sanitizedName });
      }
    }
  }

  const resolvedMime = detectedMime ?? declaredMime;

  log.debug("upload validated", { name: sanitizedName, mime: resolvedMime, size: buffer.length });
  return {
    valid: true,
    sanitizedName,
    detectedMime: resolvedMime,
    detectedExt: ext,
  };
}

/** Sanitize SVG buffer content, returning new buffer. */
export function sanitizeSvgBuffer(buffer: Buffer): Buffer {
  const sanitized = sanitizeSvg(buffer.toString("utf-8"));
  return Buffer.from(sanitized, "utf-8");
}

/** Resolve the canonical MIME type for a given extension. */
export function mimeForExtension(ext: string): string {
  for (const [mime, exts] of Object.entries(ALLOWED_MIME_TYPES)) {
    if (exts.includes(ext)) return mime;
  }
  return "application/octet-stream";
}
