#!/usr/bin/env node
/**
 * Core CLI — boot a local-first AI agent from any directory.
 *
 * Usage:
 *   core                           Init (if needed) + start
 *   core [--port <n>] [--dir <d>]  Start with options
 *   core status                    Check if running
 *   core --help                    Show help
 */

import { mkdir, writeFile, access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { exec } from "node:child_process";
import { createServer } from "node:net";

const PKG_NAME = "@runcore-sh/runcore";
let VERSION = "0.1.0";

// Read version from package.json at runtime so it stays in sync
try {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf-8"));
  VERSION = pkg.version ?? VERSION;
} catch {}

const HELP = `
runcore v${VERSION} — local-first AI agent runtime
https://runcore.sh

Usage:
  runcore                     Start your agent (auto-inits if needed)
  runcore --port <n>          Start on a specific port (default: random available)
  runcore --dir <path>        Use a specific directory
  runcore status              Check if running
  runcore update              Update to latest version
  runcore --version           Print version

Environment:
  CORE_PORT          Server port (same as --port)
  CORE_HOME          Brain directory root (same as --dir)

Examples:
  npx runcore                     # That's it. One command.
  npx runcore --port 4000
  npx runcore --dir ~/my-agent
`.trim();

// ── Arg parsing (no deps) ──────────────────────────────────────────

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

function hasFlag(args: string[], ...flags: string[]): boolean {
  return flags.some((f) => args.includes(f));
}

const args = process.argv.slice(2);
const command = args[0];

// ── Init (idempotent — safe to run every time) ─────────────────────

async function ensureBrain(root: string): Promise<boolean> {
  const brainDir = join(root, "brain");

  // Check if brain already exists
  try {
    await access(brainDir);
    return false; // already exists
  } catch {
    // needs init
  }

  console.log("First run — setting up brain...");

  const dirs = [
    "brain/memory",
    "brain/identity",
    "brain/knowledge/notes",
    "brain/knowledge/research",
    "brain/knowledge/protocols",
    "brain/content/templates",
    "brain/content/drafts",
    "brain/operations",
    "brain/agents/logs",
    "brain/agents/tasks",
    "brain/agents/runtime",
    "brain/calendar",
    "brain/contacts",
    "brain/files/storage",
    "brain/metrics",
    "brain/ops",
    "brain/sessions",
    "brain/training",
    "brain/skills",
    "brain/library",
    "brain/scheduling",
    "brain/vault",
  ];

  for (const dir of dirs) {
    await mkdir(join(root, dir), { recursive: true });
  }

  const seeds: Record<string, string> = {
    "brain/memory/README.md":
      "# Memory\n\nAppend-only JSONL files: experiences, decisions, failures, semantic, procedural.\nNever delete or rewrite — use `\"status\": \"archived\"` to deprecate.\n",
    "brain/knowledge/README.md":
      "# Knowledge\n\nResearch, notes, protocols, bookmarks.\n",
    "brain/operations/OPERATIONS.md":
      "# Operations\n\nGoals, todos, changelog, backlog, insights.\n",
    "brain/content/CONTENT.md":
      "# Content\n\nDrafts and templates for content creation.\n",
    "brain/identity/personality.md":
      "Be concise. Be helpful. Read the room.\n",
  };

  for (const [rel, content] of Object.entries(seeds)) {
    const fullPath = join(root, rel);
    try {
      await access(fullPath);
    } catch {
      await writeFile(fullPath, content, "utf-8");
    }
  }

  const settingsPath = join(brainDir, "settings.json");
  try {
    await access(settingsPath);
  } catch {
    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          airplaneMode: true,
          models: { chat: "auto", agent: "auto" },
          encryptBrainFiles: false,
          safeWordMode: "restart",
        },
        null,
        2
      ),
      "utf-8"
    );
  }

  console.log("Brain ready.\n");
  return true;
}

// ── Port detection ────────────────────────────────────────────────

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => { srv.close(); resolve(true); });
    srv.listen(port);
  });
}

async function findPort(preferred: number): Promise<number> {
  if (await isPortAvailable(preferred)) return preferred;
  // Try a few nearby ports, then random
  for (let p = preferred + 1; p <= preferred + 10; p++) {
    if (await isPortAvailable(p)) return p;
  }
  // OS-assigned random port
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "0.0.0.0", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
    srv.once("error", reject);
  });
}

