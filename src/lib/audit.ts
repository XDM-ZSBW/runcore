/**
 * Audit logging for brain file access.
 * Appends access records to brain/ops/audit.jsonl.
 * Uses AsyncLocalStorage to track caller identity (MCP tool, HTTP route, etc.).
 *
 * Fire-and-forget — audit failures never block or crash the caller.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { appendFile, mkdir } from "node:fs/promises";
import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { createLogger } from "../utils/logger.js";

const log = createLogger("audit");

// ── Types ────────────────────────────────────────────────────────────────────

export interface AuditEntry {
  timestamp: string;
  /** Relative path under brain/, e.g. "memory/semantic.jsonl" */
  file: string;
  /** How the file was read */
  method: "readBrainFile" | "readBrainLines" | "readBrainLinesSync";
  /** Who requested the access */
  caller?: string;
  /** Access channel */
  channel?: "mcp" | "http" | "direct";
}

export interface AuditContext {
  /** Human-readable caller identity, e.g. "mcp:memory_retrieve", "http:GET /api/personality" */
  caller: string;
  /** Access channel */
  channel: "mcp" | "http" | "direct";
}

// ── Caller context via AsyncLocalStorage ─────────────────────────────────────

const auditContextStore = new AsyncLocalStorage<AuditContext>();

/**
 * Run a function with audit context. All brain file reads within the callback
 * will be tagged with the given caller and channel.
 */
export function runWithAuditContext<T>(ctx: AuditContext, fn: () => T): T {
  return auditContextStore.run(ctx, fn);
}

/** Get the current audit context (if set). */
export function getAuditContext(): AuditContext | undefined {
  return auditContextStore.getStore();
}

// ── File setup ───────────────────────────────────────────────────────────────

const BRAIN_DIR = join(process.cwd(), "brain");
const OPS_DIR = join(BRAIN_DIR, "ops");
const AUDIT_FILE = join(OPS_DIR, "audit.jsonl");
const SCHEMA_LINE = JSON.stringify({
  _schema: "audit",
  _version: "1.0",
  _fields: "timestamp,file,method,caller,channel",
});

let fileEnsured = false;

function ensureFile(): void {
  if (fileEnsured) return;
  try {
    if (!existsSync(OPS_DIR)) {
      mkdirSync(OPS_DIR, { recursive: true });
    }
    if (!existsSync(AUDIT_FILE)) {
      appendFileSync(AUDIT_FILE, SCHEMA_LINE + "\n", "utf-8");
    }
    fileEnsured = true;
  } catch (err) {
    log.debug(`Failed to ensure audit file: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Core logging ─────────────────────────────────────────────────────────────

/**
 * Resolve a full path to a relative brain path for cleaner logs.
 * Returns the path as-is if it's not under brain/.
 */
function toBrainRelative(filePath: string): string {
  try {
    const rel = relative(BRAIN_DIR, filePath);
    // If the relative path escapes brain/, return the original
    if (rel.startsWith("..") || rel.startsWith("/")) return filePath;
    return rel.replace(/\\/g, "/");
  } catch {
    return filePath;
  }
}

/**
 * Log a brain file read. Fire-and-forget (async).
 * Skips logging reads of the audit file itself to avoid recursion.
 */
export function logAccess(
  filePath: string,
  method: AuditEntry["method"],
): void {
  // Prevent recursive audit of the audit file
  if (filePath === AUDIT_FILE) return;

  const ctx = auditContextStore.getStore();
  const entry: AuditEntry = {
    timestamp: new Date().toISOString(),
    file: toBrainRelative(filePath),
    method,
    caller: ctx?.caller,
    channel: ctx?.channel,
  };

  try {
    ensureFile();
    const line = JSON.stringify(entry);
    // Async append — fire-and-forget
    appendFile(AUDIT_FILE, line + "\n", "utf-8").catch((err) => {
      log.debug(`Audit write failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  } catch (err) {
    log.debug(`Audit log error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Synchronous variant for use in readBrainLinesSync.
 */
export function logAccessSync(
  filePath: string,
  method: AuditEntry["method"],
): void {
  if (filePath === AUDIT_FILE) return;

  const ctx = auditContextStore.getStore();
  const entry: AuditEntry = {
    timestamp: new Date().toISOString(),
    file: toBrainRelative(filePath),
    method,
    caller: ctx?.caller,
    channel: ctx?.channel,
  };

  try {
    ensureFile();
    appendFileSync(AUDIT_FILE, JSON.stringify(entry) + "\n", "utf-8");
  } catch (err) {
    log.debug(`Audit sync write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
