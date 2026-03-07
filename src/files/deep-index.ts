/**
 * Deep indexing — background worker for thorough document understanding.
 *
 * Runs after the fast pass (index-local.ts) completes. Processes files
 * through local Ollama at whatever pace the device allows.
 *
 * Pipeline:
 * 1. Entity extraction — people, projects, dates, organizations
 * 2. Theme discovery — recurring topics across documents
 * 3. Cross-referencing — connections between imported docs and existing memory
 * 4. Flags — documents needing human review (conflicts, outdated info)
 *
 * Results feed the nerve state:
 * - Work dot goes green during processing
 * - Joy dot goes green when patterns emerge
 *
 * All processing local. Membrane protects any outbound call.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join, resolve, extname } from "node:path";
import { existsSync } from "node:fs";
import { createLogger } from "../utils/logger.js";

const log = createLogger("deep-index");
const BRAIN_DIR = resolve(process.cwd(), "brain");

// ── Types ────────────────────────────────────────────────────────────────────

interface Entity {
  name: string;
  type: "person" | "org" | "project" | "date" | "place" | "concept";
  source: string; // file path
  context: string; // surrounding sentence
}

interface Theme {
  label: string;
  confidence: number; // 0-1
  sources: string[]; // file paths that mention it
  summary: string;
}

interface CrossRef {
  sourceFile: string;
  targetFile: string;
  relationship: string; // "mentions", "extends", "contradicts", "updates"
  detail: string;
}

interface Flag {
  file: string;
  reason: string;
  type: "conflict" | "outdated" | "incomplete" | "review";
}

interface DeepIndexResult {
  entities: Entity[];
  themes: Theme[];
  crossRefs: CrossRef[];
  flags: Flag[];
  filesProcessed: number;
}

interface DeepManifest {
  deepIndexed: string[];
  lastRun: string;
  entities: Entity[];
  themes: Theme[];
  crossRefs: CrossRef[];
  flags: Flag[];
}

const DEEP_MANIFEST_PATH = join(BRAIN_DIR, ".core", "deep-index.json");

// ── State ────────────────────────────────────────────────────────────────────

let running = false;
let progress = { total: 0, done: 0, phase: "idle" as string };

export function getDeepIndexProgress() {
  return { ...progress, running };
}

// ── Ollama helper ────────────────────────────────────────────────────────────

async function askOllama(prompt: string, system: string): Promise<string> {
  const { streamChatLocal } = await import("../llm/ollama.js");
  const chunks: string[] = [];
  await new Promise<void>((res, rej) => {
    streamChatLocal({
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
      model: "auto",
      onToken: (t) => { chunks.push(t); },
      onDone: () => res(),
      onError: (e) => rej(e),
    });
  });
  return chunks.join("");
}

// ── Load / Save ──────────────────────────────────────────────────────────────

async function loadDeepManifest(): Promise<DeepManifest> {
  try {
    const raw = await readFile(DEEP_MANIFEST_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { deepIndexed: [], lastRun: "", entities: [], themes: [], crossRefs: [], flags: [] };
  }
}

async function saveDeepManifest(manifest: DeepManifest): Promise<void> {
  await writeFile(DEEP_MANIFEST_PATH, JSON.stringify(manifest, null, 2), "utf-8");
}

// ── Entity extraction ────────────────────────────────────────────────────────

async function extractEntities(content: string, filePath: string): Promise<Entity[]> {
  try {
    const truncated = content.length > 3000 ? content.slice(0, 3000) : content;
    const response = await askOllama(truncated,
      `Extract named entities from this document. Return one per line in format:
TYPE|NAME|CONTEXT
Where TYPE is person, org, project, date, place, or concept.
CONTEXT is the sentence where it appears (abbreviated).
Only return entities, nothing else. If none found, return NONE.`
    );

    if (response.trim() === "NONE" || !response.trim()) return [];

    return response.trim().split("\n")
      .map(line => {
        const parts = line.split("|").map(p => p.trim());
        if (parts.length < 2) return null;
        const type = parts[0].toLowerCase() as Entity["type"];
        if (!["person", "org", "project", "date", "place", "concept"].includes(type)) return null;
        return {
          name: parts[1],
          type,
          source: filePath,
          context: parts[2] || "",
        };
      })
      .filter((e): e is Entity => e !== null);
  } catch {
    return [];
  }
}

// ── Theme discovery ──────────────────────────────────────────────────────────

async function discoverThemes(
  fileSummaries: { path: string; summary: string }[]
): Promise<Theme[]> {
  if (fileSummaries.length < 2) return [];

  try {
    const combined = fileSummaries
      .map((f, i) => `[${i + 1}] ${f.path}: ${f.summary}`)
      .join("\n");

    const truncated = combined.length > 4000 ? combined.slice(0, 4000) : combined;

    const response = await askOllama(truncated,
      `These are summaries of documents in a personal knowledge base. Identify 1-5 recurring themes.
For each theme, return one line:
THEME|CONFIDENCE|DOCUMENT_NUMBERS|ONE_SENTENCE_SUMMARY
CONFIDENCE is 0.0-1.0. DOCUMENT_NUMBERS are comma-separated [N] references.
Only return themes, nothing else. If no clear themes, return NONE.`
    );

    if (response.trim() === "NONE" || !response.trim()) return [];

    return response.trim().split("\n")
      .map(line => {
        const parts = line.split("|").map(p => p.trim());
        if (parts.length < 3) return null;
        const confidence = parseFloat(parts[1]);
        if (isNaN(confidence)) return null;

        // Resolve document numbers to file paths
        const docNums = parts[2].match(/\d+/g)?.map(n => parseInt(n) - 1) || [];
        const sources = docNums
          .filter(n => n >= 0 && n < fileSummaries.length)
          .map(n => fileSummaries[n].path);

        return {
          label: parts[0],
          confidence: Math.min(1, Math.max(0, confidence)),
          sources,
          summary: parts[3] || parts[0],
        };
      })
      .filter((t): t is Theme => t !== null);
  } catch {
    return [];
  }
}

// ── Cross-referencing ────────────────────────────────────────────────────────

async function findCrossRefs(
  fileSummaries: { path: string; summary: string }[]
): Promise<CrossRef[]> {
  if (fileSummaries.length < 2) return [];

  try {
    const combined = fileSummaries
      .map((f, i) => `[${i + 1}] ${f.path}: ${f.summary}`)
      .join("\n");

    const truncated = combined.length > 4000 ? combined.slice(0, 4000) : combined;

    const response = await askOllama(truncated,
      `These are summaries from a knowledge base. Find connections between documents.
For each connection, return one line:
SOURCE_NUM|TARGET_NUM|RELATIONSHIP|DETAIL
RELATIONSHIP is: mentions, extends, contradicts, or updates.
Only return connections, nothing else. Max 10. If none, return NONE.`
    );

    if (response.trim() === "NONE" || !response.trim()) return [];

    return response.trim().split("\n")
      .slice(0, 10)
      .map(line => {
        const parts = line.split("|").map(p => p.trim());
        if (parts.length < 3) return null;
        const src = parseInt(parts[0]) - 1;
        const tgt = parseInt(parts[1]) - 1;
        if (isNaN(src) || isNaN(tgt) || src < 0 || tgt < 0) return null;
        if (src >= fileSummaries.length || tgt >= fileSummaries.length) return null;

        return {
          sourceFile: fileSummaries[src].path,
          targetFile: fileSummaries[tgt].path,
          relationship: parts[2] as CrossRef["relationship"],
          detail: parts[3] || "",
        };
      })
      .filter((r): r is CrossRef => r !== null);
  } catch {
    return [];
  }
}

// ── Document flagging ────────────────────────────────────────────────────────

async function flagDocument(content: string, filePath: string): Promise<Flag | null> {
  // Quick heuristic checks (no LLM needed)
  const lines = content.split("\n");

  // Check for old dates (more than 2 years ago)
  const yearMatch = content.match(/\b(20[0-1]\d|19\d{2})\b/);
  if (yearMatch) {
    const year = parseInt(yearMatch[1]);
    if (year < new Date().getFullYear() - 2) {
      return { file: filePath, reason: `References year ${year} — may be outdated`, type: "outdated" };
    }
  }

  // Check for TODO/FIXME/INCOMPLETE markers
  if (/\b(TODO|FIXME|INCOMPLETE|DRAFT|WIP)\b/i.test(content)) {
    return { file: filePath, reason: "Contains TODO/FIXME/DRAFT markers", type: "incomplete" };
  }

  return null;
}

// ── Main deep index ──────────────────────────────────────────────────────────

export async function runDeepIndex(options?: {
  batchSize?: number;
}): Promise<DeepIndexResult> {
  if (running) {
    log.info("Deep indexing already running — skipping");
    return { entities: [], themes: [], crossRefs: [], flags: [], filesProcessed: 0 };
  }

  running = true;
  const batchSize = options?.batchSize ?? 30;

  try {
    // Load manifests
    const deepManifest = await loadDeepManifest();
    const alreadyDeep = new Set(deepManifest.deepIndexed);

    // Load import manifest for file list
    const importManifestPath = join(BRAIN_DIR, ".core", "import-manifest.json");
    if (!existsSync(importManifestPath)) {
      return { entities: [], themes: [], crossRefs: [], flags: [], filesProcessed: 0 };
    }

    const importManifest = JSON.parse(await readFile(importManifestPath, "utf-8"));
    const importedFiles: { destination: string; category: string }[] = importManifest.files || [];

    // Filter to unprocessed text files
    const textExts = new Set([".md", ".txt", ".yaml", ".yml", ".json", ".csv"]);
    const toProcess = importedFiles
      .filter(f => !alreadyDeep.has(f.destination))
      .filter(f => textExts.has(extname(f.destination).toLowerCase()))
      .slice(0, batchSize);

    if (toProcess.length === 0) {
      running = false;
      return { entities: [], themes: [], crossRefs: [], flags: [], filesProcessed: 0 };
    }

    progress = { total: toProcess.length, done: 0, phase: "entities" };
    log.info(`Deep indexing ${toProcess.length} files...`);

    // Notify nerve state
    const { appendBrainLine } = await import("../lib/brain-io.js");
    const notifPath = join(BRAIN_DIR, "operations", "notifications.jsonl");
    await appendBrainLine(notifPath, JSON.stringify({
      timestamp: new Date().toISOString(),
      message: `Deep indexing started: ${toProcess.length} files`,
      source: "deep-index",
    }));

    // Phase 1: Read files and extract entities
    const allEntities: Entity[] = [];
    const fileSummaries: { path: string; summary: string }[] = [];
    const allFlags: Flag[] = [];

    for (const file of toProcess) {
      const fullPath = join(BRAIN_DIR, file.destination);
      if (!existsSync(fullPath)) {
        deepManifest.deepIndexed.push(file.destination);
        continue;
      }

      try {
        const content = await readFile(fullPath, "utf-8");
        if (!content.trim()) continue;

        // Extract entities
        const entities = await extractEntities(content, file.destination);
        allEntities.push(...entities);

        // Build summary for theme/cross-ref analysis
        const firstLines = content.split("\n").filter(l => l.trim()).slice(0, 5).join(" ");
        fileSummaries.push({
          path: file.destination,
          summary: firstLines.slice(0, 300),
        });

        // Flag checks
        const flag = await flagDocument(content, file.destination);
        if (flag) allFlags.push(flag);

        deepManifest.deepIndexed.push(file.destination);
        progress.done++;
      } catch (err) {
        log.warn(`Deep index failed for ${file.destination}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Phase 2: Theme discovery (across all files)
    progress.phase = "themes";
    const themes = await discoverThemes(fileSummaries);

    // Phase 3: Cross-referencing
    progress.phase = "cross-refs";
    const crossRefs = await findCrossRefs(fileSummaries);

    // Store results
    deepManifest.entities.push(...allEntities);
    deepManifest.themes = mergeThemes(deepManifest.themes, themes);
    deepManifest.crossRefs.push(...crossRefs);
    deepManifest.flags.push(...allFlags);
    deepManifest.lastRun = new Date().toISOString();
    await saveDeepManifest(deepManifest);

    // Write entities to semantic memory
    const semanticPath = join(BRAIN_DIR, "memory", "semantic.jsonl");
    for (const entity of allEntities) {
      await appendBrainLine(semanticPath, JSON.stringify({
        id: `entity_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        type: "semantic",
        content: `${entity.type}: ${entity.name} — ${entity.context}`,
        meta: { source: entity.source, entityType: entity.type, importedFrom: "deep-index" },
        createdAt: new Date().toISOString(),
      }));
    }

    // Notify completion
    const discoveryCount = themes.length + crossRefs.length;
    await appendBrainLine(notifPath, JSON.stringify({
      timestamp: new Date().toISOString(),
      message: `Deep indexing complete: ${allEntities.length} entities, ${themes.length} themes, ${crossRefs.length} connections, ${allFlags.length} flags`,
      source: "deep-index",
    }));

    if (discoveryCount > 0) {
      log.info(`Deep index discoveries: ${themes.length} themes, ${crossRefs.length} cross-refs`);
    }

    progress = { total: 0, done: 0, phase: "idle" };
    running = false;

    return {
      entities: allEntities,
      themes,
      crossRefs,
      flags: allFlags,
      filesProcessed: toProcess.length,
    };
  } catch (err) {
    running = false;
    progress = { total: 0, done: 0, phase: "idle" };
    log.error("Deep indexing failed", { error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

/** Merge new themes with existing, deduplicating by label similarity. */
function mergeThemes(existing: Theme[], incoming: Theme[]): Theme[] {
  const merged = [...existing];
  for (const theme of incoming) {
    const match = merged.find(t =>
      t.label.toLowerCase() === theme.label.toLowerCase()
    );
    if (match) {
      // Merge sources
      const allSources = new Set([...match.sources, ...theme.sources]);
      match.sources = Array.from(allSources);
      match.confidence = Math.max(match.confidence, theme.confidence);
    } else {
      merged.push(theme);
    }
  }
  return merged;
}
