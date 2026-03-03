/**
 * Template & Skill Sharing Registry — File-backed persistence.
 *
 * Stores registry entries as individual JSON files in brain/registry/entries/
 * and versions as append-only JSONL in brain/registry/versions.jsonl.
 * Follows the AgentRegistry pattern: in-memory Map + file persistence.
 */

import { readdir, readFile, writeFile, mkdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { RegistryEntry, RegistryVersion } from "./types.js";

// ---------------------------------------------------------------------------
// RegistryStore
// ---------------------------------------------------------------------------

export class RegistryStore {
  /** In-memory entry map, keyed by entry ID. */
  private readonly entries = new Map<string, RegistryEntry>();

  /** In-memory version list, keyed by entryId. */
  private readonly versions = new Map<string, RegistryVersion[]>();

  /** Base directory for registry persistence. */
  private readonly baseDir: string;

  /** Path to entries directory. */
  private readonly entriesDir: string;

  /** Path to versions JSONL file. */
  private readonly versionsFile: string;

  private loaded = false;

  constructor(opts: { registryDir: string }) {
    this.baseDir = opts.registryDir;
    this.entriesDir = join(opts.registryDir, "entries");
    this.versionsFile = join(opts.registryDir, "versions.jsonl");
  }

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------

  /** Load all entries and versions from disk into memory. */
  async load(): Promise<void> {
    if (this.loaded) return;

    await this.ensureDirs();
    await this.loadEntries();
    await this.loadVersions();
    this.loaded = true;
  }

  // -------------------------------------------------------------------------
  // Entry CRUD
  // -------------------------------------------------------------------------

  /** Get an entry by ID. */
  getEntry(id: string): RegistryEntry | undefined {
    return this.entries.get(id);
  }

  /** Find an entry by name and type. */
  findEntry(name: string, type: string): RegistryEntry | undefined {
    for (const entry of this.entries.values()) {
      if (entry.name === name && entry.type === type) return entry;
    }
    return undefined;
  }

  /** Get all entries. */
  allEntries(): RegistryEntry[] {
    return Array.from(this.entries.values());
  }

  /** Save (create or update) an entry. Persists to disk. */
  async saveEntry(entry: RegistryEntry): Promise<void> {
    this.entries.set(entry.id, entry);
    await this.persistEntry(entry);
  }

  /** Remove an entry from memory and disk. */
  async removeEntry(id: string): Promise<void> {
    this.entries.delete(id);
    const filePath = join(this.entriesDir, `${id}.json`);
    try {
      await unlink(filePath);
    } catch {
      // File may not exist
    }
  }

  /** Total number of entries. */
  get entryCount(): number {
    return this.entries.size;
  }

  // -------------------------------------------------------------------------
  // Version CRUD
  // -------------------------------------------------------------------------

  /** Get all versions for an entry, sorted newest first. */
  getVersions(entryId: string): RegistryVersion[] {
    return (this.versions.get(entryId) ?? []).slice().sort(
      (a, b) => b.publishedAt.localeCompare(a.publishedAt),
    );
  }

  /** Get a specific version. */
  getVersion(entryId: string, version: string): RegistryVersion | undefined {
    const versions = this.versions.get(entryId);
    if (!versions) return undefined;
    return versions.find((v) => v.version === version);
  }

  /** Append a version record. Persists to JSONL (append-only). */
  async addVersion(ver: RegistryVersion): Promise<void> {
    const list = this.versions.get(ver.entryId) ?? [];
    list.push(ver);
    this.versions.set(ver.entryId, list);
    await this.appendVersion(ver);
  }

  // -------------------------------------------------------------------------
  // Internal: persistence
  // -------------------------------------------------------------------------

  /** Ensure required directories exist. */
  private async ensureDirs(): Promise<void> {
    await mkdir(this.entriesDir, { recursive: true });
  }

  /** Load all entry JSON files from entries/ directory. */
  private async loadEntries(): Promise<void> {
    let files: string[];
    try {
      files = await readdir(this.entriesDir);
    } catch {
      return;
    }

    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const filePath = join(this.entriesDir, file);
      try {
        const raw = await readFile(filePath, "utf-8");
        const entry = JSON.parse(raw) as RegistryEntry;
        if (entry.id) {
          this.entries.set(entry.id, entry);
        }
      } catch {
        // Skip corrupt files
      }
    }
  }

  /** Load versions from append-only JSONL file. */
  private async loadVersions(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.versionsFile, "utf-8");
    } catch {
      return; // File doesn't exist yet
    }

    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("{\"_schema\"")) continue;
      try {
        const ver = JSON.parse(trimmed) as RegistryVersion;
        if (ver.entryId && ver.version) {
          const list = this.versions.get(ver.entryId) ?? [];
          list.push(ver);
          this.versions.set(ver.entryId, list);
        }
      } catch {
        // Skip malformed lines
      }
    }
  }

  /** Write a single entry to its JSON file (atomic via rename). */
  private async persistEntry(entry: RegistryEntry): Promise<void> {
    const filePath = join(this.entriesDir, `${entry.id}.json`);
    const tmpPath = filePath + ".tmp";
    await writeFile(tmpPath, JSON.stringify(entry, null, 2), "utf-8");
    await rename(tmpPath, filePath);
  }

  /** Append a version record to the JSONL file. */
  private async appendVersion(ver: RegistryVersion): Promise<void> {
    const line = JSON.stringify(ver) + "\n";
    try {
      // Append to existing file
      const existing = await readFile(this.versionsFile, "utf-8");
      await writeFile(this.versionsFile, existing + line, "utf-8");
    } catch {
      // File doesn't exist — create with schema header
      const header = JSON.stringify({
        _schema: "registry-version",
        fields: ["entryId", "version", "content", "checksum", "changelog", "publishedAt"],
      }) + "\n";
      await writeFile(this.versionsFile, header + line, "utf-8");
    }
  }
}
