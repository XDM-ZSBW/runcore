#!/usr/bin/env node
/**
 * Core Brain MCP Server — exposes Brain memory and knowledge to Claude Code.
 * stdio-only transport. No network port. All logging to stderr.
 *
 * Tools: memory_retrieve, memory_learn, memory_list, read_brain_file,
 *        get_settings, list_locked, list_rooms
 * Resources: brain://memory/*, brain://identity, brain://operations
 */

import { resolve, normalize, join } from "node:path";
import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { Brain } from "./brain.js";
import { FileSystemLongTermMemory } from "./memory/file-backed.js";
import { readBrainFile, readBrainLines } from "./lib/brain-io.js";
import { setEncryptionKey, setWriteEncryptionEnabled } from "./lib/key-store.js";
import { loadSettings, getSettings } from "./settings.js";
import type { LongTermMemoryType, MemoryEntry } from "./types.js";
import { issueVoucher, checkVoucher } from "./voucher.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const BRAIN_DIR = resolve(process.cwd(), "brain");
const MEMORY_DIR = join(BRAIN_DIR, "memory");

/** Log to stderr so stdout stays clean for MCP protocol. */
function log(msg: string): void {
  process.stderr.write(`[core-brain-mcp] ${msg}\n`);
}

/** Hardcoded minimum locked paths (always locked even without .locked file). */
const HARDCODED_LOCKED = [".session-key", "human.json"];

const LOCKED_FILE = join(BRAIN_DIR, ".locked");

/** Cached locked paths (relative to brain/, forward slashes). */
let lockedPaths: string[] = [];

/** Read brain/.locked and merge with hardcoded minimums. Cache result. */
async function loadLockedPaths(): Promise<string[]> {
  const paths = new Set<string>(HARDCODED_LOCKED);
  try {
    const raw = await readFile(LOCKED_FILE, "utf-8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      paths.add(trimmed.replace(/\\/g, "/"));
    }
  } catch {
    // .locked file doesn't exist — use hardcoded only
  }
  lockedPaths = Array.from(paths);
  return lockedPaths;
}

/**
 * Check if a relative path (forward slashes) is locked.
 * Matches exact paths and directory prefixes.
 */
function isLocked(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/");
  for (const locked of lockedPaths) {
    // Exact match
    if (normalized === locked) return true;
    // Filename-only match (e.g. ".session-key" matches "identity/.session-key")
    const filename = normalized.split("/").pop() ?? "";
    if (filename === locked) return true;
    // Directory prefix match (e.g. locked="identity/" matches "identity/foo.md")
    if (locked.endsWith("/") && normalized.startsWith(locked)) return true;
  }
  return false;
}

/**
 * Resolve a relative path under brain/, guarding against traversal.
 * Returns the absolute path or throws if it escapes brain/ or is locked.
 */
function resolveBrainPath(relativePath: string): string {
  const cleaned = normalize(relativePath).replace(/^[/\\]+/, "");
  const full = resolve(BRAIN_DIR, cleaned);
  if (!full.startsWith(BRAIN_DIR)) {
    throw new Error("Path traversal blocked");
  }
  const relForward = cleaned.replace(/\\/g, "/");
  if (isLocked(relForward)) {
    throw new Error(`🔒 Locked: ${relForward} — ask Dash to unlock if needed`);
  }
  return full;
}

/** Format memory entries for display. */
function formatEntries(entries: MemoryEntry[]): string {
  if (entries.length === 0) return "No entries found.";
  return entries
    .map(
      (e) =>
        `[${e.id}] (${e.type}) ${e.createdAt}\n${e.content}${e.meta ? "\nmeta: " + JSON.stringify(e.meta) : ""}`
    )
    .join("\n\n---\n\n");
}

