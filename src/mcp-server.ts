#!/usr/bin/env node
/**
 * Core Brain MCP Server — exposes Brain memory and knowledge to Claude Code.
 * stdio-only transport. No network port. All logging to stderr.
 *
 * Tools: memory_retrieve, memory_learn, memory_list, read_brain_file,
 *        get_settings, list_locked, list_rooms, web_fetch
 * Resources: brain://memory/*, brain://identity, brain://operations
 */

import { resolve, normalize, join } from "node:path";
import { readdir, stat } from "node:fs/promises";

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { Brain } from "./brain.js";
import { FileSystemLongTermMemory } from "./memory/file-backed.js";
import { readBrainFile, readBrainLines } from "./lib/brain-io.js";
import { runWithAuditContext } from "./lib/audit.js";
import {
  loadLockedPaths as loadLockedPathsCentral,
  reloadLockedPaths,
  isLocked,
  getLockedPaths,
} from "./lib/locked.js";
import { setEncryptionKey, setWriteEncryptionEnabled } from "./lib/key-store.js";
import { loadSettings, getSettings } from "./settings.js";
import type { LongTermMemoryType, MemoryEntry } from "./types.js";
import { issueVoucher, checkVoucherWithAlert, setVoucherAlertFn } from "./voucher.js";
import { sendAlert } from "./alert.js";
import { Crystallizer, scoreEntry } from "./crystallizer.js";
// credentials is byok-tier — dynamic import
import { readSessionKey, isDpapiAvailable } from "./lib/dpapi.js";
import { BrainRAG } from "./search/brain-rag.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

import { BRAIN_DIR, resolveBrainDir, FILES_DIR } from "./lib/paths.js";
const MEMORY_DIR = resolveBrainDir("memory");

/** Log to stderr so stdout stays clean for MCP protocol. */
function log(msg: string): void {
  process.stderr.write(`[core-brain-mcp] ${msg}\n`);
}

/** Lightweight HTML → markdown. Strips tags, converts common elements. */
function htmlToMarkdown(html: string): string {
  let s = html;
  // Remove script, style, head blocks entirely
  s = s.replace(/<script[\s\S]*?<\/script>/gi, "");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, "");
  s = s.replace(/<head[\s\S]*?<\/head>/gi, "");
  // Convert common block elements
  s = s.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n");
  s = s.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n");
  s = s.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n");
  s = s.replace(/<h[4-6][^>]*>([\s\S]*?)<\/h[4-6]>/gi, "\n#### $1\n");
  s = s.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, "\n$1\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<hr\s*\/?>/gi, "\n---\n");
  // Inline formatting
  s = s.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**");
  s = s.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*");
  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, "\n```\n$1\n```\n");
  // Links and images
  s = s.replace(/<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)");
  s = s.replace(/<img[^>]+alt="([^"]*)"[^>]*>/gi, "![$1]");
  // Lists
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n");
  s = s.replace(/<\/?(ul|ol|dl|dt|dd|nav|header|footer|main|article|section|aside|div|span|table|thead|tbody|tr|td|th|figure|figcaption|blockquote)[^>]*>/gi, "\n");
  // Strip remaining tags
  s = s.replace(/<[^>]+>/g, "");
  // Decode common entities
  s = s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
       .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
  // Collapse whitespace
  s = s.replace(/\n{3,}/g, "\n\n").trim();
  return s;
}

/**
 * Resolve a relative path under brain/, guarding against traversal.
 * Returns the absolute path or throws if it escapes brain/.
 * Lock checking is now handled by brain-io functions via the centralized guard.
 */
function resolveBrainPath(relativePath: string): string {
  const cleaned = normalize(relativePath).replace(/^[/\\]+/, "");
  const full = resolve(BRAIN_DIR, cleaned);
  if (!full.startsWith(BRAIN_DIR)) {
    throw new Error("Path traversal blocked");
  }
  return full;
}

