/**
 * Local indexing — process imported files through Ollama for semantic retrieval.
 *
 * All processing runs on-device. The membrane guarantees that if any content
 * accidentally reaches a cloud LLM, sensitive data is replaced with typed
 * placeholders before network egress.
 *
 * Pipeline:
 * 1. Read imported files from brain/
 * 2. Scan for sensitive terms → auto-register with SensitiveRegistry
 * 3. Generate summaries via local Ollama (never cloud)
 * 4. Store summaries as semantic memory entries (brain/memory/semantic.jsonl)
 *
 * The import manifest (brain/.core/import-manifest.json) tracks what's been
 * indexed so we don't re-process files.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join, resolve, extname } from "node:path";
import { existsSync } from "node:fs";
import { createLogger } from "../utils/logger.js";

const log = createLogger("index-local");
import { BRAIN_DIR } from "../lib/paths.js";

interface IndexManifest {
  indexed: string[];
  lastRun: string;
}

const INDEX_MANIFEST_PATH = join(BRAIN_DIR, ".core", "index-manifest.json");

async function loadIndexManifest(): Promise<IndexManifest> {
  try {
    const raw = await readFile(INDEX_MANIFEST_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { indexed: [], lastRun: "" };
  }
}

async function saveIndexManifest(manifest: IndexManifest): Promise<void> {
  await writeFile(INDEX_MANIFEST_PATH, JSON.stringify(manifest, null, 2), "utf-8");
}

/** Scan text for potential sensitive content and auto-register with the registry. */
export function detectSensitiveTerms(
  text: string,
  fileName: string
): { category: string; hint: string }[] {
  const found: { category: string; hint: string }[] = [];

  // Email addresses
  const emails = text.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g);
  if (emails) {
    for (const email of new Set(emails)) {
      found.push({ category: "EMAIL", hint: email });
    }
  }

  // Phone numbers
  const phones = text.match(/\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g);
  if (phones) {
    for (const phone of new Set(phones)) {
      found.push({ category: "PHONE", hint: phone });
    }
  }

  // Physical addresses (simple heuristic: number + street name + type)
  const addresses = text.match(/\b\d{1,5}\s+[A-Za-z]+\s+(?:St|Ave|Rd|Dr|Blvd|Ln|Way|Ct|Pl|Cir)\.?\b/gi);
  if (addresses) {
    for (const addr of new Set(addresses)) {
      found.push({ category: "ADDRESS", hint: addr });
    }
  }

  // Dates of birth context (e.g., "born on", "DOB:", "date of birth")
  const dobContext = text.match(/(?:born\s+(?:on\s+)?|DOB[:\s]+|date\s+of\s+birth[:\s]+)\d{1,2}[/\-\.]\d{1,2}[/\-\.]\d{2,4}/gi);
  if (dobContext) {
    for (const dob of new Set(dobContext)) {
      found.push({ category: "DOB", hint: dob });
    }
  }

  return found;
}

/**
 * Index imported files locally using Ollama.
 * Generates summaries and stores as semantic memory.
 * All processing stays on-device.
 */
