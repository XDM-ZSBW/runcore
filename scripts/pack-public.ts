/**
 * pack-public.ts — Strip gated .js/.js.map from dist/ for npm publish.
 *
 * Reads module-tiers.json, identifies all non-local paths,
 * removes their .js and .js.map files from dist/ while keeping .d.ts stubs.
 * This ensures the npm package ships type definitions for autocomplete
 * but no runtime code for gated modules.
 *
 * Usage: tsx scripts/pack-public.ts [--dry-run]
 */

import { readFile, unlink, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { glob } from "node:fs/promises";

const ROOT = resolve(import.meta.dirname, "..");
const DIST = join(ROOT, "dist");
const TIERS_FILE = join(ROOT, "module-tiers.json");
const DRY_RUN = process.argv.includes("--dry-run");

interface TierConfig {
  description: string;
  tier?: string;
  paths: string[];
  dependencies?: Record<string, string>;
}

interface TiersFile {
  local: TierConfig;
  "ext-byok": TierConfig;
  "ext-spawn": TierConfig;
  "ext-hosted": TierConfig;
  [key: string]: unknown;
}

async function main() {
  const tiers = JSON.parse(await readFile(TIERS_FILE, "utf-8")) as TiersFile;

  // Collect all non-local (gated) paths
  const gatedPaths: string[] = [];
  for (const [key, config] of Object.entries(tiers)) {
    if (key === "local" || key === "$schema") continue;
    if (typeof config === "object" && config !== null && "paths" in config) {
      gatedPaths.push(...(config as TierConfig).paths);
    }
  }

  console.log(`Found ${gatedPaths.length} gated path patterns to strip.\n`);

  let removed = 0;
  let kept = 0;

  for (const srcPath of gatedPaths) {
    // Convert src/ path to dist/ path pattern
    const distPath = srcPath.replace(/^src\//, "");

    if (distPath.endsWith("/")) {
      // Directory — remove all .js and .js.map files, keep .d.ts
      await stripDirectory(join(DIST, distPath));
    } else if (distPath.endsWith(".ts")) {
      // Single file — convert .ts to .js/.js.map
      const basePath = distPath.replace(/\.ts$/, "");
      await stripFile(join(DIST, basePath + ".js"));
      await stripFile(join(DIST, basePath + ".js.map"));
    }
  }

  async function stripDirectory(dir: string) {
    try {
      // Use readdir recursively to find .js and .js.map files
      const { readdir } = await import("node:fs/promises");
      const entries = await readdir(dir, { recursive: true }).catch(() => [] as string[]);
      for (const entry of entries) {
        const full = join(dir, entry);
        if (entry.endsWith(".js") || entry.endsWith(".js.map")) {
          await stripFile(full);
        } else if (entry.endsWith(".d.ts") || entry.endsWith(".d.ts.map")) {
          kept++;
        }
      }
    } catch {
      // Directory doesn't exist in dist — that's fine
    }
  }

  async function stripFile(filePath: string) {
    try {
      await access(filePath);
      if (DRY_RUN) {
        console.log(`  [dry-run] would remove: ${filePath.replace(DIST, "dist")}`);
      } else {
        await unlink(filePath);
      }
      removed++;
    } catch {
      // File doesn't exist — skip
    }
  }

  console.log(`\n${DRY_RUN ? "Would remove" : "Removed"}: ${removed} files`);
  console.log(`Kept: ${kept} .d.ts stubs for autocomplete`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
