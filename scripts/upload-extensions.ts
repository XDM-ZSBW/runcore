/**
 * upload-extensions.ts — Upload packed extension bundles to runcore.sh.
 *
 * Reads from dist/.extensions/ and POSTs each to the upload endpoint.
 *
 * Usage: tsx scripts/upload-extensions.ts --token <admin-token> [--url <base-url>]
 */

import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const EXTENSIONS_DIR = join(ROOT, "dist", ".extensions");
const DEFAULT_URL = "https://runcore.sh/api/extensions/upload";

async function main() {
  const args = process.argv.slice(2);
  const tokenIdx = args.indexOf("--token");
  const urlIdx = args.indexOf("--url");

  const token = tokenIdx !== -1 ? args[tokenIdx + 1] : process.env.RUNCORE_ADMIN_TOKEN;
  const url = urlIdx !== -1 ? args[urlIdx + 1] : DEFAULT_URL;

  if (!token) {
    console.error("Usage: tsx scripts/upload-extensions.ts --token <admin-token>");
    process.exit(1);
  }

  let files: string[];
  try {
    files = (await readdir(EXTENSIONS_DIR)).filter((f) => f.endsWith(".json"));
  } catch {
    console.error(`No extensions found at ${EXTENSIONS_DIR}`);
    console.error("Run: npm run pack:extensions");
    process.exit(1);
  }

  if (files.length === 0) {
    console.error("No .json bundles found in dist/.extensions/");
    process.exit(1);
  }

  console.log(`Uploading ${files.length} extensions to ${url}\n`);

  for (const file of files) {
    const content = await readFile(join(EXTENSIONS_DIR, file), "utf-8");
    const bundle = JSON.parse(content);
    const name = bundle.manifest?.name || file;
    const version = bundle.manifest?.version || "?";

    process.stdout.write(`  ${name}@${version}...`);

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: content,
    });

    if (!res.ok) {
      const err = await res.text().catch(() => "");
      console.log(` FAILED (${res.status}): ${err}`);
      continue;
    }

    const result = (await res.json()) as { modules: number; sizeKB: number };
    console.log(` OK (${result.modules} modules, ${result.sizeKB} KB)`);
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
