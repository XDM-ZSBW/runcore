/**
 * Build dictionary.json from approved specs.
 *
 * Scans brain/knowledge/notes/*-spec.md for approved specs,
 * extracts metadata + content, and writes dictionary.json to the project root.
 * This file ships with the npm package so instances can read it without an API.
 *
 * Usage: npx tsx scripts/build-dictionary.ts
 */

import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, basename } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const SPECS_DIR = process.env.CORE_BRAIN_DIR
  ? join(process.env.CORE_BRAIN_DIR, "knowledge", "notes")
  : join(ROOT, "brain", "knowledge", "notes");

interface DictionarySpec {
  name: string;
  title: string;
  status: string;
  content: string;
  checksum: string;
}

interface Dictionary {
  version: string;
  publishedAt: string;
  specs: DictionarySpec[];
  glossary: Record<string, string>;
  defaults: Record<string, Record<string, unknown>>;
}

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

const GLOSSARY: Record<string, string> = {
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

const DEFAULTS = {
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

async function main() {
  // Read version from package.json
  const pkgContent = await readFile(join(ROOT, "package.json"), "utf-8");
  const pkg = JSON.parse(pkgContent) as { version: string };

  // Scan specs (may not exist if brain is external or empty)
  let files: string[] = [];
  try {
    files = await readdir(SPECS_DIR);
  } catch {
    // No specs directory — dictionary ships with glossary and defaults only
  }
  const specs: DictionarySpec[] = [];

  for (const file of files.sort()) {
    if (!file.endsWith("-spec.md")) continue;
    const filePath = join(SPECS_DIR, file);
    const content = await readFile(filePath, "utf-8");
    const status = extractStatus(content);
    if (!isApproved(status)) continue;

    specs.push({
      name: basename(file, ".md"),
      title: extractTitle(content),
      status,
      content,
      checksum: checksum(content),
    });
  }

  const dictionary: Dictionary = {
    version: pkg.version,
    publishedAt: new Date().toISOString(),
    specs,
    glossary: GLOSSARY,
    defaults: DEFAULTS,
  };

  const outPath = join(ROOT, "dictionary.json");
  await writeFile(outPath, JSON.stringify(dictionary, null, 2));

  console.log(`Dictionary v${pkg.version} built: ${specs.length} approved specs`);
  for (const spec of specs) {
    console.log(`  - ${spec.name} (${spec.status})`);
  }
  console.log(`Written to ${outPath}`);
}

main().catch((err) => {
  console.error("Failed to build dictionary:", err);
  process.exit(1);
});