/** Format memory entries for display. */
function formatEntries(entries: MemoryEntry[]): string {
  if (entries.length === 0) return "No entries found.";
  return entries
    .filter((e) => e.content) // skip entries with no content (failed decrypt, etc.)
    .map((e) => {
      const date = e.createdAt ? formatDate(e.createdAt) : "unknown date";
      const metaParts: string[] = [];
      if (e.meta) {
        if (e.meta.tags) metaParts.push(`tags: ${e.meta.tags}`);
        if (e.meta.emotional_weight) metaParts.push(`weight: ${e.meta.emotional_weight}/10`);
        for (const [k, v] of Object.entries(e.meta)) {
          if (k === "tags" || k === "emotional_weight" || k === "status") continue;
          metaParts.push(`${k}: ${v}`);
        }
      }
      const meta = metaParts.length > 0 ? ` (${metaParts.join(", ")})` : "";
      return `**${e.type}** — ${date}${meta}\n${e.content}`;
    })
    .join("\n\n---\n\n") || "No readable entries found.";
}

/** Format ISO date to readable string. */
function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}


// ── Startup ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log("Starting...");

  // 1. Load settings
  const settings = await loadSettings();
  log(`Instance: ${settings.instanceName ?? "Core"}`);

  // 2. Load locked paths (centralized guard)
  const lockedPaths = await loadLockedPathsCentral();
  log(`Locked paths: ${lockedPaths.length}`);

  // 3. Read session key (DPAPI-protected if available, plaintext fallback)
  const keyPath = join(BRAIN_DIR, "identity", ".session-key");
  let encryptionKey: Buffer | undefined;
  try {
    const key = await readSessionKey(keyPath);
    if (key) {
      encryptionKey = key;
      setEncryptionKey(encryptionKey);
      log(`Encryption key loaded (DPAPI: ${isDpapiAvailable() ? "yes" : "no"})`);
    }
  } catch {
    log("Could not read session key — running without encryption");
  }

  // 4. Honor encryptBrainFiles setting
  setWriteEncryptionEnabled(settings.encryptBrainFiles);

  // 4b. Hydrate credentials into process.env (encrypted at rest)
  try {
    const { createCredentialStore } = await import("./credentials/store.js");
    const credStore = createCredentialStore(BRAIN_DIR);
    const hydrated = await credStore.hydrate();
    log(`Credentials hydrated: ${hydrated}`);
  } catch {
    log("Credentials module not available (requires BYOK tier)");
  }

  // 5. Construct LTM + Brain
  const ltm = new FileSystemLongTermMemory(MEMORY_DIR, encryptionKey);
  await ltm.init();
  log("LTM initialized");

  // Wire voucher failure alerts to the alert system
  setVoucherAlertFn((subject, body) => sendAlert(subject, body));

  const brain = new Brain(
    { systemPrompt: "Core Brain MCP", maxRetrieved: 20 },
    ltm
  );

  // 7. Initialize crystallizer — open loops as standing queries
  const crystallizer = new Crystallizer(MEMORY_DIR, async (event) => {
    // Precipitation callback: write notification + log
    const notifPath = resolve(BRAIN_DIR, "operations", "notifications.jsonl");
    const notif = {
      timestamp: new Date().toISOString(),
      source: "crystallizer",
      message: `Loop precipitated: "${event.query}" — ${event.evidenceCount} pieces of evidence collected. Context: ${event.context}`,
      loopId: event.loopId,
      id: Math.random().toString(36).slice(2, 10),
    };
    try {
      const { appendFile } = await import("node:fs/promises");
      await appendFile(notifPath, JSON.stringify(notif) + "\n", "utf-8");
    } catch { /* fire and forget */ }
    log(`Loop precipitated: "${event.query}" (${event.evidenceCount} evidence)`);
  });
  await crystallizer.init();
  log(`Open loops loaded: ${crystallizer.list("open").length} active`);

  // 6b. Initialize Brain RAG (semantic file search)
  const mcpRag = new BrainRAG();
  await mcpRag.load(); // Load existing embeddings (fast, no Ollama needed)
  log(`Brain RAG loaded: ${mcpRag.ready ? "ready" : "empty"}`);
  // Background index — catch up on any changed files
  mcpRag.indexAll().then((r) => {
    log(`Brain RAG index: ${r.indexed} indexed, ${r.skipped} skipped, ${r.errors} errors`);
  }).catch((err) => {
    log(`Brain RAG index failed: ${err instanceof Error ? err.message : String(err)}`);
  });

  // 6. Create MCP server
  const mcp = new McpServer({
    name: "core-brain",
    version: "0.1.0",
  });

  // ── Hallway scan: read all unlocked JSONL files in brain/memory/ ─────────

  /** Scan all JSONL files in memory dir, parse entries, skip locked files. */
  /** Map filename to memory type for legacy entries that lack a `type` field. */
  const FILE_TO_TYPE: Record<string, LongTermMemoryType> = {
    "experiences.jsonl": "episodic",
    "decisions.jsonl": "episodic",
    "failures.jsonl": "episodic",
    "semantic.jsonl": "semantic",
    "procedural.jsonl": "procedural",
  };

  /**
   * Normalize a raw JSONL object into a MemoryEntry.
   * Legacy entries (experiences, decisions, failures) use `date`/`summary`/`context`
   * while runtime entries use `createdAt`/`content`/`type`.
   */
  function normalizeEntry(obj: Record<string, unknown>, fileName: string): MemoryEntry {
    const type = (typeof obj.type === "string" ? obj.type : FILE_TO_TYPE[fileName] ?? "episodic") as LongTermMemoryType;
    const content =
      (typeof obj.content === "string" ? obj.content : null) ??
      (typeof obj.summary === "string" ? obj.summary : null) ??
      (typeof obj.context === "string" ? obj.context : null) ??
      (typeof obj.reasoning === "string" ? obj.reasoning : null) ??
      "";
    const createdAt =
      (typeof obj.createdAt === "string" ? obj.createdAt : null) ??
      (typeof obj.date === "string" ? obj.date : null) ??
      "";
    const id = (typeof obj.id === "string" ? obj.id : null) ?? `${fileName}:${createdAt || Math.random()}`;

    // Collect extra fields as meta
    const meta: Record<string, string | number | boolean> = obj.meta
      ? { ...(obj.meta as Record<string, string | number | boolean>) }
      : {};
    if (typeof obj.tags === "string") meta.tags = obj.tags;
    if (typeof obj.emotional_weight === "number") meta.emotional_weight = obj.emotional_weight;
    if (typeof obj.root_cause === "string") meta.root_cause = obj.root_cause;
    if (typeof obj.prevention === "string") meta.prevention = obj.prevention;
    if (typeof obj.outcome === "string") meta.outcome = obj.outcome;
    if (typeof obj.source === "string") meta.source = obj.source;

    return { id, type, content, createdAt, meta: Object.keys(meta).length > 0 ? meta : undefined };
  }

  async function hallwayScanMemory(): Promise<MemoryEntry[]> {
    const files = await readdir(MEMORY_DIR);
    const jsonlFiles = files.filter(
      (f) => f.endsWith(".jsonl") && f !== "embeddings.jsonl"
    );

    const all: MemoryEntry[] = [];
    for (const file of jsonlFiles) {
      const relPath = `memory/${file}`;
      if (isLocked(relPath)) continue;
      let lines: string[];
      try {
        lines = await readBrainLines(join(MEMORY_DIR, file));
      } catch (err) {
        log(`hallwayScan: skipping ${file} — ${err instanceof Error ? err.message : err}`);
        continue;
      }
      const archived = new Set<string>();
      for (const line of lines) {
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;
          if (obj._schema) continue;
          if (obj._e) continue; // still encrypted — skip
          if (obj.status === "archived" && typeof obj.id === "string") {
            archived.add(obj.id);
            continue;
          }
          all.push(normalizeEntry(obj, file));
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
    async ({ query, type, max }) => runWithAuditContext({ caller: "mcp:memory_retrieve", channel: "mcp" }, async () => {
      const maxResults = max ?? 10;

      // If type-filtered, use Brain's existing LTM (3-file) retrieval
      if (type) {
        const entries = await brain.retrieve(query, {
          type: type as LongTermMemoryType,
          max: maxResults,
        });
        return { content: [{ type: "text" as const, text: formatEntries(entries) }] };
      }

      // Otherwise, search across ALL unlocked JSONL files with scored retrieval
      const all = await hallwayScanMemory();
      const queryLower = query.toLowerCase();
      const terms = queryLower.split(/\s+/).filter((t) => t.length > 1);
      if (terms.length === 0) {
        return { content: [{ type: "text" as const, text: formatEntries(all.slice(0, maxResults)) }] };
      }

      // Score each entry: term matches + density + co-occurrence + recency + meta
      const now = Date.now();
      const scored = all
        .map((e) => {
          const text = [
            e.content ?? "",
            e.meta ? JSON.stringify(e.meta) : "",
            (e as any).summary ?? "",
            (e as any).title ?? "",
            (e as any).description ?? "",
          ].join(" ").toLowerCase();

          if (!text) return { entry: e, score: 0 };

          // Shared scoring geometry (word boundaries, concentration, proximity)
          const baseScore = scoreEntry(terms, queryLower, text);
          if (baseScore === 0) return { entry: e, score: 0 };

          // Recency: newer entries score slightly higher (retrieval-only concern)
          const age = now - new Date(e.createdAt).getTime();
          const dayAge = age / (1000 * 60 * 60 * 24);
          const recencyScore = Math.max(0, 0.1 * (1 - dayAge / 365));

          const score = baseScore + recencyScore;
          return { entry: e, score };
        })
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, maxResults)
        .map((s) => s.entry);

      return {
        content: [{ type: "text" as const, text: formatEntries(scored) }],
      };
    })
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

      // Flow through the crystallizer — every new memory passes through all open loops
      let crystalNote = "";
      try {
        const precipitations = await crystallizer.test(entry);
        if (precipitations.length > 0) {
          crystalNote = `\n\nCrystallization: ${precipitations.length} loop(s) precipitated:\n` +
            precipitations.map((p) => `  - "${p.query}" (${p.evidenceCount} evidence)`).join("\n");
        }
      } catch { /* never block memory writes */ }

      return {
        content: [
          { type: "text" as const, text: `Stored as ${entry.id} (${entry.type}) at ${entry.createdAt}${crystalNote}` },
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
    async ({ type, limit }) => runWithAuditContext({ caller: "mcp:memory_list", channel: "mcp" }, async () => {
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
    })
  );

  mcp.tool(
    "read_brain_file",
    "Read any file under brain/ (path-guarded, encrypted files auto-decrypted)",
    {
      path: z.string().max(500).describe("Relative path under brain/, e.g. 'operations/goals.yaml'"),
    },
    async ({ path }) => runWithAuditContext({ caller: "mcp:read_brain_file", channel: "mcp" }, async () => {
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
    })
  );

  mcp.tool(
    "files_search",
    "Search brain files (notes, research, identity, templates, protocols — everything except logs) by keyword. Returns matching filenames with context snippets.",
    {
      query: z.string().min(1).max(500).describe("Search query — keywords to find in brain files"),
      max: z.number().int().min(1).max(20).optional().describe("Max results (default 10)"),
    },
    async ({ query, max }) => runWithAuditContext({ caller: "mcp:files_search", channel: "mcp" }, async () => {
      const maxResults = max ?? 10;
      const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
      if (terms.length === 0) {
        return { content: [{ type: "text" as const, text: "No search terms provided." }] };
      }

      // Scan all non-log directories for readable files (md, yaml, yml, json, txt)
      const searchExts = new Set([".md", ".yaml", ".yml", ".json", ".txt", ".jsonl"]);
      const skipDirs = new Set(["log", ".config", "ops", "metrics", ".obsidian", ".git", "node_modules"]);

      interface FileHit { relPath: string; score: number; snippet: string }
      const hits: FileHit[] = [];

      async function scanDir(dir: string, rel: string): Promise<void> {
        let entries: string[];
        try { entries = await readdir(dir); } catch { return; }
        for (const name of entries) {
          if (name.startsWith(".") && rel === "") {
            // Skip hidden dirs at top level except .config
            if (skipDirs.has(name)) continue;
          }
          if (skipDirs.has(name)) continue;
          const full = join(dir, name);
          const childRel = rel ? `${rel}/${name}` : name;
          try {
            const s = await stat(full);
            if (s.isDirectory()) {
              // Don't recurse into JSONL-heavy log dirs
              if (name === "memory" || name === "logs" || name === "tasks" || name === "daily" || name === "hourly") continue;
              await scanDir(full, childRel);
            } else {
              const ext = name.substring(name.lastIndexOf(".")).toLowerCase();
              if (!searchExts.has(ext)) continue;
              if (isLocked(childRel)) continue;
              // Skip large JSONL files (those are log data, not knowledge)
              if (ext === ".jsonl" && s.size > 100_000) continue;

              const content = await readBrainFile(full);
              const lower = content.toLowerCase();
              let score = 0;
              for (const term of terms) {
                const idx = lower.indexOf(term);
                if (idx !== -1) {
                  score++;
                  // Bonus for title/filename match
                  if (name.toLowerCase().includes(term)) score += 2;
                }
                // Match against full relative path (catches parent directory names)
                if (childRel.toLowerCase().includes(term)) score += 2;
              }
              if (score > 0) {
                // Extract a snippet around the first match
                const firstTerm = terms.find((t) => lower.includes(t))!;
                const matchIdx = lower.indexOf(firstTerm);
                const start = Math.max(0, matchIdx - 80);
                const end = Math.min(content.length, matchIdx + 120);
                const snippet = (start > 0 ? "..." : "") +
                  content.substring(start, end).replace(/\n/g, " ").trim() +
                  (end < content.length ? "..." : "");
                hits.push({ relPath: childRel, score, snippet });
              }
            }
          } catch { continue; }
        }
      }

      await scanDir(BRAIN_DIR, "");

      // If keyword search found nothing, try semantic search via RAG
      if (hits.length === 0 && mcpRag?.ready) {
        try {
          const ragResults = await mcpRag.query(query, maxResults);
          if (ragResults.length > 0) {
            const result = ragResults.map((r) =>
              `📄 ${r.filePath} (semantic score: ${r.score.toFixed(3)}, section: ${r.heading})${r.siblings ? `\n   Also in directory: ${r.siblings.join(", ")}` : ""}`
            ).join("\n\n");
            return {
              content: [{ type: "text" as const, text: `Keyword search found nothing. Semantic search found ${ragResults.length} file(s):\n\n${result}` }],
            };
          }
        } catch { /* semantic search failed — fall through */ }
      }

      if (hits.length === 0) {
        return { content: [{ type: "text" as const, text: `No files matched: "${query}"` }] };
      }

      hits.sort((a, b) => b.score - a.score);
      const top = hits.slice(0, maxResults);
      const result = top.map((h) =>
        `📄 ${h.relPath} (score: ${h.score})\n   ${h.snippet}`
      ).join("\n\n");

      return {
        content: [{ type: "text" as const, text: `Found ${hits.length} file(s) matching "${query}":\n\n${result}` }],
      };
    })
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
        privateMode: s.privateMode,
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
      const paths = await reloadLockedPaths();
      const lines = paths.length > 0
        ? paths.map((p) => `🔒 ${p}`).join("\n")
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
      await reloadLockedPaths();

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
      const result = await checkVoucherWithAlert(ltm, token, "mcp:voucher_check");
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

  // ── Alert tool ──────────────────────────────────────────────────────────

  mcp.tool(
    "send_alert",
    "Send an alert to the human via email and/or SMS. Use when something needs attention (failed voucher, suspicious access, system issue).",
    {
      subject: z.string().max(200).describe("Alert subject line"),
      body: z.string().max(2000).describe("Alert body with details"),
    },
    async ({ subject, body }) => {
      const results = await sendAlert(subject, body);
      const summary = results
        .map((r) => `${r.channel}: ${r.sent ? "sent" : `failed (${r.error})`}`)
        .join(", ");
      return {
        content: [{ type: "text" as const, text: summary }],
      };
    }
  );

  // ── Open loop tools (crystallizer) ──────────────────────────────────────

  mcp.tool(
    "loop_open",
    "Create an open loop — a standing query that filters the memory stream. Evidence accumulates as matching memories are added. When enough evidence sticks, the loop precipitates and surfaces as a notification.",
    {
      query: z.string().min(2).max(500).describe("The search shape — terms that define what this loop catches"),
      context: z.string().min(1).max(2000).describe("Why this loop exists — what question you're trying to answer"),
      threshold: z.number().int().min(1).max(50).optional().describe("How many evidence hits before precipitation (default 3)"),
      minScore: z.number().min(0.1).max(2.0).optional().describe("Minimum match score to count as evidence (default 0.4)"),
    },
    async ({ query, context, threshold, minScore }) => {
      const loop = await crystallizer.open(query, context, threshold ?? 3, minScore ?? 0.4);
      return {
        content: [{ type: "text" as const, text: `Loop opened: ${loop.id}\nQuery: "${loop.query}"\nContext: ${loop.context}\nThreshold: ${loop.threshold} evidence hits\nMin score: ${loop.minScore}` }],
      };
    }
  );

  mcp.tool(
    "loop_list",
    "List open loops and their evidence state. Shows what's filtering, what's accumulated, what's precipitated.",
    {
      status: z.enum(["open", "precipitated", "resolved", "all"]).optional().describe("Filter by status (default: all)"),
    },
    async ({ status }) => {
      const filterStatus = status === "all" ? undefined : (status ?? undefined);
      const loops = crystallizer.list(filterStatus as any);

      if (loops.length === 0) {
        return { content: [{ type: "text" as const, text: "No loops found." }] };
      }

      const lines = loops.map((l) => {
        const evidenceStr = l.evidence.length > 0
          ? `\n    Evidence (${l.evidence.length}/${l.threshold}):\n` +
            l.evidence.map((e) => `      - [${e.score.toFixed(2)}] ${e.snippet.slice(0, 80)}...`).join("\n")
          : `\n    No evidence yet (0/${l.threshold})`;
        return `[${l.status.toUpperCase()}] ${l.id}\n  Query: "${l.query}"\n  Context: ${l.context}\n  Created: ${l.createdAt}${evidenceStr}`;
      });

      return { content: [{ type: "text" as const, text: lines.join("\n\n") }] };
    }
  );

  mcp.tool(
    "loop_resolve",
    "Manually resolve (close) an open loop. Use when the question has been answered or is no longer relevant.",
    {
      loopId: z.string().describe("The loop ID to resolve"),
    },
    async ({ loopId }) => {
      const loop = await crystallizer.resolve(loopId);
      if (!loop) {
        return { content: [{ type: "text" as const, text: `Loop ${loopId} not found.` }], isError: true };
      }
      return {
        content: [{ type: "text" as const, text: `Loop resolved: ${loop.id} ("${loop.query}")\nFinal evidence count: ${loop.evidence.length}` }],
      };
    }
  );

  // ── Whiteboard tools ──────────────────────────────────────────────────────

  mcp.tool(
    "whiteboard_plant",
    "Plant a work item or question on the whiteboard. Use this to track goals, tasks, decisions, and — most importantly — questions that need human input to unstick work.",
    {
      title: z.string().describe("Short label for the node"),
      type: z.enum(["goal", "task", "question", "decision", "note"]).describe("Node type"),
      parentId: z.string().optional().describe("Parent node ID (omit for root)"),
      tags: z.array(z.string()).optional().describe("Category tags"),
      body: z.string().optional().describe("Markdown detail"),
      question: z.string().optional().describe("Question text (required if type=question)"),
    },
    async (args) => {
      const { WhiteboardStore } = await import("./whiteboard/store.js");
      const store = new WhiteboardStore(BRAIN_DIR);

      const node = await store.create({
        title: args.title,
        type: args.type as any,
        parentId: args.parentId ?? null,
        tags: args.tags ?? [],
        plantedBy: "agent",
        body: args.body,
        question: args.question,
      });

      const typeLabel = args.type === "question" ? `Question planted: "${args.question ?? args.title}"` : `${args.type} planted: "${args.title}"`;
      return {
        content: [{ type: "text" as const, text: `${typeLabel}\nID: ${node.id}\nWeight: ${node.weight}` }],
      };
    }
  );

  mcp.tool(
    "whiteboard_status",
    "Get whiteboard summary — open items, unanswered questions, and top items by attention weight. Use this to see what needs human input.",
    {},
    async () => {
      const { WhiteboardStore } = await import("./whiteboard/store.js");
      const store = new WhiteboardStore(BRAIN_DIR);
      const summary = await store.getSummary();

      const lines: string[] = [
        `Whiteboard: ${summary.total} items (${summary.open} open, ${summary.done} done)`,
        `Open questions: ${summary.openQuestions}`,
      ];

      if (summary.topWeighted.length > 0) {
        lines.push("", "Top items by weight:");
        for (const node of summary.topWeighted) {
          const icon = node.type === "question" ? "?" : node.type === "decision" ? "!" : "-";
          lines.push(`  ${icon} [${node.weight}] ${node.title}${node.question ? ` — "${node.question}"` : ""}`);
        }
      }

      if (Object.keys(summary.byTag).length > 0) {
        lines.push("", "By tag: " + Object.entries(summary.byTag).map(([k, v]) => `${k}(${v})`).join(", "));
      }

      // Show open questions from the human that Dash should answer
      const openQs = await store.getOpenQuestions();
      const humanQs = openQs.filter((q: any) => q.plantedBy === "human");
      if (humanQs.length > 0) {
        lines.push("", "Questions from human (answer or act on these):");
        for (const q of humanQs) {
          lines.push(`  → [${q.weight}] "${q.question || q.title}" (id: ${q.id})`);
        }
      }

      // Show ALL answered questions so the agent can act on them
      const allNodes = await store.list();
      const answered = allNodes.filter((n: any) => n.type === "question" && n.answer);
      if (answered.length > 0) {
        lines.push("", "=== ANSWERED QUESTIONS (act on these — do NOT ask the human to repeat) ===");
        for (const a of answered) {
          lines.push(`  Q: "${a.question || a.title}"`);
          lines.push(`  A: ${a.answer}`);
          lines.push(`  (id: ${a.id}, status: ${a.status})`);
          lines.push("");
        }
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    }
  );

  // ── Instance status + handoff check ─────────────────────────────────────

  mcp.tool(
    "dash_status",
    "Check if the Core server is running and review pending handoffs. Use anytime to verify the instance is alive and see what's queued.",
    {},
    async () => {
      const { discoverRunning } = await import("./runtime-lock.js");
      const lock = discoverRunning();

      let instanceHealth: string;
      if (!lock) {
        instanceHealth = "Server is DOWN — no runtime lock found";
      } else {
        // Lock exists and PID is alive — verify HTTP health
        try {
          const res = await fetch(`http://localhost:${lock.port}/healthz`, { signal: AbortSignal.timeout(5000) });
          if (res.ok) {
            const h = await res.json() as Record<string, unknown>;
            instanceHealth = `${lock.name} is RUNNING on port ${lock.port}. Uptime: ${h.uptime}s. Status: ${h.status}. PID: ${lock.pid}`;
          } else {
            instanceHealth = `${lock.name} responded but unhealthy: HTTP ${res.status} (port ${lock.port}, pid ${lock.pid})`;
          }
        } catch {
          instanceHealth = `${lock.name} has lock (pid=${lock.pid}, port=${lock.port}) but HTTP health check failed`;
        }
      }

      // Read handoffs from this brain
      let handoffSummary: string;
      try {
        const handoffPath = join(BRAIN_DIR, "operations", "handoffs.jsonl");
        const { readFile } = await import("node:fs/promises");
        const raw = await readFile(handoffPath, "utf-8");
        const lines = raw.split("\n").filter((l) => l.trim() && !l.includes("_schema"));
        const pending = lines.filter((l) => {
          try { return JSON.parse(l).status === "pending"; } catch { return false; }
        });
        const items = pending.map((l) => {
          const o = JSON.parse(l);
          return `[${o.priority || "?"}] ${o.title}`;
        });
        handoffSummary = pending.length === 0
          ? "No pending handoffs."
          : `${pending.length} pending handoffs:\n${items.join("\n")}`;
      } catch {
        handoffSummary = "No pending handoffs.";
      }

      return {
        content: [{ type: "text" as const, text: `${instanceHealth}\n\n${handoffSummary}` }],
      };
    }
  );

  // ── Web fetch ──────────────────────────────────────────────────────────

  mcp.tool(
    "web_fetch",
    "Fetch a URL and return its content as markdown. Only use when the user provides a specific URL — never browse autonomously.",
    {
      url: z.string().url().describe("The URL to fetch"),
      prompt: z.string().max(500).optional().describe("Optional: what to extract from the page"),
    },
    async ({ url, prompt }) => runWithAuditContext({ caller: "mcp:web_fetch", channel: "mcp" }, async () => {
      log(`web_fetch: ${url}`);

      try {
        const res = await fetch(url, {
          headers: {
            "User-Agent": "Core/1.0 (runcore.sh)",
            "Accept": "text/html,application/xhtml+xml,text/plain,application/json,*/*",
          },
          signal: AbortSignal.timeout(15_000),
          redirect: "follow",
        });

        if (!res.ok) {
          return {
            content: [{ type: "text" as const, text: `Fetch failed: HTTP ${res.status} ${res.statusText}` }],
          };
        }

        const contentType = res.headers.get("content-type") ?? "";
        const raw = await res.text();

        let body: string;
        if (contentType.includes("application/json")) {
          // Pretty-print JSON
          try {
            body = "```json\n" + JSON.stringify(JSON.parse(raw), null, 2) + "\n```";
          } catch {
            body = raw;
          }
        } else if (contentType.includes("text/html")) {
          // Strip HTML to readable text
          body = htmlToMarkdown(raw);
        } else {
          // Plain text or other
          body = raw;
        }

        // Truncate if massive
        const MAX_CHARS = 50_000;
        if (body.length > MAX_CHARS) {
          body = body.slice(0, MAX_CHARS) + `\n\n... (truncated at ${MAX_CHARS} chars)`;
        }

        const header = `**Fetched:** ${url}\n**Content-Type:** ${contentType}\n**Size:** ${raw.length} bytes\n\n---\n\n`;
        const result = prompt
          ? `${header}${body}\n\n---\n\n**Extraction prompt:** ${prompt}`
          : `${header}${body}`;

        return { content: [{ type: "text" as const, text: result }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Fetch error: ${msg}` }] };
      }
    })
  );

  // ── Resources ────────────────────────────────────────────────────────────

  for (const memType of ["episodic", "semantic", "procedural"] as const) {
    mcp.resource(
      `memory-${memType}`,
      `brain://memory/${memType}`,
      { description: `All ${memType} memories` },
      async () => runWithAuditContext({ caller: `mcp:resource:memory/${memType}`, channel: "mcp" }, async () => {
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
      })
    );
  }

  mcp.resource(
    "identity",
    "brain://identity",
    { description: "Tone of voice, brand, personality" },
    async () => runWithAuditContext({ caller: "mcp:resource:identity", channel: "mcp" }, async () => {
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
    })
  );

  mcp.resource(
    "operations",
    "brain://operations",
    { description: "Goals, todos, operational state" },
    async () => runWithAuditContext({ caller: "mcp:resource:operations", channel: "mcp" }, async () => {
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
    })
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
