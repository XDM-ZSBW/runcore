/**
 * Tool handler factory — creates ToolDefinition[] for all 17 Core tools.
 *
 * Uses the same underlying functions as src/mcp-server.ts (hallway scan,
 * WhiteboardStore, Crystallizer, etc.) — no logic duplication.
 *
 * The ctx parameter provides per-session state so handlers can be created
 * once per chat session with the right brain directory and dependencies.
 */

import { resolve, normalize, join } from "node:path";
import { readdir, stat } from "node:fs/promises";
import { z } from "zod";

import type { ToolDefinition } from "./types.js";
import type { TierName } from "../../tier/types.js";
import type { LongTermMemoryType, MemoryEntry } from "../../types.js";
import type { LongTermMemoryStore } from "../../memory/long-term.js";
import type { Brain } from "../../brain.js";

import {
  memoryRetrieveSchema,
  memoryLearnSchema,
  memoryListSchema,
  readBrainFileSchema,
  filesSearchSchema,
  getSettingsSchema,
  listLockedSchema,
  listRoomsSchema,
  whiteboardPlantSchema,
  whiteboardStatusSchema,
  voucherIssueSchema,
  voucherCheckSchema,
  sendAlertSchema,
  loopOpenSchema,
  loopListSchema,
  loopResolveSchema,
  dashStatusSchema,
} from "./schemas.js";

// ── Helpers (shared with mcp-server.ts) ───────────────────────────────────────

/** Resolve a relative path under brainDir, guarding against traversal. */
function resolveBrainPath(brainDir: string, relativePath: string): string {
  const cleaned = normalize(relativePath).replace(/^[/\\]+/, "");
  const full = resolve(brainDir, cleaned);
  if (!full.startsWith(brainDir)) {
    throw new Error("Path traversal blocked");
  }
  return full;
}

/** Format memory entries for display. */
function formatEntries(entries: MemoryEntry[]): string {
  if (entries.length === 0) return "No entries found.";
  return entries
    .map(
      (e) =>
        `[${e.id}] (${e.type}) ${e.createdAt}\n${e.content}${e.meta ? "\nmeta: " + JSON.stringify(e.meta) : ""}`,
    )
    .join("\n\n---\n\n");
}

/** Convert a Zod schema to JSON Schema via zod v4 built-in.
 *  Strips $schema key — LLM APIs (Anthropic via OpenRouter) reject it. */
function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const js = z.toJSONSchema(schema) as Record<string, unknown>;
  delete js.$schema;
  return js;
}

// ── Context type ──────────────────────────────────────────────────────────────

