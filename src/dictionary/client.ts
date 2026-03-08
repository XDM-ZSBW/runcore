/**
 * Dictionary Protocol — Instance client.
 *
 * Handles dictionary sync for instances:
 * - Check for updates on boot
 * - Periodic checks (every 24h)
 * - Offline-safe: uses local dictionary when remote is unreachable
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  Dictionary,
  DictionaryVersionFile,
  DictionaryChangelogEntry,
  SyncResult,
} from "./types.js";
import { compareSemver } from "./versioning.js";
import { checkCompatibility, validateDictionary } from "./compatibility.js";

const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_API_BASE = "https://runcore.sh/api/dictionary";

export interface DictionaryClientOptions {
  brainDir: string;
  apiBase?: string;
  syncIntervalMs?: number;
}

export class DictionaryClient {
  private readonly dictDir: string;
  private readonly apiBase: string;
  private readonly syncIntervalMs: number;
  private lastSyncCheck: number = 0;

  constructor(options: DictionaryClientOptions) {
    this.dictDir = join(options.brainDir, "dictionary");
    this.apiBase = (options.apiBase ?? DEFAULT_API_BASE).replace(/\/$/, "");
    this.syncIntervalMs = options.syncIntervalMs ?? SYNC_INTERVAL_MS;
  }

  async getLocalVersion(): Promise<string> {
    try {
      const raw = await readFile(join(this.dictDir, "version.json"), "utf-8");
      const parsed = JSON.parse(raw) as DictionaryVersionFile;
      return parsed.version;
    } catch {
      return "0.0.0";
    }
  }

  async getLocalVersionFile(): Promise<DictionaryVersionFile | null> {
    try {
      const raw = await readFile(join(this.dictDir, "version.json"), "utf-8");
      return JSON.parse(raw) as DictionaryVersionFile;
    } catch {
      return null;
    }
  }

  async fetchRemoteVersion(): Promise<string | null> {
    try {
      const res = await fetch(`${this.apiBase}/version`);
      if (!res.ok) return null;
      const data = (await res.json()) as { version: string };
      return data.version;
    } catch {
      return null;
    }
  }

  async fetchRemoteDictionary(): Promise<Dictionary | null> {
    try {
      const res = await fetch(this.apiBase);
      if (!res.ok) return null;
      const data: unknown = await res.json();
      if (!validateDictionary(data)) return null;
      return data;
    } catch {
      return null;
    }
  }

  private async applyUpdate(dict: Dictionary): Promise<DictionaryChangelogEntry> {
    await mkdir(join(this.dictDir, "specs"), { recursive: true });

    const now = new Date().toISOString();
    await writeFile(
      join(this.dictDir, "version.json"),
      JSON.stringify({ version: dict.version, synced_at: now }, null, 2),
    );

    for (const spec of dict.specs) {
      await writeFile(join(this.dictDir, "specs", `${spec.name}.md`), spec.content);
    }

    await writeFile(join(this.dictDir, "glossary.json"), JSON.stringify(dict.glossary, null, 2));
    await writeFile(join(this.dictDir, "defaults.json"), JSON.stringify(dict.defaults, null, 2));

    const entry: DictionaryChangelogEntry = {
      version: dict.version,
      timestamp: now,
      specsAdded: dict.specs.map((s) => s.name),
      specsUpdated: [],
      specsRemoved: [],
      summary: `Synced dictionary v${dict.version} with ${dict.specs.length} specs`,
    };

    await writeFile(
      join(this.dictDir, "changelog.jsonl"),
      JSON.stringify(entry) + "\n",
      { flag: "a" },
    );

    return entry;
  }

  async sync(options?: { force?: boolean }): Promise<SyncResult> {
    const localVersion = await this.getLocalVersion();

    if (!options?.force) {
      const now = Date.now();
      if (this.lastSyncCheck > 0 && now - this.lastSyncCheck < this.syncIntervalMs) {
        return { status: "current", localVersion };
      }
    }

    this.lastSyncCheck = Date.now();

    const remoteVersion = await this.fetchRemoteVersion();
    if (remoteVersion === null) {
      return { status: "offline", localVersion };
    }

    if (compareSemver(remoteVersion, localVersion) <= 0) {
      return { status: "current", localVersion, remoteVersion };
    }

    const remoteDictionary = await this.fetchRemoteDictionary();
    if (!remoteDictionary) {
      return { status: "offline", localVersion };
    }

    const compat = checkCompatibility(localVersion, remoteDictionary);
    if (!compat.compatible) {
      const entry: DictionaryChangelogEntry = {
        version: remoteVersion,
        timestamp: new Date().toISOString(),
        specsAdded: [],
        specsUpdated: [],
        specsRemoved: [],
        summary: `Skipped incompatible update: ${compat.breakingChanges.join("; ")}`,
      };
      await mkdir(this.dictDir, { recursive: true });
      await writeFile(
        join(this.dictDir, "changelog.jsonl"),
        JSON.stringify(entry) + "\n",
        { flag: "a" },
      );
      return { status: "current", localVersion, remoteVersion };
    }

    const changes = await this.applyUpdate(remoteDictionary);
    return {
      status: "updated",
      localVersion: remoteDictionary.version,
      remoteVersion,
      changes,
    };
  }

  async tickCheck(): Promise<SyncResult> {
    return this.sync({ force: false });
  }

  async bootSync(): Promise<SyncResult> {
    return this.sync({ force: true });
  }
}
