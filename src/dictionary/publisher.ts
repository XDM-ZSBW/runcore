/**
 * Dictionary Protocol — Publisher.
 *
 * Core publishes the dictionary by scanning specs/ for approved specs,
 * building the dictionary payload, and writing to brain/dictionary/.
 */

import { createHash } from "node:crypto";
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, basename } from "node:path";
import type {
  Dictionary,
  DictionarySpec,
  DictionaryDefaults,
  DictionaryChangelogEntry,
  Glossary,
} from "./types.js";

const DEFAULT_VALUES: DictionaryDefaults = {
  dehydration: {
    quiet_threshold_multiplier: 2,
    stage_duration: "30d",
    grace_period: "30d",
  },
  calibration: {
    recalibration_interval_interactions: 200,
    recalibration_interval_ticks: 500,
  },
  posture: {
    board_decay_minutes: 5,
    pulse_decay_minutes: 30,
  },
  pain: {
    token_budget_warn: 0.75,
    error_spike_threshold: 3,
  },
};

const DEFAULT_GLOSSARY: Glossary = {
  brain: "The local file-based data store for an instance. Always local. Never hosted.",
  membrane: "The translation boundary between inside and outside a brain.",
  nerve: "An interface channel between the brain and a human. Five types.",
  compost: "Anonymous typed signal shared through the field. Lessons, not data.",
  bond: "A bilateral cryptographic trust relationship between two brains.",
  dictionary: "The canonical set of specs, patterns, and protocols that define how Core works.",
  field: "The shared anonymous signal layer. No identity, no addresses, just patterns.",
  vault: "Encrypted local credential storage. Secrets never travel in prompts.",
  pulse: "Three dots: Sense, Work, Joy. The flywheel. Core's core feature.",
  calibration: "Periodic self-assessment of an instance's configuration and behavior.",
  dehydration: "Lifecycle process for inactive brain entries. Quiet -> dormant -> archived.",
  posture: "The instance's current operational stance. Two gears: calm and crisis.",
};

function checksum(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

function extractStatus(content: string): string {
  const blockquoteMatch = content.match(/>\s*Status:\s*(.+)/i);
  if (blockquoteMatch) return blockquoteMatch[1].trim().replace(/\*\*/g, "");
  const boldMatch = content.match(/\*\*Status:\*\*\s*(.+)/i);
  if (boldMatch) return boldMatch[1].trim().replace(/\*\*/g, "");
  return "unknown";
}

function extractTitle(content: string): string {
  const match = content.match(/^#\s+(.+)/m);
  return match ? match[1].trim() : "Untitled";
}

function isApproved(status: string): boolean {
  const s = status.toLowerCase();
  return s.startsWith("approved") || s.startsWith("done");
}

export async function scanSpecs(specsDir: string): Promise<DictionarySpec[]> {
  const entries: DictionarySpec[] = [];
  let files: string[];
  try {
    files = await readdir(specsDir);
  } catch {
    return entries;
  }

  for (const file of files) {
    if (!file.endsWith("-spec.md")) continue;
    const filePath = join(specsDir, file);
    const content = await readFile(filePath, "utf-8");
    const status = extractStatus(content);
    if (!isApproved(status)) continue;

    entries.push({
      name: basename(file, ".md"),
      title: extractTitle(content),
      status,
      content,
      checksum: checksum(content),
    });
  }

  return entries;
}

export interface PublishOptions {
  rootDir: string;
  version?: string;
  glossary?: Glossary;
  defaults?: Partial<DictionaryDefaults>;
}

export async function publishDictionary(options: PublishOptions): Promise<Dictionary> {
  const { rootDir } = options;
  const specsDir = join(rootDir, "specs");
  const dictDir = join(rootDir, "brain", "dictionary");

  let version = options.version;
  if (!version) {
    const pkgPath = join(rootDir, "package.json");
    const pkgContent = await readFile(pkgPath, "utf-8");
    const pkg = JSON.parse(pkgContent) as { version: string };
    version = pkg.version;
  }

  const specs = await scanSpecs(specsDir);
  const glossary: Glossary = { ...DEFAULT_GLOSSARY, ...options.glossary };
  const defaults: DictionaryDefaults = options.defaults
    ? { ...DEFAULT_VALUES, ...options.defaults } as DictionaryDefaults
    : DEFAULT_VALUES;

  const now = new Date().toISOString();
  const dictionary: Dictionary = { version, publishedAt: now, specs, glossary, defaults };

  await mkdir(dictDir, { recursive: true });
  await mkdir(join(dictDir, "specs"), { recursive: true });

  await writeFile(
    join(dictDir, "version.json"),
    JSON.stringify({ version, synced_at: now }, null, 2),
  );

  for (const spec of specs) {
    await writeFile(join(dictDir, "specs", `${spec.name}.md`), spec.content);
  }

  await writeFile(join(dictDir, "glossary.json"), JSON.stringify(glossary, null, 2));
  await writeFile(join(dictDir, "defaults.json"), JSON.stringify(defaults, null, 2));

  const changelogEntry: DictionaryChangelogEntry = {
    version,
    timestamp: now,
    specsAdded: specs.map((s) => s.name),
    specsUpdated: [],
    specsRemoved: [],
    summary: `Published dictionary v${version} with ${specs.length} specs`,
  };
  await writeFile(
    join(dictDir, "changelog.jsonl"),
    JSON.stringify(changelogEntry) + "\n",
    { flag: "a" },
  );

  return dictionary;
}

export function buildDiff(
  oldDict: Dictionary,
  newDict: Dictionary,
): DictionaryChangelogEntry {
  const oldNames = new Set(oldDict.specs.map((s) => s.name));
  const newNames = new Set(newDict.specs.map((s) => s.name));
  const oldChecksums = new Map(oldDict.specs.map((s) => [s.name, s.checksum]));

  const specsAdded: string[] = [];
  const specsUpdated: string[] = [];
  const specsRemoved: string[] = [];

  for (const spec of newDict.specs) {
    if (!oldNames.has(spec.name)) {
      specsAdded.push(spec.name);
    } else if (oldChecksums.get(spec.name) !== spec.checksum) {
      specsUpdated.push(spec.name);
    }
  }

  for (const name of oldNames) {
    if (!newNames.has(name)) {
      specsRemoved.push(name);
    }
  }

  return {
    version: newDict.version,
    timestamp: newDict.publishedAt,
    specsAdded,
    specsUpdated,
    specsRemoved,
    summary: `${specsAdded.length} added, ${specsUpdated.length} updated, ${specsRemoved.length} removed`,
  };
}