// ── Startup ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log("Starting...");

  // 1. Load settings
  const settings = await loadSettings();
  log(`Instance: ${settings.instanceName ?? "Core"}`);

  // 2. Load locked paths
  await loadLockedPaths();
  log(`Locked paths: ${lockedPaths.length}`);

  // 3. Read session key if available
  const keyPath = join(BRAIN_DIR, "identity", ".session-key");
  let encryptionKey: Buffer | undefined;
  if (existsSync(keyPath)) {
    try {
      const hex = (await readFile(keyPath, "utf-8")).trim();
      if (/^[0-9a-f]{64}$/i.test(hex)) {
        encryptionKey = Buffer.from(hex, "hex");
        setEncryptionKey(encryptionKey);
        log("Encryption key loaded");
      }
    } catch {
      log("Could not read session key — running without encryption");
    }
  }

  // 4. Honor encryptBrainFiles setting
  setWriteEncryptionEnabled(settings.encryptBrainFiles);

  // 5. Construct LTM + Brain
  const ltm = new FileSystemLongTermMemory(MEMORY_DIR, encryptionKey);
  await ltm.init();
  log("LTM initialized");

  const brain = new Brain(
    { systemPrompt: "Core Brain MCP", maxRetrieved: 20 },
    ltm
  );

  // 6. Create MCP server
  const mcp = new McpServer({
    name: "core-brain",
    version: "0.1.0",
  });

  // ── Hallway scan: read all unlocked JSONL files in brain/memory/ ─────────

  /** Scan all JSONL files in memory dir, parse entries, skip locked files. */
  async function hallwayScanMemory(): Promise<MemoryEntry[]> {
    const files = await readdir(MEMORY_DIR);
    const jsonlFiles = files.filter(
      (f) => f.endsWith(".jsonl") && f !== "embeddings.jsonl"
    );

    const all: MemoryEntry[] = [];
    for (const file of jsonlFiles) {
      const relPath = `memory/${file}`;
      if (isLocked(relPath)) continue;
      const lines = await readBrainLines(join(MEMORY_DIR, file));
      const archived = new Set<string>();
      for (const line of lines) {
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;
          if (obj._schema) continue;
          if (obj.status === "archived" && typeof obj.id === "string") {
            archived.add(obj.id);
            continue;
          }
          all.push(obj as unknown as MemoryEntry);
        } catch { continue; }
      }
      // Remove archived entries
      for (let i = all.length - 1; i >= 0; i--) {
        if (archived.has(all[i].id)) all.splice(i, 1);
      }
    }
    return all.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  // ── Tools ────────────────────────────────────────────────────────────────

  mcp.tool(
    "memory_retrieve",
    "Search long-term memory by query, with optional type filter",
    {
      query: z.string().max(500).describe("Search query"),
      type: z.enum(["episodic", "semantic", "procedural"]).optional().describe("Filter by memory type"),
      max: z.number().int().min(1).max(50).optional().describe("Max results (default 10)"),
    },
    async ({ query, type, max }) => {
      const maxResults = max ?? 10;

      // If type-filtered, use Brain's existing LTM (3-file) retrieval
      if (type) {
        const entries = await brain.retrieve(query, {
          type: type as LongTermMemoryType,
          max: maxResults,
        });
        return { content: [{ type: "text" as const, text: formatEntries(entries) }] };
      }

      // Otherwise, search across ALL unlocked JSONL files
      const all = await hallwayScanMemory();
      const terms = query
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length > 2);
      let results = all;
      if (terms.length > 0) {
        results = all.filter((e) =>
          e.content && terms.some((term) => e.content.toLowerCase().includes(term))
        );
      }
      return {
        content: [{ type: "text" as const, text: formatEntries(results.slice(0, maxResults)) }],
      };
    }
  );

  mcp.tool(
    "memory_learn",
    "Append a new entry to long-term memory (episodic, semantic, or procedural)",
    {
      type: z.enum(["episodic", "semantic", "procedural"]).describe("Memory type"),
      content: z.string().min(1).max(10000).describe("Content to store"),
      meta: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe("Optional metadata"),
    },
    async ({ type, content, meta }) => {
      const entry = await brain.learn({
        type: type as LongTermMemoryType,
        content,
        meta: meta as Record<string, string | number | boolean> | undefined,
      });
      return {
        content: [
          { type: "text" as const, text: `Stored as ${entry.id} (${entry.type}) at ${entry.createdAt}` },
        ],
      };
    }
  );

  mcp.tool(
    "memory_list",
    "List memory entries by type, most recent first",
    {
      type: z.enum(["episodic", "semantic", "procedural"]).optional().describe("Filter by type (omit for all)"),
      limit: z.number().int().min(1).max(100).optional().describe("Max entries (default 20)"),
    },
    async ({ type, limit }) => {
      // If type-filtered, use LTM's 3-file scope
      if (type) {
        const entries = await ltm.list(type as LongTermMemoryType);
        const sliced = entries.slice(0, limit ?? 20);
        return { content: [{ type: "text" as const, text: formatEntries(sliced) }] };
      }
      // Otherwise, scan all unlocked JSONL files
      const entries = await hallwayScanMemory();
      const sliced = entries.slice(0, limit ?? 20);
      return { content: [{ type: "text" as const, text: formatEntries(sliced) }] };
    }
  );

  mcp.tool(
    "read_brain_file",
    "Read any file under brain/ (path-guarded, encrypted files auto-decrypted)",
    {
      path: z.string().max(500).describe("Relative path under brain/, e.g. 'operations/goals.yaml'"),
    },
    async ({ path }) => {
      try {
        const fullPath = resolveBrainPath(path);
        const content = await readBrainFile(fullPath);
        return { content: [{ type: "text" as const, text: content }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error: ${msg}` }],
          isError: true,
        };
      }
    }
  );

  mcp.tool(
    "get_settings",
    "Return safe subset of Core settings (no keys or secrets)",
    {},
    async () => {
      const s = getSettings();
      const safe = {
        instanceName: s.instanceName,
        airplaneMode: s.airplaneMode,
        encryptBrainFiles: s.encryptBrainFiles,
        models: s.models,
        pulse: s.pulse,
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(safe, null, 2) }],
      };
    }
  );

  mcp.tool(
    "list_locked",
    "Show all currently locked paths in brain/.locked",
    {},
    async () => {
      // Re-read in case it changed
      await loadLockedPaths();
      const lines = lockedPaths.length > 0
        ? lockedPaths.map((p) => `🔒 ${p}`).join("\n")
        : "No locked paths.";
      return { content: [{ type: "text" as const, text: lines }] };
    }
  );

  mcp.tool(
    "list_rooms",
    "List all files/dirs under brain/ with their locked status",
    {},
    async () => {
      // Re-read locked paths fresh
      await loadLockedPaths();

      async function walk(dir: string, prefix: string): Promise<string[]> {
        const items: string[] = [];
        let entries: string[];
        try {
          entries = await readdir(dir);
        } catch {
          return items;
        }
        for (const name of entries.sort()) {
          const relPath = prefix ? `${prefix}/${name}` : name;
          const fullPath = join(dir, name);
          const locked = isLocked(relPath);
          const icon = locked ? "🔒" : "📄";
          try {
            const s = await stat(fullPath);
            if (s.isDirectory()) {
              items.push(`${locked ? "🔒" : "📁"} ${relPath}/`);
              if (!locked) {
                const children = await walk(fullPath, relPath);
                items.push(...children);
              }
            } else {
              items.push(`${icon} ${relPath}`);
            }
          } catch {
            items.push(`❌ ${relPath} (unreadable)`);
          }
        }
        return items;
      }

      const tree = await walk(BRAIN_DIR, "");
      return {
        content: [{ type: "text" as const, text: tree.join("\n") || "Empty brain directory." }],
      };
    }
  );

  // ── Voucher tools ───────────────────────────────────────────────────────

  mcp.tool(
    "voucher_issue",
    "Issue a short-lived voucher token for brain-to-brain verification",
    {
      scope: z.string().optional().describe("What the voucher authorizes (e.g. 'read:settings')"),
      ttlMinutes: z.number().int().min(1).max(1440).optional().describe("Time-to-live in minutes (default 30)"),
    },
    async ({ scope, ttlMinutes }) => {
      const token = await issueVoucher(ltm, scope, ttlMinutes);
      return {
        content: [{ type: "text" as const, text: `Voucher issued: ${token}${scope ? ` (scope: ${scope})` : ""}\nExpires in ${ttlMinutes ?? 30} minutes. Carry this token to the other brain.` }],
      };
    }
  );

  mcp.tool(
    "voucher_check",
    "Verify a voucher token carried from another brain",
    {
      token: z.string().describe("The voucher token to verify (e.g. 'vch_a8f3x9b2')"),
    },
    async ({ token }) => {
      const result = await checkVoucher(ltm, token);
      if (result.valid) {
        return {
          content: [{ type: "text" as const, text: `Valid voucher.${result.scope ? ` Scope: ${result.scope}` : " No scope restriction."}` }],
        };
      }
      return {
        content: [{ type: "text" as const, text: "Invalid or expired voucher. Request denied." }],
      };
    }
  );

  // ── Resources ────────────────────────────────────────────────────────────

  for (const memType of ["episodic", "semantic", "procedural"] as const) {
    mcp.resource(
      `memory-${memType}`,
      `brain://memory/${memType}`,
      { description: `All ${memType} memories` },
      async () => {
        const entries = await ltm.list(memType);
        return {
          contents: [
            {
              uri: `brain://memory/${memType}`,
              text: formatEntries(entries),
              mimeType: "text/plain",
            },
          ],
        };
      }
    );
  }

  mcp.resource(
    "identity",
    "brain://identity",
    { description: "Tone of voice, brand, personality" },
    async () => {
      const identityDir = join(BRAIN_DIR, "identity");
      let text = "";
      try {
        const files = await readdir(identityDir);
        for (const f of files) {
          if (f.startsWith(".")) continue; // skip hidden files like .session-key
          try {
            const content = await readBrainFile(join(identityDir, f));
            text += `--- ${f} ---\n${content}\n\n`;
          } catch { /* skip unreadable */ }
        }
      } catch {
        text = "Identity directory not found.";
      }
      return {
        contents: [
          { uri: "brain://identity", text: text || "No identity files found.", mimeType: "text/plain" },
        ],
      };
    }
  );

  mcp.resource(
    "operations",
    "brain://operations",
    { description: "Goals, todos, operational state" },
    async () => {
      const opsDir = join(BRAIN_DIR, "operations");
      let text = "";
      try {
        const files = await readdir(opsDir);
        for (const f of files) {
          if (f.startsWith(".")) continue;
          try {
            const content = await readBrainFile(join(opsDir, f));
            text += `--- ${f} ---\n${content}\n\n`;
          } catch { /* skip unreadable */ }
        }
      } catch {
        text = "Operations directory not found.";
      }
      return {
        contents: [
          { uri: "brain://operations", text: text || "No operations files found.", mimeType: "text/plain" },
        ],
      };
    }
  );

  // ── Connect ──────────────────────────────────────────────────────────────

  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  log("Connected via stdio — ready");
}

main().catch((err) => {
  process.stderr.write(`[core-brain-mcp] Fatal: ${err}\n`);
  process.exit(1);
});
