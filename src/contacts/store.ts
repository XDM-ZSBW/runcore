/**
 * Contacts store — append-only JSONL persistence for entities and edges.
 * Follows src/queue/store.ts pattern.
 * All data encrypted at rest via brain-io.
 *
 * Files: brain/contacts/entities.jsonl, brain/contacts/edges.jsonl
 * Update strategy: append full updated record. On load, last occurrence per id wins.
 */

import { join } from "node:path";
import { stat } from "node:fs/promises";
import { createLogger } from "../utils/logger.js";
import { readBrainLines, appendBrainLine, ensureBrainJsonl } from "../lib/brain-io.js";
import type { Entity, Edge, EntityType, EdgeType, EntityFilter, EdgeFilter } from "./types.js";

const log = createLogger("contacts.store");

const ENTITY_SCHEMA = JSON.stringify({ _schema: "contact-entities", _version: "1.0" });
const EDGE_SCHEMA = JSON.stringify({ _schema: "contact-edges", _version: "1.0" });

function generateEntityId(): string {
  const hex = Math.random().toString(16).slice(2, 10).padEnd(8, "0");
  return `ent_${hex}`;
}

function generateEdgeId(): string {
  const hex = Math.random().toString(16).slice(2, 10).padEnd(8, "0");
  return `edg_${hex}`;
}

export class ContactStore {
  private readonly entitiesPath: string;
  private readonly edgesPath: string;
  private entityCache: Map<string, Entity> | null = null;
  private edgeCache: Map<string, Edge> | null = null;
  private entityMtime = 0;
  private edgeMtime = 0;
  private lastStaleCheckMs = 0;

  constructor(brainDir: string) {
    this.entitiesPath = join(brainDir, "contacts", "entities.jsonl");
    this.edgesPath = join(brainDir, "contacts", "edges.jsonl");
  }

  // ── File management ──────────────────────────────────────────────────────

  private async ensureFiles(): Promise<void> {
    await ensureBrainJsonl(this.entitiesPath, ENTITY_SCHEMA);
    await ensureBrainJsonl(this.edgesPath, EDGE_SCHEMA);
  }

  private async checkStale(): Promise<void> {
    const now = Date.now();
    if (now - this.lastStaleCheckMs < 5000) return;
    this.lastStaleCheckMs = now;

    try {
      if (this.entityCache) {
        const s = await stat(this.entitiesPath);
        if (s.mtimeMs > this.entityMtime) this.entityCache = null;
      }
      if (this.edgeCache) {
        const s = await stat(this.edgesPath);
        if (s.mtimeMs > this.edgeMtime) this.edgeCache = null;
      }
    } catch {
      // Files may not exist yet
    }
  }

  // ── Load ──────────────────────────────────────────────────────────────────

