/**
 * pack-extensions.ts — Bundle gated modules into signed extension packages.
 *
 * Reads module-tiers.json, collects compiled .js files from dist/,
 * creates a JSON bundle with manifest + base64-encoded files for each extension.
 * Signs the manifest with Ed25519 deployment key.
 *
 * Output:
 *   dist/.extensions/
 *     ext-byok.json
 *     ext-spawn.json
 *     ext-hosted.json
 *
 * These bundles are uploaded to R2 and served by runcore.sh.
 *
 * Usage: tsx scripts/pack-extensions.ts [--key <private-key-path>]
 */

import { readFile, writeFile, mkdir, readdir, access, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash, createSign } from "node:crypto";

const ROOT = resolve(import.meta.dirname, "..");
const DIST = join(ROOT, "dist");
const TIERS_FILE = join(ROOT, "module-tiers.json");
const OUTPUT_DIR = join(DIST, ".extensions");

interface TierConfig {
  description: string;
  tier?: string;
  paths: string[];
  dependencies?: Record<string, string>;
}

interface ExtensionModule {
  path: string;
  hash: string;
}

interface ExtensionManifest {
  name: string;
  version: string;
  minCoreVersion: string;
  tier: string;
  modules: ExtensionModule[];
  dependencies?: Record<string, string>;
  signature?: string;
}

function sha256(data: Buffer): string {
  return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}

async function collectFiles(
  distDir: string,
  paths: string[]
): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();

  for (const srcPath of paths) {
    const distPath = srcPath.replace(/^src\//, "");

    if (distPath.endsWith("/")) {
      // Directory — collect all .js files
      const dir = join(distDir, distPath);
      try {
        const entries = await readdir(dir, { recursive: true });
        for (const entry of entries) {
          if (entry.endsWith(".js")) {
            const relativePath = join(distPath, entry).replace(/\\/g, "/");
            const content = await readFile(join(dir, entry));
            files.set(relativePath, content);
          }
        }
      } catch {
        // Directory doesn't exist — skip
      }
    } else if (distPath.endsWith(".ts")) {
      // Single .ts file → .js in dist
      const jsPath = distPath.replace(/\.ts$/, ".js");
      try {
        const content = await readFile(join(distDir, jsPath));
        files.set(jsPath, content);
      } catch {
        // File doesn't exist — skip
      }
    }
  }

  return files;
}

function signManifest(
  manifest: Omit<ExtensionManifest, "signature">,
  privateKeyPem: string
): string {
  const data = JSON.stringify(manifest, Object.keys(manifest).sort());
  const signer = createSign("Ed25519");
  signer.update(data);
  return signer.sign(privateKeyPem, "base64url");
}

async function main() {
  // Read package version
  const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf-8"));
  const version = pkg.version;

  // Read private key if provided
  const keyFlag = process.argv.indexOf("--key");
  let privateKey: string | null = null;
  if (keyFlag !== -1 && process.argv[keyFlag + 1]) {
    privateKey = await readFile(process.argv[keyFlag + 1], "utf-8");
  }

  // Read tier config
  const tiers = JSON.parse(await readFile(TIERS_FILE, "utf-8")) as Record<string, TierConfig | unknown>;

  await mkdir(OUTPUT_DIR, { recursive: true });

  const extensions = ["ext-byok", "ext-spawn", "ext-hosted"] as const;

  for (const extName of extensions) {
    const config = tiers[extName] as TierConfig | undefined;
    if (!config || !config.paths) {
      console.log(`  Skipping ${extName} — not found in module-tiers.json`);
      continue;
    }

    console.log(`  Packing ${extName}...`);
    const files = await collectFiles(DIST, config.paths);

    if (files.size === 0) {
      console.log(`    No files found — skipping`);
      continue;
    }

    // Build manifest
    const modules: ExtensionModule[] = [];
    const filesB64: Record<string, string> = {};

    for (const [path, content] of files) {
      modules.push({ path, hash: sha256(content) });
      filesB64[path] = content.toString("base64");
    }

    const manifest: ExtensionManifest = {
      name: extName,
      version,
      minCoreVersion: version,
      tier: config.tier ?? "byok",
      modules,
      dependencies: config.dependencies,
    };

    // Sign if private key available
    if (privateKey) {
      manifest.signature = signManifest(manifest, privateKey);
    }

    // Write bundle
    const bundle = { manifest, files: filesB64 };
    const outputPath = join(OUTPUT_DIR, `${extName}.json`);
    await writeFile(outputPath, JSON.stringify(bundle), "utf-8");

    const sizeMB = (Buffer.byteLength(JSON.stringify(bundle)) / 1024 / 1024).toFixed(1);
    console.log(`    ${files.size} modules, ${sizeMB} MB → ${extName}.json`);
  }

  console.log(`\n  Extension bundles written to ${OUTPUT_DIR}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