export interface ToolHandlerContext {
  brainDir: string;
  encryptionKey?: Buffer | string;
  /** Lazily provided — not all callers have a Brain instance. */
  getBrain?: () => Brain;
  /** Lazily provided — not all callers have an LTM instance. */
  getLtm?: () => LongTermMemoryStore;
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Create tool handlers for all 17 MCP tools.
 * Each handler matches the behavior of the corresponding mcp.tool() in
 * src/mcp-server.ts, using the same underlying modules.
 */
export function createToolHandlers(ctx: ToolHandlerContext): ToolDefinition[] {
  const memoryDir = join(ctx.brainDir, "memory");

  // ── Hallway scan (same as mcp-server.ts) ──────────────────────────────────

  async function hallwayScanMemory(): Promise<MemoryEntry[]> {
    const { readBrainLines } = await import("../../lib/brain-io.js");
    const { isLocked } = await import("../../lib/locked.js");

    let files: string[];
    try {
      files = await readdir(memoryDir);
    } catch {
      return [];
    }
    const jsonlFiles = files.filter(
      (f) => f.endsWith(".jsonl") && f !== "embeddings.jsonl",
    );

    const all: MemoryEntry[] = [];
    for (const file of jsonlFiles) {
      const relPath = `memory/${file}`;
      if (isLocked(relPath)) continue;
      const lines = await readBrainLines(join(memoryDir, file));
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
        } catch {
          continue;
        }
      }
      // Remove archived entries
      for (let i = all.length - 1; i >= 0; i--) {
        if (archived.has(all[i].id)) all.splice(i, 1);
      }
    }
    return all.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }

  // ── Tool definitions ──────────────────────────────────────────────────────

  const tools: ToolDefinition[] = [
    // ── memory_retrieve ───────────────────────────────────────────────────
    {
      name: "memory_retrieve",
      description: "Search long-term memory by query, with optional type filter",
      parameters: toJsonSchema(memoryRetrieveSchema),
      tier: "local" as TierName,
      handler: async (args) => {
        const { query, type, max } = args as {
          query: string;
          type?: LongTermMemoryType;
          max?: number;
        };
        const maxResults = max ?? 10;

        // Type-filtered: use Brain's LTM retrieval
        if (type && ctx.getBrain) {
          const brain = ctx.getBrain();
          const entries = await brain.retrieve(query, { type, max: maxResults });
          return { content: formatEntries(entries) };
        }

        // Otherwise: hallway scan with scored retrieval
        const { scoreEntry } = await import("../../crystallizer.js");
        const all = await hallwayScanMemory();
        const queryLower = query.toLowerCase();
        const terms = queryLower.split(/\s+/).filter((t) => t.length > 1);
        if (terms.length === 0) {
          return { content: formatEntries(all.slice(0, maxResults)) };
        }

        const now = Date.now();
        const scored = all
          .map((e) => {
            const eAny = e as unknown as Record<string, unknown>;
            const text = [
              e.content ?? "",
              e.meta ? JSON.stringify(e.meta) : "",
              (eAny.summary as string) ?? "",
              (eAny.title as string) ?? "",
              (eAny.description as string) ?? "",
            ]
              .join(" ")
              .toLowerCase();

            if (!text) return { entry: e, score: 0 };

            const baseScore = scoreEntry(terms, queryLower, text);
            if (baseScore === 0) return { entry: e, score: 0 };

            // Recency bonus
            const age = now - new Date(e.createdAt).getTime();
            const dayAge = age / (1000 * 60 * 60 * 24);
            const recencyScore = Math.max(0, 0.1 * (1 - dayAge / 365));

            return { entry: e, score: baseScore + recencyScore };
          })
          .filter((s) => s.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, maxResults)
          .map((s) => s.entry);

        return { content: formatEntries(scored) };
      },
    },

    // ── memory_learn ──────────────────────────────────────────────────────
    {
      name: "memory_learn",
      description:
        "Append a new entry to long-term memory (episodic, semantic, or procedural)",
      parameters: toJsonSchema(memoryLearnSchema),
      tier: "local" as TierName,
      handler: async (args) => {
        const { type, content, meta } = args as {
          type: LongTermMemoryType;
          content: string;
          meta?: Record<string, string | number | boolean>;
        };

        if (!ctx.getBrain) {
          return { content: "Brain not available", isError: true };
        }
        const brain = ctx.getBrain();
        const entry = await brain.learn({ type, content, meta });

        // Flow through the crystallizer
        let crystalNote = "";
        try {
          const { Crystallizer } = await import("../../crystallizer.js");
          const crystallizer = new Crystallizer(memoryDir, async () => {});
          await crystallizer.init();
          const precipitations = await crystallizer.test(entry);
          if (precipitations.length > 0) {
            crystalNote =
              `\n\nCrystallization: ${precipitations.length} loop(s) precipitated:\n` +
              precipitations
                .map((p) => `  - "${p.query}" (${p.evidenceCount} evidence)`)
                .join("\n");
          }
        } catch {
          /* never block memory writes */
        }

        return {
          content: `Stored as ${entry.id} (${entry.type}) at ${entry.createdAt}${crystalNote}`,
        };
      },
    },

    // ── memory_list ───────────────────────────────────────────────────────
    {
      name: "memory_list",
      description: "List memory entries by type, most recent first",
      parameters: toJsonSchema(memoryListSchema),
      tier: "local" as TierName,
      handler: async (args) => {
        const { type, limit } = args as {
          type?: LongTermMemoryType;
          limit?: number;
        };

        if (type && ctx.getLtm) {
          const ltm = ctx.getLtm();
          const entries = await ltm.list(type);
          return { content: formatEntries(entries.slice(0, limit ?? 20)) };
        }

        const entries = await hallwayScanMemory();
        return { content: formatEntries(entries.slice(0, limit ?? 20)) };
      },
    },

    // ── read_brain_file ───────────────────────────────────────────────────
    {
      name: "read_brain_file",
      description:
        "Read any file under brain/ (path-guarded, encrypted files auto-decrypted)",
      parameters: toJsonSchema(readBrainFileSchema),
      tier: "local" as TierName,
      handler: async (args) => {
        const { path } = args as { path: string };
        try {
          const { readBrainFile } = await import("../../lib/brain-io.js");
          const fullPath = resolveBrainPath(ctx.brainDir, path);
          const content = await readBrainFile(fullPath);
          return { content };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { content: `Error: ${msg}`, isError: true };
        }
      },
    },

    // ── files_search ──────────────────────────────────────────────────────
    {
      name: "files_search",
      description:
        "Search brain files (notes, research, identity, templates, protocols) by keyword. Returns matching filenames with context snippets.",
      parameters: toJsonSchema(filesSearchSchema),
      tier: "local" as TierName,
      handler: async (args) => {
        const { query, max } = args as { query: string; max?: number };
        const maxResults = max ?? 10;
        const terms = query
          .toLowerCase()
          .split(/\s+/)
          .filter((t) => t.length > 1);
        if (terms.length === 0) {
          return { content: "No search terms provided." };
        }

        const { readBrainFile } = await import("../../lib/brain-io.js");
        const { isLocked } = await import("../../lib/locked.js");

        const searchExts = new Set([
          ".md",
          ".yaml",
          ".yml",
          ".json",
          ".txt",
          ".jsonl",
        ]);
        const skipDirs = new Set([
          "log",
          ".config",
          "ops",
          "metrics",
          ".obsidian",
          ".git",
          "node_modules",
        ]);

        interface FileHit {
          relPath: string;
          score: number;
          snippet: string;
        }
        const hits: FileHit[] = [];

        async function scanDir(dir: string, rel: string): Promise<void> {
          let entries: string[];
          try {
            entries = await readdir(dir);
          } catch {
            return;
          }
          for (const name of entries) {
            if (name.startsWith(".") && rel === "") {
              if (skipDirs.has(name)) continue;
            }
            if (skipDirs.has(name)) continue;
            const full = join(dir, name);
            const childRel = rel ? `${rel}/${name}` : name;
            try {
              const s = await stat(full);
              if (s.isDirectory()) {
                if (
                  name === "memory" ||
                  name === "logs" ||
                  name === "tasks" ||
                  name === "daily" ||
                  name === "hourly"
                )
                  continue;
                await scanDir(full, childRel);
              } else {
                const ext = name
                  .substring(name.lastIndexOf("."))
                  .toLowerCase();
                if (!searchExts.has(ext)) continue;
                if (isLocked(childRel)) continue;
                if (ext === ".jsonl" && s.size > 100_000) continue;

                const content = await readBrainFile(full);
                const lower = content.toLowerCase();
                let score = 0;
                for (const term of terms) {
                  const idx = lower.indexOf(term);
                  if (idx !== -1) {
                    score++;
                    if (name.toLowerCase().includes(term)) score += 2;
                  }
                  if (childRel.toLowerCase().includes(term)) score += 2;
                }
                if (score > 0) {
                  const firstTerm = terms.find((t) => lower.includes(t))!;
                  const matchIdx = lower.indexOf(firstTerm);
                  const start = Math.max(0, matchIdx - 80);
                  const end = Math.min(content.length, matchIdx + 120);
                  const snippet =
                    (start > 0 ? "..." : "") +
                    content
                      .substring(start, end)
                      .replace(/\n/g, " ")
                      .trim() +
                    (end < content.length ? "..." : "");
                  hits.push({ relPath: childRel, score, snippet });
                }
              }
            } catch {
              continue;
            }
          }
        }

        await scanDir(ctx.brainDir, "");

        if (hits.length === 0) {
          return { content: `No files matched: "${query}"` };
        }

        hits.sort((a, b) => b.score - a.score);
        const top = hits.slice(0, maxResults);
        const result = top
          .map((h) => `${h.relPath} (score: ${h.score})\n   ${h.snippet}`)
          .join("\n\n");

        return {
          content: `Found ${hits.length} file(s) matching "${query}":\n\n${result}`,
        };
      },
    },

    // ── get_settings ──────────────────────────────────────────────────────
    {
      name: "get_settings",
      description: "Return safe subset of Core settings (no keys or secrets)",
      parameters: toJsonSchema(getSettingsSchema),
      tier: "local" as TierName,
      handler: async () => {
        const { getSettings } = await import("../../settings.js");
        const s = getSettings();
        const safe = {
          instanceName: s.instanceName,
          airplaneMode: s.airplaneMode,
          privateMode: s.privateMode,
          encryptBrainFiles: s.encryptBrainFiles,
          models: s.models,
          pulse: s.pulse,
        };
        return { content: JSON.stringify(safe, null, 2) };
      },
    },

    // ── list_locked ───────────────────────────────────────────────────────
    {
      name: "list_locked",
      description: "Show all currently locked paths in brain/.locked",
      parameters: toJsonSchema(listLockedSchema),
      tier: "local" as TierName,
      handler: async () => {
        const { reloadLockedPaths } = await import("../../lib/locked.js");
        const paths = await reloadLockedPaths();
        const lines =
          paths.length > 0
            ? paths.map((p) => `locked: ${p}`).join("\n")
            : "No locked paths.";
        return { content: lines };
      },
    },

    // ── list_rooms ────────────────────────────────────────────────────────
    {
      name: "list_rooms",
      description:
        "List all files/dirs under brain/ with their locked status",
      parameters: toJsonSchema(listRoomsSchema),
      tier: "local" as TierName,
      handler: async () => {
        const { reloadLockedPaths, isLocked } = await import(
          "../../lib/locked.js"
        );
        await reloadLockedPaths();

        async function walk(
          dir: string,
          prefix: string,
        ): Promise<string[]> {
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
            try {
              const s = await stat(fullPath);
              if (s.isDirectory()) {
                items.push(`${locked ? "[locked]" : "[dir]"} ${relPath}/`);
                if (!locked) {
                  const children = await walk(fullPath, relPath);
                  items.push(...children);
                }
              } else {
                items.push(
                  `${locked ? "[locked]" : "[file]"} ${relPath}`,
                );
              }
            } catch {
              items.push(`[error] ${relPath} (unreadable)`);
            }
          }
          return items;
        }

        const tree = await walk(ctx.brainDir, "");
        return { content: tree.join("\n") || "Empty brain directory." };
      },
    },

    // ── whiteboard_plant ──────────────────────────────────────────────────
    {
      name: "whiteboard_plant",
      description:
        "Plant a work item or question on the whiteboard. Use this to track goals, tasks, decisions, and questions that need human input.",
      parameters: toJsonSchema(whiteboardPlantSchema),
      tier: "local" as TierName,
      handler: async (args) => {
        const { title, type, parentId, tags, body, question } = args as {
          title: string;
          type: string;
          parentId?: string;
          tags?: string[];
          body?: string;
          question?: string;
        };

        const { WhiteboardStore } = await import(
          "../../whiteboard/store.js"
        );
        const store = new WhiteboardStore(ctx.brainDir);

        const node = await store.create({
          title,
          type: type as "goal" | "task" | "question" | "decision" | "note",
          parentId: parentId ?? null,
          tags: tags ?? [],
          plantedBy: "agent",
          body,
          question,
        });

        const typeLabel =
          type === "question"
            ? `Question planted: "${question ?? title}"`
            : `${type} planted: "${title}"`;
        return { content: `${typeLabel}\nID: ${node.id}\nWeight: ${node.weight}` };
      },
    },

    // ── whiteboard_status ─────────────────────────────────────────────────
    {
      name: "whiteboard_status",
      description:
        "Get whiteboard summary — open items, unanswered questions, and top items by attention weight.",
      parameters: toJsonSchema(whiteboardStatusSchema),
      tier: "local" as TierName,
      handler: async () => {
        const { WhiteboardStore } = await import(
          "../../whiteboard/store.js"
        );
        const store = new WhiteboardStore(ctx.brainDir);
        const summary = await store.getSummary();

        const lines: string[] = [
          `Whiteboard: ${summary.total} items (${summary.open} open, ${summary.done} done)`,
          `Open questions: ${summary.openQuestions}`,
        ];

        if (summary.topWeighted.length > 0) {
          lines.push("", "Top items by weight:");
          for (const node of summary.topWeighted) {
            const icon =
              node.type === "question"
                ? "?"
                : node.type === "decision"
                  ? "!"
                  : "-";
            lines.push(
              `  ${icon} [${node.weight}] ${node.title}${node.question ? ` — "${node.question}"` : ""}`,
            );
          }
        }

        if (Object.keys(summary.byTag).length > 0) {
          lines.push(
            "",
            "By tag: " +
              Object.entries(summary.byTag)
                .map(([k, v]) => `${k}(${v})`)
                .join(", "),
          );
        }

        // Show open questions from the human
        const openQs = await store.getOpenQuestions();
        const humanQs = openQs.filter(
          (q) => q.plantedBy === "human",
        );
        if (humanQs.length > 0) {
          lines.push("", "Questions from human (answer or act on these):");
          for (const q of humanQs) {
            lines.push(
              `  -> [${q.weight}] "${q.question || q.title}" (id: ${q.id})`,
            );
          }
        }

        // Show answered questions
        const allNodes = await store.list();
        const answered = allNodes.filter(
          (n) => n.type === "question" && n.answer,
        );
        if (answered.length > 0) {
          lines.push(
            "",
            "=== ANSWERED QUESTIONS (act on these) ===",
          );
          for (const a of answered) {
            lines.push(`  Q: "${a.question || a.title}"`);
            lines.push(`  A: ${a.answer}`);
            lines.push(`  (id: ${a.id}, status: ${a.status})`);
            lines.push("");
          }
        }

        return { content: lines.join("\n") };
      },
    },

    // ── voucher_issue ─────────────────────────────────────────────────────
    {
      name: "voucher_issue",
      description:
        "Issue a short-lived voucher token for brain-to-brain verification",
      parameters: toJsonSchema(voucherIssueSchema),
      tier: "spawn" as TierName,
      handler: async (args) => {
        const { scope, ttlMinutes } = args as {
          scope?: string;
          ttlMinutes?: number;
        };
        const { issueVoucher } = await import("../../voucher.js");
        if (!ctx.getLtm) {
          return { content: "LTM not available for voucher storage", isError: true };
        }
        const ltm = ctx.getLtm();
        const token = await issueVoucher(ltm, scope, ttlMinutes);
        return {
          content: `Voucher issued: ${token}${scope ? ` (scope: ${scope})` : ""}\nExpires in ${ttlMinutes ?? 30} minutes. Carry this token to the other brain.`,
        };
      },
    },

    // ── voucher_check ─────────────────────────────────────────────────────
    {
      name: "voucher_check",
      description: "Verify a voucher token carried from another brain",
      parameters: toJsonSchema(voucherCheckSchema),
      tier: "spawn" as TierName,
      handler: async (args) => {
        const { token } = args as { token: string };
        const { checkVoucherWithAlert } = await import("../../voucher.js");
        if (!ctx.getLtm) {
          return { content: "LTM not available for voucher verification", isError: true };
        }
        const ltm = ctx.getLtm();
        const result = await checkVoucherWithAlert(
          ltm,
          token,
          "tool:voucher_check",
        );
        if (result.valid) {
          return {
            content: `Valid voucher.${result.scope ? ` Scope: ${result.scope}` : " No scope restriction."}`,
          };
        }
        return { content: "Invalid or expired voucher. Request denied." };
      },
    },

    // ── send_alert ────────────────────────────────────────────────────────
    {
      name: "send_alert",
      description:
        "Send an alert to the human via email and/or SMS. Use when something needs attention.",
      parameters: toJsonSchema(sendAlertSchema),
      tier: "byok" as TierName,
      handler: async (args) => {
        const { subject, body } = args as { subject: string; body: string };
        const { sendAlert } = await import("../../alert.js");
        const results = await sendAlert(subject, body);
        const summary = results
          .map(
            (r) =>
              `${r.channel}: ${r.sent ? "sent" : `failed (${r.error})`}`,
          )
          .join(", ");
        return { content: summary };
      },
    },

    // ── loop_open ─────────────────────────────────────────────────────────
    {
      name: "loop_open",
      description:
        "Create an open loop — a standing query that filters the memory stream. Evidence accumulates as matching memories are added.",
      parameters: toJsonSchema(loopOpenSchema),
      tier: "local" as TierName,
      handler: async (args) => {
        const { query, context, threshold, minScore } = args as {
          query: string;
          context: string;
          threshold?: number;
          minScore?: number;
        };
        const { Crystallizer } = await import("../../crystallizer.js");
        const crystallizer = new Crystallizer(memoryDir, async () => {});
        await crystallizer.init();
        const loop = await crystallizer.open(
          query,
          context,
          threshold ?? 3,
          minScore ?? 0.4,
        );
        return {
          content: `Loop opened: ${loop.id}\nQuery: "${loop.query}"\nContext: ${loop.context}\nThreshold: ${loop.threshold} evidence hits\nMin score: ${loop.minScore}`,
        };
      },
    },

    // ── loop_list ─────────────────────────────────────────────────────────
    {
      name: "loop_list",
      description:
        "List open loops and their evidence state. Shows what's filtering, what's accumulated, what's precipitated.",
      parameters: toJsonSchema(loopListSchema),
      tier: "local" as TierName,
      handler: async (args) => {
        const { status } = args as { status?: string };
        const { Crystallizer } = await import("../../crystallizer.js");
        const crystallizer = new Crystallizer(memoryDir, async () => {});
        await crystallizer.init();
        const filterStatus =
          status === "all" ? undefined : (status as "open" | "precipitated" | "resolved" | undefined);
        const loops = crystallizer.list(filterStatus);

        if (loops.length === 0) {
          return { content: "No loops found." };
        }

        const lines = loops.map((l) => {
          const evidenceStr =
            l.evidence.length > 0
              ? `\n    Evidence (${l.evidence.length}/${l.threshold}):\n` +
                l.evidence
                  .map(
                    (e) =>
                      `      - [${e.score.toFixed(2)}] ${e.snippet.slice(0, 80)}...`,
                  )
                  .join("\n")
              : `\n    No evidence yet (0/${l.threshold})`;
          return `[${l.status.toUpperCase()}] ${l.id}\n  Query: "${l.query}"\n  Context: ${l.context}\n  Created: ${l.createdAt}${evidenceStr}`;
        });

        return { content: lines.join("\n\n") };
      },
    },

    // ── loop_resolve ──────────────────────────────────────────────────────
    {
      name: "loop_resolve",
      description:
        "Manually resolve (close) an open loop. Use when the question has been answered or is no longer relevant.",
      parameters: toJsonSchema(loopResolveSchema),
      tier: "local" as TierName,
      handler: async (args) => {
        const { loopId } = args as { loopId: string };
        const { Crystallizer } = await import("../../crystallizer.js");
        const crystallizer = new Crystallizer(memoryDir, async () => {});
        await crystallizer.init();
        const loop = await crystallizer.resolve(loopId);
        if (!loop) {
          return {
            content: `Loop ${loopId} not found.`,
            isError: true,
          };
        }
        return {
          content: `Loop resolved: ${loop.id} ("${loop.query}")\nFinal evidence count: ${loop.evidence.length}`,
        };
      },
    },

    // ── dash_status ───────────────────────────────────────────────────────
    {
      name: "dash_status",
      description:
        "Check if the Core server is running and review pending handoffs.",
      parameters: toJsonSchema(dashStatusSchema),
      tier: "byok" as TierName,
      handler: async () => {
        const { discoverRunning } = await import("../../runtime-lock.js");
        const lock = discoverRunning();

        let instanceHealth: string;
        if (!lock) {
          instanceHealth = "Server is DOWN — no runtime lock found";
        } else {
          try {
            const res = await fetch(
              `http://localhost:${lock.port}/healthz`,
              { signal: AbortSignal.timeout(5000) },
            );
            if (res.ok) {
              const h = (await res.json()) as Record<string, unknown>;
              instanceHealth = `${lock.name} is RUNNING on port ${lock.port}. Uptime: ${h.uptime}s. Status: ${h.status}. PID: ${lock.pid}`;
            } else {
              instanceHealth = `${lock.name} responded but unhealthy: HTTP ${res.status} (port ${lock.port}, pid ${lock.pid})`;
            }
          } catch {
            instanceHealth = `${lock.name} has lock (pid=${lock.pid}, port=${lock.port}) but HTTP health check failed`;
          }
        }

        // Read handoffs
        let handoffSummary: string;
        try {
          const { readFile } = await import("node:fs/promises");
          const handoffPath = join(
            ctx.brainDir,
            "operations",
            "handoffs.jsonl",
          );
          const raw = await readFile(handoffPath, "utf-8");
          const lines = raw
            .split("\n")
            .filter((l) => l.trim() && !l.includes("_schema"));
          const pending = lines.filter((l) => {
            try {
              return JSON.parse(l).status === "pending";
            } catch {
              return false;
            }
          });
          const items = pending.map((l) => {
            const o = JSON.parse(l);
            return `[${o.priority || "?"}] ${o.title}`;
          });
          handoffSummary =
            pending.length === 0
              ? "No pending handoffs."
              : `${pending.length} pending handoffs:\n${items.join("\n")}`;
        } catch {
          handoffSummary = "No pending handoffs.";
        }

        return { content: `${instanceHealth}\n\n${handoffSummary}` };
      },
    },
  ];

  return tools;
}