  private async loadEntities(): Promise<Map<string, Entity>> {
    await this.checkStale();
    if (this.entityCache) return this.entityCache;

    await this.ensureFiles();
    const lines = await readBrainLines(this.entitiesPath);
    const map = new Map<string, Entity>();

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj._schema) continue;
        if (!obj.id) continue;
        map.set(obj.id, obj as Entity);
      } catch { continue; }
    }

    this.entityCache = map;
    try {
      const s = await stat(this.entitiesPath);
      this.entityMtime = s.mtimeMs;
    } catch { /* ok */ }

    return map;
  }

  private async loadEdges(): Promise<Map<string, Edge>> {
    await this.checkStale();
    if (this.edgeCache) return this.edgeCache;

    await this.ensureFiles();
    const lines = await readBrainLines(this.edgesPath);
    const map = new Map<string, Edge>();

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj._schema) continue;
        if (!obj.id) continue;
        map.set(obj.id, obj as Edge);
      } catch { continue; }
    }

    this.edgeCache = map;
    try {
      const s = await stat(this.edgesPath);
      this.edgeMtime = s.mtimeMs;
    } catch { /* ok */ }

    return map;
  }

  private invalidateEntities(): void { this.entityCache = null; }
  private invalidateEdges(): void { this.edgeCache = null; }

  // ── Entity CRUD ──────────────────────────────────────────────────────────

  async listEntities(filter?: EntityFilter): Promise<Entity[]> {
    const map = await this.loadEntities();
    let entities = Array.from(map.values());

    if (filter?.type) {
      entities = entities.filter((e) => e.type === filter.type);
    }
    if (filter?.status) {
      entities = entities.filter((e) => e.status === filter.status);
    } else {
      // Default: only active
      entities = entities.filter((e) => e.status !== "archived");
    }

    entities.sort((a, b) => a.name.localeCompare(b.name));
    return entities;
  }

  async getEntity(id: string): Promise<Entity | null> {
    const map = await this.loadEntities();
    return map.get(id) ?? null;
  }

  async createEntity(opts: {
    type: EntityType;
    name: string;
    aliases?: string[];
    channels?: Entity["channels"];
    meta?: Record<string, unknown>;
    notes?: string;
    tags?: string[];
  }): Promise<Entity> {
    const now = new Date().toISOString();
    const entity: Entity = {
      id: generateEntityId(),
      type: opts.type,
      name: opts.name,
      aliases: opts.aliases,
      channels: opts.channels,
      meta: opts.meta,
      notes: opts.notes,
      tags: opts.tags,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };

    await appendBrainLine(this.entitiesPath, JSON.stringify(entity));
    this.invalidateEntities();
    log.info(`Created entity ${entity.id}: ${entity.name} (${entity.type})`);
    return entity;
  }

  async updateEntity(id: string, changes: Partial<Pick<Entity, "name" | "aliases" | "channels" | "meta" | "notes" | "tags" | "status">>): Promise<Entity | null> {
    const existing = await this.getEntity(id);
    if (!existing) return null;

    const updated: Entity = {
      ...existing,
      ...changes,
      updatedAt: new Date().toISOString(),
    };

    await appendBrainLine(this.entitiesPath, JSON.stringify(updated));
    this.invalidateEntities();
    log.info(`Updated entity ${id}: ${updated.name}`);
    return updated;
  }

  // ── Edge CRUD ────────────────────────────────────────────────────────────

  async listEdges(filter?: EdgeFilter): Promise<Edge[]> {
    const map = await this.loadEdges();
    let edges = Array.from(map.values());

    if (filter?.type) {
      edges = edges.filter((e) => e.type === filter.type);
    }
    if (filter?.entityId) {
      edges = edges.filter((e) => e.from === filter.entityId || e.to === filter.entityId);
    }
    if (filter?.status) {
      edges = edges.filter((e) => e.status === filter.status);
    } else {
      edges = edges.filter((e) => e.status !== "archived");
    }

    return edges;
  }

  async getEdge(id: string): Promise<Edge | null> {
    const map = await this.loadEdges();
    return map.get(id) ?? null;
  }

  async createEdge(opts: {
    from: string;
    to: string;
    type: EdgeType;
    label?: string;
    since?: string;
    notes?: string;
  }): Promise<Edge> {
    const now = new Date().toISOString();
    const edge: Edge = {
      id: generateEdgeId(),
      from: opts.from,
      to: opts.to,
      type: opts.type,
      label: opts.label,
      since: opts.since,
      notes: opts.notes,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };

    await appendBrainLine(this.edgesPath, JSON.stringify(edge));
    this.invalidateEdges();
    log.info(`Created edge ${edge.id}: ${edge.from} -[${edge.type}]-> ${edge.to}`);
    return edge;
  }

  async updateEdge(id: string, changes: Partial<Pick<Edge, "type" | "label" | "since" | "notes" | "status">>): Promise<Edge | null> {
    const existing = await this.getEdge(id);
    if (!existing) return null;

    const updated: Edge = {
      ...existing,
      ...changes,
      updatedAt: new Date().toISOString(),
    };

    await appendBrainLine(this.edgesPath, JSON.stringify(updated));
    this.invalidateEdges();
    log.info(`Updated edge ${id}`);
    return updated;
  }

  // ── Graph queries ────────────────────────────────────────────────────────

  /** Get all edges where entity is from or to. */
  async getRelationships(entityId: string): Promise<Edge[]> {
    return this.listEdges({ entityId });
  }

  /** BFS traversal from entity to N hops. Returns entities and edges in the subgraph. */
  async getGraph(entityId: string, depth: number = 1): Promise<{ entities: Entity[]; edges: Edge[] }> {
    const visited = new Set<string>();
    const resultEntities: Entity[] = [];
    const resultEdges: Edge[] = [];
    let frontier = [entityId];

    for (let d = 0; d <= depth && frontier.length > 0; d++) {
      const nextFrontier: string[] = [];

      for (const id of frontier) {
        if (visited.has(id)) continue;
        visited.add(id);

        const entity = await this.getEntity(id);
        if (entity) resultEntities.push(entity);

        if (d < depth) {
          const edges = await this.getRelationships(id);
          for (const edge of edges) {
            resultEdges.push(edge);
            const neighbor = edge.from === id ? edge.to : edge.from;
            if (!visited.has(neighbor)) {
              nextFrontier.push(neighbor);
            }
          }
        }
      }

      frontier = nextFrontier;
    }

    return { entities: resultEntities, edges: resultEdges };
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────

let _store: ContactStore | null = null;

export function createContactStore(brainDir: string): ContactStore {
  if (_store) return _store;
  _store = new ContactStore(brainDir);
  return _store;
}

export function getContactStore(): ContactStore | null {
  return _store;
}