export async function indexImportedFiles(options: {
  /** Force local-only (Ollama). If false, uses whatever provider is configured. */
  localOnly?: boolean;
  /** Max files to index per run */
  batchSize?: number;
}): Promise<{ indexed: number; sensitive: number; skipped: number }> {
  const { localOnly = true, batchSize = 20 } = options;

  // Load import manifest to know what files exist
  const importManifestPath = join(BRAIN_DIR, ".core", "import-manifest.json");
  if (!existsSync(importManifestPath)) {
    return { indexed: 0, sensitive: 0, skipped: 0 };
  }

  const importManifest = JSON.parse(await readFile(importManifestPath, "utf-8"));
  const importedFiles: { destination: string; category: string }[] = importManifest.files || [];

  // Load index manifest to know what's already indexed
  const indexManifest = await loadIndexManifest();
  const alreadyIndexed = new Set(indexManifest.indexed);

  // Filter to unindexed text files
  const textExts = new Set([".md", ".txt", ".yaml", ".yml", ".json", ".csv"]);
  const toIndex = importedFiles
    .filter(f => !alreadyIndexed.has(f.destination))
    .filter(f => textExts.has(extname(f.destination).toLowerCase()))
    .slice(0, batchSize);

  if (toIndex.length === 0) {
    return { indexed: 0, sensitive: 0, skipped: 0 };
  }

  let indexed = 0;
  let sensitiveCount = 0;
  const { appendBrainLine, ensureBrainJsonl } = await import("../lib/brain-io.js");
  const semanticPath = join(BRAIN_DIR, "memory", "semantic.jsonl");
  await ensureBrainJsonl(semanticPath, JSON.stringify({ _schema: "semantic", _version: "1.0" }));

  // Auto-detect sensitive terms and write to sensitive.yaml
  const newSensitiveTerms: { value: string; category: string }[] = [];

  for (const file of toIndex) {
    const fullPath = join(BRAIN_DIR, file.destination);
    if (!existsSync(fullPath)) {
      indexManifest.indexed.push(file.destination);
      continue;
    }

    try {
      const content = await readFile(fullPath, "utf-8");
      if (!content.trim()) continue;

      // Detect sensitive terms
      const sensitive = detectSensitiveTerms(content, file.destination);
      for (const term of sensitive) {
        newSensitiveTerms.push({ value: term.hint, category: term.category });
        sensitiveCount++;
      }

      // Generate summary locally
      let summary = "";
      if (localOnly) {
        try {
          const { streamChatLocal } = await import("../llm/ollama.js");
          const chunks: string[] = [];
          // Truncate content to avoid overloading small models
          const truncated = content.length > 4000 ? content.slice(0, 4000) + "\n...[truncated]" : content;
          await new Promise<void>((res, rej) => {
            streamChatLocal({
              messages: [
                { role: "system", content: "Summarize this document in 2-3 sentences. Focus on key facts, decisions, and actionable information. Be concise." },
                { role: "user", content: truncated },
              ],
              model: "auto",
              onToken: (t) => { chunks.push(t); },
              onDone: () => res(),
              onError: (e) => rej(e),
            });
          });
          summary = chunks.join("");
        } catch {
          // Ollama not available — store raw first line as summary
          summary = content.split("\n").filter(l => l.trim())[0]?.slice(0, 200) || file.destination;
        }
      } else {
        // Fallback: first meaningful line as summary (membrane protects if cloud is used)
        summary = content.split("\n").filter(l => l.trim())[0]?.slice(0, 200) || file.destination;
      }

      // Store as semantic memory entry
      const entry = {
        id: `import_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        type: "semantic",
        content: summary,
        meta: {
          source: file.destination,
          category: file.category,
          importedFrom: "local-import",
        },
        createdAt: new Date().toISOString(),
      };
      await appendBrainLine(semanticPath, JSON.stringify(entry));
      indexManifest.indexed.push(file.destination);
      indexed++;
    } catch (err) {
      log.warn(`Failed to index ${file.destination}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Append new sensitive terms to sensitive.yaml
  if (newSensitiveTerms.length > 0) {
    await appendSensitiveTerms(newSensitiveTerms);
    log.info(`Auto-detected ${newSensitiveTerms.length} sensitive terms from imported files`);
  }

  // Save index manifest
  indexManifest.lastRun = new Date().toISOString();
  await saveIndexManifest(indexManifest);

  log.info(`Indexed ${indexed} files, detected ${sensitiveCount} sensitive terms`);
  return { indexed, sensitive: sensitiveCount, skipped: toIndex.length - indexed };
}

/** Append auto-detected sensitive terms to brain/knowledge/sensitive.yaml */
async function appendSensitiveTerms(
  terms: { value: string; category: string }[]
): Promise<void> {
  const filePath = join(BRAIN_DIR, "knowledge", "sensitive.yaml");
  let existing = "";
  try {
    existing = await readFile(filePath, "utf-8");
  } catch { /* new file */ }

  // Deduplicate against existing content
  const newEntries = terms
    .filter(t => !existing.includes(t.value))
    .map(t => `- value: "${t.value.replace(/"/g, '\\"')}"\n  category: ${t.category}`)
    .join("\n");

  if (newEntries) {
    const header = existing ? "\n# Auto-detected from imported files\n" : "# Sensitive terms — auto-detected + manual\n# The membrane replaces these with <<CATEGORY_N>> before any LLM API call.\n\n";
    await writeFile(filePath, existing + header + newEntries + "\n", "utf-8");
  }
}
