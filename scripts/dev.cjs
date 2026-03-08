#!/usr/bin/env node
// Cross-platform dev launcher with increased heap
const { execSync } = require("child_process");
const args = process.argv.slice(2);
const fresh = args.includes("--fresh");

if (fresh) {
  const fs = require("fs");
  for (const p of ["brain/identity", "brain/settings.json"]) {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
  }
  console.log("  Brain reset — fresh start");
}

execSync("npx tsx watch src/cli.ts", {
  stdio: "inherit",
  env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=4096" },
});
