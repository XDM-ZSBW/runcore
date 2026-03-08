/**
 * Dictionary Protocol — Sync lifecycle.
 *
 * Orchestrates full dictionary sync: check → download → validate → apply.
 * Multiple sources with graceful fallback:
 *   1. Remote API (runcore.sh/api/dictionary)
 *   2. npm package (@runcore-sh/runcore) if installed
 *   3. Local cache (brain/dictionary/)
 *   4. Dev fallback (../Core/brain on same machine)
 *
 * Works standalone — dictionary sync is additive, never required.
 */

import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type {
  Dictionary,
  DictionarySpec,
  DictionaryChangelogEntry,
  SyncResult,
} from "./types.js";
import { compareSemver } from "./versioning.js";
import { validateDictionary } from "./compatibility.js";
import { buildDiff } from "./publisher.js";
import { indexSpecs, buildSpecIndex, type IndexedSpec } from "./matcher.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("dict-sync");

export interface SyncConfig {
  brainDir: string;
  apiBase?: string;
  fetchTimeoutMs?: number;
  projectRoot?: string;
}

export interface BootSyncResult extends SyncResult {
  source: "remote" | "npm" | "local" | "dev" | "none";
  specLines: string[];
  specIndex: string;
  indexedSpecs: IndexedSpec[];
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

function extractTitle(content: string): string {
  const match = content.match(/^#\s+(.+)/m);
  return match ? match[1].trim() : "Untitled";
}

function tryLoadNpmDictionary(projectRoot: string): Dictionary | null {
  try {
    const pkgBase = join(projectRoot, "node_modules", "@runcore-sh", "runcore");
    if (!existsSync(pkgBase)) return null;

    const pkgJsonPath = join(pkgBase, "package.json");
    if (!existsSync(pkgJsonPath)) return null;

    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
    const version = pkg.version as string;

    const dictDir = join(pkgBase, "brain", "dictionary");
    const specsDir = join(pkgBase, "specs");

    const specs: DictionarySpec[] = [];
    const targetDir = existsSync(join(dictDir, "specs")) ? join(dictDir, "specs") : specsDir;

    if (existsSync(targetDir)) {
      const files = readdirSync(targetDir).filter(f => f.endsWith("-spec.md") || f.endsWith(".md"));
      for (const file of files) {
        const content = readFileSync(join(targetDir, file), "utf-8");
        specs.push({
          name: file.replace(/\.md$/, ""),
          title: extractTitle(content),
          status: "Approved",
          content,
          checksum: sha256(content),
        });
      }
    }

    let glossary = {};
    let defaults = {} as Dictionary["defaults"];
    try { glossary = JSON.parse(readFileSync(join(dictDir, "glossary.json"), "utf-8")); } catch {}
    try { defaults = JSON.parse(readFileSync(join(dictDir, "defaults.json"), "utf-8")); } catch {}

    if (specs.length === 0) return null;

    return { version, publishedAt: new Date().toISOString(), specs, glossary, defaults };
  } catch {
    return null;
  }
}

function tryLoadDevDictionary(projectRoot: string): Dictionary | null {
  try {
    const devCore = join(projectRoot, "..", "Core", "brain", "knowledge", "notes");
    if (!existsSync(devCore)) return null;

    const files = readdirSync(devCore).filter(f => f.endsWith("-spec.md")).sort();
    if (files.length === 0) return null;

    const specs: DictionarySpec[] = [];
    for (const file of files) {
      const content = readFileSync(join(devCore, file), "utf-8");
      specs.push({
        name: file.replace(/\.md$/, ""),
        title: extractTitle(content),
        status: "Approved",
        content,
        checksum: sha256(content),
      });
    }

    let version = "0.0.0";
    try {
      const corePkg = join(projectRoot, "..", "Core", "package.json");
      if (existsSync(corePkg)) {
        const pkg = JSON.parse(readFileSync(corePkg, "utf-8"));
        version = pkg.version ?? "0.0.0";
      }
    } catch {}

    return { version, publishedAt: new Date().toISOString(), specs, glossary: {}, defaults: {} as Dictionary["defaults"] };
  } catch {
    return null;
  }
}

async function loadLocalDictionary(dictDir: string): Promise<Dictionary | null> {
  try {
    const specsDir = join(dictDir, "specs");
    if (!existsSync(specsDir)) return null;

    const versionRaw = await readFile(join(dictDir, "version.json"), "utf-8").catch(() => null);
    const version = versionRaw ? (JSON.parse(versionRaw) as { version: string }).version : "0.0.0";

    const files = await readdir(specsDir);
    const mdFiles = files.filter(f => f.endsWith(".md"));
    if (mdFiles.length === 0) return null;

    const specs: DictionarySpec[] = [];
    for (const file of mdFiles) {
      const content = await readFile(join(specsDir, file), "utf-8");
      specs.push({
        name: file.replace(/\.md$/, ""),
        title: extractTitle(content),
        status: "Approved",
        content,
        checksum: sha256(content),
      });
    }

    let glossary = {};
    let defaults = {} as Dictionary["defaults"];
    try { glossary = JSON.parse(await readFile(join(dictDir, "glossary.json"), "utf-8")); } catch {}
    try { defaults = JSON.parse(await readFile(join(dictDir, "defaults.json"), "utf-8")); } catch {}

    return { version, publishedAt: "", specs, glossary, defaults };
  } catch {
    return null;
  }
}

function buildSpecFields(dict: Dictionary): Pick<BootSyncResult, "specLines" | "specIndex" | "indexedSpecs"> {
  const indexed = indexSpecs(dict.specs);
  return {
    specLines: [],
    specIndex: buildSpecIndex(indexed),
    indexedSpecs: indexed,
  };
}

function resolveConflicts(local: Dictionary, remote: Dictionary): {
  merged: Dictionary;
  changelog: DictionaryChangelogEntry;
} {
  const localByName = new Map(local.specs.map(s => [s.name, s]));
  const remoteByName = new Map(remote.specs.map(s => [s.name, s]));

  const specsAdded: string[] = [];
  const specsUpdated: string[] = [];
  const specsRemoved: string[] = [];
  const mergedSpecs: DictionarySpec[] = [];

  for (const spec of remote.specs) {
    const localSpec = localByName.get(spec.name);
    if (!localSpec) {
      specsAdded.push(spec.name);
    } else if (localSpec.checksum !== spec.checksum) {
      specsUpdated.push(spec.name);
    }
    mergedSpecs.push(spec);
  }

  for (const [name] of localByName) {
    if (!remoteByName.has(name)) {
      specsRemoved.push(name);
    }
  }

  const merged: Dictionary = {
    version: remote.version,
    publishedAt: remote.publishedAt,
    specs: mergedSpecs,
    glossary: { ...local.glossary, ...remote.glossary },
    defaults: remote.defaults,
  };

  const changelog: DictionaryChangelogEntry = {
    version: remote.version,
    timestamp: new Date().toISOString(),
    specsAdded,
    specsUpdated,
    specsRemoved,
    summary: `Synced v${remote.version}: ${specsAdded.length} added, ${specsUpdated.length} updated, ${specsRemoved.length} removed`,
  };

  return { merged, changelog };
}

async function persistDictionary(dictDir: string, dict: Dictionary, changelog?: DictionaryChangelogEntry): Promise<void> {
  const specsDir = join(dictDir, "specs");
  await mkdir(specsDir, { recursive: true });

  await writeFile(
    join(dictDir, "version.json"),
    JSON.stringify({ version: dict.version, synced_at: new Date().toISOString() }, null, 2),
  );

  for (const spec of dict.specs) {
    await writeFile(join(specsDir, `${spec.name}.md`), spec.content);
  }

  if (Object.keys(dict.glossary).length > 0) {
    await writeFile(join(dictDir, "glossary.json"), JSON.stringify(dict.glossary, null, 2));
  }
  if (dict.defaults && Object.keys(dict.defaults).length > 0) {
    await writeFile(join(dictDir, "defaults.json"), JSON.stringify(dict.defaults, null, 2));
  }

  if (changelog) {
    await writeFile(
      join(dictDir, "changelog.jsonl"),
      JSON.stringify(changelog) + "\n",
      { flag: "a" },
    );
  }
}

export async function bootSync(config: SyncConfig): Promise<BootSyncResult> {
  const dictDir = join(config.brainDir, "dictionary");
  const projectRoot = config.projectRoot ?? process.cwd();
  const fetchTimeout = config.fetchTimeoutMs ?? 5000;

  const localDict = await loadLocalDictionary(dictDir);
  const localVersion = localDict?.version ?? "0.0.0";

  // 1. Try remote API
  try {
    const res = await fetch(
      `${(config.apiBase ?? "https://runcore.sh/api/dictionary").replace(/\/$/, "")}`,
      { signal: AbortSignal.timeout(fetchTimeout) },
    );
    if (res.ok) {
      const data: unknown = await res.json();
      if (validateDictionary(data)) {
        const remoteDict = data as Dictionary;
        if (compareSemver(remoteDict.version, localVersion) > 0) {
          const emptyDict: Dictionary = { version: "0.0.0", publishedAt: "", specs: [], glossary: {}, defaults: {} as Dictionary["defaults"] };
          const { merged, changelog } = localDict
            ? resolveConflicts(localDict, remoteDict)
            : { merged: remoteDict, changelog: buildDiff(emptyDict, remoteDict) };

          await persistDictionary(dictDir, merged, changelog);
          log.info(`Boot sync: updated to v${merged.version} from remote (${merged.specs.length} specs)`);
          return { status: "updated", localVersion: merged.version, remoteVersion: remoteDict.version, changes: changelog, source: "remote", ...buildSpecFields(merged) };
        } else {
          log.info(`Boot sync: current at v${localVersion}`);
          return { status: "current", localVersion, remoteVersion: remoteDict.version, source: localDict ? "local" : "remote", ...buildSpecFields(localDict ?? remoteDict) };
        }
      }
    }
  } catch {}

  // 2. Try npm package
  const npmDict = tryLoadNpmDictionary(projectRoot);
  if (npmDict && compareSemver(npmDict.version, localVersion) > 0) {
    const emptyDict: Dictionary = { version: "0.0.0", publishedAt: "", specs: [], glossary: {}, defaults: {} as Dictionary["defaults"] };
    const { merged, changelog } = localDict
      ? resolveConflicts(localDict, npmDict)
      : { merged: npmDict, changelog: buildDiff(emptyDict, npmDict) };

    await persistDictionary(dictDir, merged, changelog);
    log.info(`Boot sync: loaded v${merged.version} from npm package (${merged.specs.length} specs)`);
    return { status: "updated", localVersion: merged.version, source: "npm", ...buildSpecFields(merged), changes: changelog };
  }

  // 3. Use local cache
  if (localDict && localDict.specs.length > 0) {
    log.info(`Boot sync: offline — using cached v${localVersion} (${localDict.specs.length} specs)`);
    return { status: "offline", localVersion, source: "local", ...buildSpecFields(localDict) };
  }

  // 4. Dev fallback
  const devDict = tryLoadDevDictionary(projectRoot);
  if (devDict && devDict.specs.length > 0) {
    await persistDictionary(dictDir, devDict);
    log.info(`Boot sync: loaded from dev Core (${devDict.specs.length} specs)`);
    return { status: "updated", localVersion: devDict.version, source: "dev", ...buildSpecFields(devDict) };
  }

  // 5. No dictionary
  log.info("Boot sync: no dictionary available — operating standalone");
  return { status: "offline", localVersion: "0.0.0", source: "none", specLines: [], specIndex: "", indexedSpecs: [] };
}