// ── Start ──────────────────────────────────────────────────────────

async function startServer() {
  const preferredPort = parseInt(getFlag(args, "--port") ?? process.env.CORE_PORT ?? "0", 10);
  const dirArg = getFlag(args, "--dir") ?? process.env.CORE_HOME;

  // Port 0 = let the OS assign; skip findPort probing
  const port = preferredPort === 0 ? 0 : await findPort(preferredPort);
  if (preferredPort !== 0 && port !== preferredPort) {
    console.log(`  Port ${preferredPort} in use, using ${port}`);
  }

  process.env.CORE_PORT = String(port);
  if (dirArg) {
    process.chdir(resolve(dirArg));
  }

  const root = process.cwd();

  // Auto-init if no brain exists
  await ensureBrain(root);

  // Suppress JSON log noise during startup — only show warnings/errors
  if (!process.env.LOG_LEVEL) process.env.LOG_LEVEL = "warn";

  // Spinner while server boots
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const spinner = setInterval(() => {
    process.stdout.write(`\r  ${frames[i++ % frames.length]} Starting Core...`);
  }, 80);

  const { start, getStartupToken, getActualPort } = await import("./server.js");
  await start();

  clearInterval(spinner);
  process.stdout.write("\r" + " ".repeat(40) + "\r");

  // Resolve the actual port (handles port 0 → OS-assigned)
  const resolvedPort = getActualPort();

  // Auto-open browser with startup token for zero-friction onboarding
  const token = getStartupToken();
  if (token) {
    const url = `http://localhost:${resolvedPort}?token=${token}`;

    // Open browser FIRST, then print — so browser gets focus
    const openCmd =
      process.platform === "win32" ? `start "" "${url}"`
      : process.platform === "darwin" ? `open "${url}"`
      : `xdg-open "${url}"`;
    exec(openCmd, () => {});

    console.log(`\n  Core is ready on port ${resolvedPort}\n`);
  }
}

// ── Status ─────────────────────────────────────────────────────────

async function status() {
  const port = getFlag(args, "--port") ?? process.env.CORE_PORT ?? "3577";
  const url = `http://localhost:${port}/api/health`;

  try {
    const res = await fetch(url);
    if (res.ok) {
      const data = (await res.json()) as Record<string, unknown>;
      console.log(`Core is running on port ${port}`);
      console.log(`  Status: ${(data.status as string) ?? "ok"}`);
      if (data.uptime) console.log(`  Uptime: ${Math.floor(data.uptime as number)}s`);
    } else {
      console.log(`Core responded with ${res.status} on port ${port}`);
    }
  } catch {
    console.log(`Core is not running on port ${port}`);
    process.exit(1);
  }
}

// ── Update check ──────────────────────────────────────────────────

async function checkForUpdate(): Promise<string | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${PKG_NAME}/latest`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { version: string };
    if (data.version && data.version !== VERSION) return data.version;
  } catch {}
  return null;
}

async function selfUpdate() {
  const latest = await checkForUpdate();
  if (!latest) {
    console.log(`  Already up to date (v${VERSION})`);
    return;
  }
  console.log(`  Updating ${VERSION} → ${latest}...`);
  const child = exec(`npm i -g ${PKG_NAME}@${latest}`, (err, stdout, stderr) => {
    if (err) {
      console.error(`  Update failed: ${err.message}`);
      process.exit(1);
    }
    console.log(`  ✓ Updated to v${latest}. Run 'runcore' to start.`);
  });
  child.stdout?.pipe(process.stdout);
  child.stderr?.pipe(process.stderr);
}

// ── Dispatch ────────────────────────────────────────────────────────

async function main() {
  if (hasFlag(args, "--version", "-v")) {
    console.log(VERSION);
    return;
  }

  if (hasFlag(args, "--help", "-h")) {
    console.log(HELP);
    return;
  }

  if (command === "status") {
    await status();
    return;
  }

  if (command === "update") {
    await selfUpdate();
    return;
  }

  // Everything else: just start (with auto-init)
  await startServer();

  // Non-blocking update check after server is running
  checkForUpdate().then((latest) => {
    if (latest) {
      console.log(`  Update available: v${latest} (current: v${VERSION})`);
      console.log(`  Run 'runcore update' to upgrade.\n`);
    }
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
