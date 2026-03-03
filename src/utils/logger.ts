import { AsyncLocalStorage } from "node:async_hooks";
import { appendFile, stat, rename } from "node:fs/promises";
import { join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  namespace?: string;
  correlationId?: string;
  agentId?: string;
  taskId?: string;
  metadata?: Record<string, unknown>;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// Initialize from LOG_LEVEL env var, default to "debug"
const envLevel = (process.env.LOG_LEVEL ?? "debug").toLowerCase();
let minLevel: LogLevel = envLevel in LEVEL_PRIORITY ? (envLevel as LogLevel) : "debug";

// Pretty-print mode for development (LOG_FORMAT=pretty)
const prettyMode = process.env.LOG_FORMAT === "pretty";

const correlationStore = new AsyncLocalStorage<string>();

// Optional per-async-context metadata (agentId, taskId, etc.)
interface ContextMeta {
  correlationId?: string;
  agentId?: string;
  taskId?: string;
}
const contextStore = new AsyncLocalStorage<ContextMeta>();

export function setMinLevel(level: LogLevel): void {
  minLevel = level;
}

export function getCorrelationId(): string | undefined {
  return contextStore.getStore()?.correlationId ?? correlationStore.getStore();
}

export function runWithCorrelationId<T>(id: string, fn: () => T): T {
  return correlationStore.run(id, fn);
}

/**
 * Run a function with full context metadata (correlationId, agentId, taskId).
 * All loggers within the callback automatically attach these fields.
 */
export function runWithContext<T>(meta: ContextMeta, fn: () => T): T {
  return contextStore.run(meta, fn);
}

/** Get the current async context metadata. */
export function getContext(): ContextMeta | undefined {
  return contextStore.getStore();
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[minLevel];
}

// ── File rotation ────────────────────────────────────────────────────────────

interface FileRotationConfig {
  /** Log file path. */
  filePath: string;
  /** Max file size in bytes before rotation. Default: 10MB. */
  maxSizeBytes: number;
  /** Max number of rotated files to keep. Default: 3. */
  maxFiles: number;
}

let fileConfig: FileRotationConfig | null = null;
let rotationInProgress = false;

/**
 * Enable file-based logging with rotation.
 * Logs are written to the file AND to stdout/stderr.
 * Set LOG_FILE env var or call this to enable.
 */
export function enableFileLogging(config: Partial<FileRotationConfig> & { filePath: string }): void {
  fileConfig = {
    filePath: config.filePath,
    maxSizeBytes: config.maxSizeBytes ?? 10 * 1024 * 1024,
    maxFiles: config.maxFiles ?? 3,
  };
}

// Auto-enable from env
if (process.env.LOG_FILE) {
  enableFileLogging({ filePath: process.env.LOG_FILE });
}

async function rotateIfNeeded(): Promise<void> {
  if (!fileConfig || rotationInProgress) return;
  try {
    const stats = await stat(fileConfig.filePath).catch(() => null);
    if (!stats || stats.size < fileConfig.maxSizeBytes) return;

    rotationInProgress = true;

    // Rotate: .log -> .log.1, .log.1 -> .log.2, etc.
    for (let i = fileConfig.maxFiles - 1; i >= 1; i--) {
      const from = i === 1 ? fileConfig.filePath : `${fileConfig.filePath}.${i - 1}`;
      const to = `${fileConfig.filePath}.${i}`;
      await rename(from, to).catch(() => {});
    }
  } catch {
    // Rotation errors are non-fatal
  } finally {
    rotationInProgress = false;
  }
}

async function writeToFile(line: string): Promise<void> {
  if (!fileConfig) return;
  await appendFile(fileConfig.filePath, line + "\n", "utf-8").catch(() => {});
  // Check rotation in background (non-blocking)
  rotateIfNeeded().catch(() => {});
}

// ── Pretty formatting for development ────────────────────────────────────────

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: "\x1b[36m", // cyan
  info: "\x1b[32m",  // green
  warn: "\x1b[33m",  // yellow
  error: "\x1b[31m", // red
};
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

function formatPretty(entry: LogEntry): string {
  const time = entry.timestamp.slice(11, 23); // HH:MM:SS.mmm
  const color = LEVEL_COLORS[entry.level];
  const lvl = entry.level.toUpperCase().padEnd(5);
  const ns = entry.namespace ? ` ${DIM}[${entry.namespace}]${RESET}` : "";
  const cid = entry.correlationId ? ` ${DIM}cid=${entry.correlationId}${RESET}` : "";
  const aid = entry.agentId ? ` ${DIM}agent=${entry.agentId}${RESET}` : "";
  const tid = entry.taskId ? ` ${DIM}task=${entry.taskId}${RESET}` : "";
  const meta = entry.metadata ? ` ${DIM}${JSON.stringify(entry.metadata)}${RESET}` : "";
  return `${DIM}${time}${RESET} ${color}${lvl}${RESET}${ns}${cid}${aid}${tid} ${entry.message}${meta}`;
}

// ── Core write ───────────────────────────────────────────────────────────────

function write(entry: LogEntry): void {
  const isError = entry.level === "warn" || entry.level === "error";
  const stream = isError ? process.stderr : process.stdout;

  try {
    if (prettyMode) {
      stream.write(formatPretty(entry) + "\n");
    } else {
      stream.write(JSON.stringify(entry) + "\n");
    }
  } catch (err: unknown) {
    // Swallow EPIPE errors — the pipe reader (e.g. tsx watch) has disconnected.
    // Logging must never crash the application.
    if (!(err instanceof Error && (err as NodeJS.ErrnoException).code === "EPIPE")) {
      throw err; // Re-throw non-EPIPE errors
    }
  }

  // File logging (always JSON, regardless of pretty mode)
  if (fileConfig) {
    writeToFile(JSON.stringify(entry));
  }
}

function buildEntry(
  level: LogLevel,
  message: string,
  namespace?: string,
  metadata?: Record<string, unknown>,
): LogEntry {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
  };
  if (namespace) entry.namespace = namespace;

  // Pull context from async local storage
  const ctx = contextStore.getStore();
  const cid = ctx?.correlationId ?? correlationStore.getStore();
  if (cid) entry.correlationId = cid;
  if (ctx?.agentId) entry.agentId = ctx.agentId;
  if (ctx?.taskId) entry.taskId = ctx.taskId;

  if (metadata && Object.keys(metadata).length > 0) entry.metadata = metadata;
  return entry;
}

export interface Logger {
  debug(message: string, metadata?: Record<string, unknown>): void;
  info(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, metadata?: Record<string, unknown>): void;
  child(namespace: string): Logger;
}

function makeLogger(namespace?: string): Logger {
  const emit = (level: LogLevel, message: string, metadata?: Record<string, unknown>) => {
    if (!shouldLog(level)) return;
    write(buildEntry(level, message, namespace, metadata));
  };

  return {
    debug: (msg, meta) => emit("debug", msg, meta),
    info: (msg, meta) => emit("info", msg, meta),
    warn: (msg, meta) => emit("warn", msg, meta),
    error: (msg, meta) => emit("error", msg, meta),
    child: (ns) => makeLogger(namespace ? `${namespace}.${ns}` : ns),
  };
}

export const log = makeLogger();
export function createLogger(namespace: string): Logger {
  return makeLogger(namespace);
}
