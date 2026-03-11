/**
 * Whiteboard store — append-only JSONL persistence for WhiteboardNode.
 *
 * Follows src/queue/store.ts and src/files/store.ts patterns:
 * in-memory Map cache, last-occurrence-wins, append-only writes.
 *
 * File: brain/log/whiteboard.jsonl
 */

import { readFile, appendFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { createLogger } from "../utils/logger.js";
import { computeWeights, buildTree } from "./weight.js";
import type {
  WhiteboardNode,
  WeightedNode,
  TreeNode,
  WhiteboardFilter,
  WhiteboardSummary,
  CreateNodeInput,
} from "./types.js";

const log = createLogger("whiteboard.store");

const SCHEMA_LINE = JSON.stringify({
  _schema: "whiteboard",
  version: 1,
  fields: [
    "id", "parentId", "title", "body", "type", "status", "tags",
    "plantedBy", "question", "answer", "answeredAt", "boardTaskId",
    "createdAt", "updatedAt",
  ],
});

/** Generate a whiteboard node ID: wb_<timestamp>_<8-hex>. */
function generateId(): string {
  const ts = Date.now();
  const rand = randomBytes(4).toString("hex");
  return `wb_${ts}_${rand}`;
}

export class WhiteboardStore {
  private cache: Map<string, WhiteboardNode> | null = null;
  private readonly filePath: string;

  constructor(brainDir: string) {
    this.filePath = join(brainDir, "log", "whiteboard.jsonl");
  }

  // ── File I/O ─────────────────────────────────────────────────────────────

  private async ensureFile(): Promise<void> {
    try {
      await readFile(this.filePath, "utf-8");
    } catch {
      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, SCHEMA_LINE + "\n", "utf-8");
    }
  }

  private async load(): Promise<Map<string, WhiteboardNode>> {
    if (this.cache) return this.cache;
    await this.ensureFile();

    log.debug("loading whiteboard", { filePath: this.filePath });
    const raw = await readFile(this.filePath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);

    const map = new Map<string, WhiteboardNode>();
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj._schema) continue;
        map.set(obj.id, obj as WhiteboardNode);
      } catch {
        continue;
      }
    }

    this.cache = map;
    log.info("whiteboard loaded", { nodeCount: map.size });
    return map;
  }

  private async append(node: WhiteboardNode): Promise<void> {
    await appendFile(this.filePath, JSON.stringify(node) + "\n", "utf-8");
  }

  // ── CRUD ─────────────────────────────────────────────────────────────────

  async create(input: CreateNodeInput): Promise<WeightedNode> {
    const map = await this.load();
    const now = new Date().toISOString();

    const node: WhiteboardNode = {
      ...input,
      id: generateId(),
      status: input.status ?? "open",
      createdAt: now,
      updatedAt: now,
    };

    map.set(node.id, node);
    await this.append(node);

    log.info("node created", { id: node.id, type: node.type, title: node.title });

    // Return with weight computed
    const weighted = computeWeights([node]);
    return weighted[0];
  }

  async get(id: string): Promise<WhiteboardNode | null> {
    const map = await this.load();
    return map.get(id) ?? null;
  }

  async update(id: string, patch: Partial<WhiteboardNode>): Promise<WhiteboardNode | null> {
    const map = await this.load();
    const existing = map.get(id);
    if (!existing) return null;

    const updated: WhiteboardNode = {
      ...existing,
      ...patch,
      id: existing.id,           // prevent overwrite
      createdAt: existing.createdAt,
      plantedBy: existing.plantedBy,
      updatedAt: new Date().toISOString(),
    };

    map.set(id, updated);
    await this.append(updated);

    log.debug("node updated", { id, changes: Object.keys(patch) });
    return updated;
  }

  async archive(id: string, cascade = false): Promise<{ ok: boolean; message: string }> {
    const map = await this.load();
    const existing = map.get(id);
    if (!existing) return { ok: false, message: `Node not found: ${id}` };
    if (existing.status === "archived") return { ok: true, message: "Already archived" };

    // Archive this node
    await this.update(id, { status: "archived" });

    // Cascade to children if requested
    if (cascade) {
      const children = await this.getChildren(id);
      for (const child of children) {
        await this.archive(child.id, true);
      }
    }

    log.info("node archived", { id, title: existing.title, cascade });
    return { ok: true, message: `Archived: ${existing.title}` };
  }

  // ── List with filters ────────────────────────────────────────────────────

  async list(filter?: WhiteboardFilter): Promise<WhiteboardNode[]> {
    const map = await this.load();
    let results = [...map.values()].filter((n) => n.status !== "archived");

    if (filter) {
      if (filter.type) results = results.filter((n) => n.type === filter.type);
      if (filter.status) results = results.filter((n) => n.status === filter.status);
      if (filter.plantedBy) results = results.filter((n) => n.plantedBy === filter.plantedBy);
      if (filter.parentId) results = results.filter((n) => n.parentId === filter.parentId);
      if (filter.tags?.length) {
        results = results.filter((n) =>
          filter.tags!.some((t) => n.tags.includes(t)),
        );
      }
      if (filter.search) {
        const q = filter.search.toLowerCase();
        results = results.filter((n) =>
          n.title.toLowerCase().includes(q) ||
          n.body?.toLowerCase().includes(q) ||
          n.question?.toLowerCase().includes(q) ||
          n.answer?.toLowerCase().includes(q) ||
          n.tags.some((t) => t.toLowerCase().includes(q)),
        );
      }
      if (filter.answeredSince) {
        const since = filter.answeredSince;
        results = results.filter((n) =>
          n.type === "question" && n.answeredAt && n.answeredAt >= since,
        );
      }
    }

    results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return results;
  }

  // ── Tree operations ──────────────────────────────────────────────────────

  async getChildren(parentId: string): Promise<WhiteboardNode[]> {
    const map = await this.load();
    return [...map.values()]
      .filter((n) => n.parentId === parentId && n.status !== "archived")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getSubtree(rootId: string): Promise<WhiteboardNode[]> {
    const map = await this.load();
    const result: WhiteboardNode[] = [];
    const queue = [rootId];

    while (queue.length > 0) {
      const id = queue.shift()!;
      const node = map.get(id);
      if (!node || node.status === "archived") continue;
      result.push(node);
      // Find children
      for (const n of map.values()) {
        if (n.parentId === id && n.status !== "archived") {
          queue.push(n.id);
        }
      }
    }

    return result;
  }

  async getRoots(): Promise<WhiteboardNode[]> {
    const map = await this.load();
    return [...map.values()]
      .filter((n) => n.parentId === null && n.status !== "archived")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getAncestors(id: string): Promise<WhiteboardNode[]> {
    const map = await this.load();
    const path: WhiteboardNode[] = [];
    let current = map.get(id);

    while (current?.parentId) {
      const parent = map.get(current.parentId);
      if (!parent) break;
      path.unshift(parent);
      current = parent;
    }

    return path;
  }

  // ── Questions ────────────────────────────────────────────────────────────

  async getOpenQuestions(): Promise<WeightedNode[]> {
    const map = await this.load();
    const questions = [...map.values()].filter(
      (n) => n.type === "question" && n.status === "open" && !n.answer,
    );
    const weighted = computeWeights(questions);
    return weighted.sort((a, b) => b.weight - a.weight);
  }

  async answerQuestion(id: string, answer: string): Promise<WhiteboardNode | null> {
    const map = await this.load();
    const node = map.get(id);
    if (!node) return null;
    if (node.type !== "question") return null;

    return this.update(id, {
      answer,
      answeredAt: new Date().toISOString(),
      status: "done",
    });
  }

  async getAnsweredSince(since: string): Promise<WhiteboardNode[]> {
    const map = await this.load();
    return [...map.values()].filter(
      (n) => n.type === "question" && n.answeredAt && n.answeredAt >= since,
    );
  }

  // ── Weighted / Tree views ────────────────────────────────────────────────

  async getWeighted(): Promise<WeightedNode[]> {
    const all = await this.list();
    const weighted = computeWeights(all);
    return weighted.sort((a, b) => b.weight - a.weight);
  }

  async getTree(rootId?: string): Promise<TreeNode[]> {
    const all = await this.list();
    const weighted = computeWeights(all);
    return buildTree(weighted, rootId);
  }

  // ── Summary ──────────────────────────────────────────────────────────────

  async getSummary(): Promise<WhiteboardSummary> {
    const all = await this.list();
    const weighted = computeWeights(all);

    const open = all.filter((n) => n.status === "open").length;
    const done = all.filter((n) => n.status === "done").length;
    const openQuestions = all.filter(
      (n) => n.type === "question" && n.status === "open" && !n.answer,
    ).length;

    const byTag: Record<string, number> = {};
    for (const node of all) {
      for (const tag of node.tags) {
        byTag[tag] = (byTag[tag] ?? 0) + 1;
      }
    }

    const topWeighted = weighted
      .filter((n) => n.weight > 0)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 5);

    return {
      total: all.length,
      open,
      done,
      openQuestions,
      topWeighted,
      byTag,
    };
  }

  // ── Compaction ───────────────────────────────────────────────────────────

  async compact(): Promise<{ before: number; after: number }> {
    const map = await this.load();
    const nodes = [...map.values()];
    const lines = [SCHEMA_LINE, ...nodes.map((n) => JSON.stringify(n))];

    const before = (await readFile(this.filePath, "utf-8"))
      .split("\n")
      .filter((l) => l.trim().length > 0).length;

    await writeFile(this.filePath, lines.join("\n") + "\n", "utf-8");
    const after = lines.length;

    log.info("whiteboard compacted", { before, after });
    return { before, after };
  }
}
