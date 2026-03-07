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
  runcore register            Register for BYOK/Spawn tier
  runcore activate <token>    Activate with a signed token
  runcore tier                Show current tier and capabilities
  runcore --version           Print version

Environment:
  CORE_PORT          Server port (same as --port)
  CORE_HOME          Brain directory root (same as --dir)

Tiers:
  Local (default)    Brain + Ollama, zero network
  BYOK               Full server/UI, your API keys
  Spawn              Agent spawning + multi-agent
  Hosted             Managed by The Herrman Group

Examples:
  npx runcore                     # That's it. One command.
  npx runcore --port 4000
  npx runcore register
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

// ── Start (Level 1: Brain Only) ─────────────────────────────────────

async function startBrainOnly(root: string) {
  process.chdir(root);
  if (!process.env.LOG_LEVEL) process.env.LOG_LEVEL = "warn";

  console.log(`\n  Core v${VERSION} — Local tier (brain only)`);
  console.log(`  Memory, context, Ollama. No network surface.`);
  console.log(`  Run \`runcore register\` to unlock full features.\n`);

  // Start MCP server (stdio) for Claude Code integration
  try {
    await import("./mcp-server.js");
  } catch {
    // MCP server is optional — if it fails, brain still works
    console.log("  MCP server not available — running standalone.\n");
  }

  // Start heartbeat if we somehow have a token (shouldn't for local, but defensive)
  // Keep process alive
  const keepAlive = setInterval(() => {}, 60_000);
  keepAlive.unref();
}

// ── Start (Level 2+: Full Server) ───────────────────────────────────

async function startServer(tier: import("./tier/types.js").TierName = "byok") {
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
    process.stdout.write(`\r  ${frames[i++ % frames.length]} Starting Core (${tier})...`);
  }, 80);

  const { start, getStartupToken, getActualPort } = await import("./server.js");
  await start({ tier });

  clearInterval(spinner);
  process.stdout.write("\r" + " ".repeat(40) + "\r");

  // Resolve the actual port (handles port 0 → OS-assigned)
  const resolvedPort = getActualPort();

  // Start registry heartbeat for tier >= byok
  const { loadActivationToken } = await import("./tier/token.js");
  const activation = await loadActivationToken(root);
  if (activation) {
    const { startHeartbeat, onFreezeSignal, onTierDowngrade } = await import("./tier/heartbeat.js");
    const { freeze } = await import("./tier/freeze.js");

    onFreezeSignal((signal) => freeze(signal, root));
    onTierDowngrade((newTier) => {
      console.log(`\n  Tier changed to: ${newTier}. Restart required.\n`);
    });

    startHeartbeat(activation.raw, tier);
  }

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

    console.log(`\n  Core v${VERSION} — ${tier.toUpperCase()} tier on port ${resolvedPort}\n`);
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
  const { checkUpdate, acceptMajorUpdate } = await import("./updater.js");
  const info = await checkUpdate();
  if (!info) {
    console.log(`  Already up to date (v${VERSION})`);
    return;
  }
  console.log(`  Updating ${VERSION} → ${info.latest} (${info.updateType})...`);
  if (info.requiresApproval) {
    console.log(`  This is a major update with UI changes.`);
    await acceptMajorUpdate();
  } else {
    const { autoUpdate } = await import("./updater.js");
    await autoUpdate();
  }
}

// ── Registration ─────────────────────────────────────────────────────

async function register() {
  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> =>
    new Promise((res) => rl.question(q, (a) => res(a.trim())));

  console.log("\n  Register for Core — request an activation tier.\n");
  const name = await ask("  Name: ");
  const email = await ask("  Email: ");
  rl.close();

  if (!name || !email) {
    console.log("  Name and email are required.");
    return;
  }

  // Generate a stable instance ID from this machine
  const { createHash } = await import("node:crypto");
  const { hostname } = await import("node:os");
  const instanceId = createHash("sha256")
    .update(`${hostname()}:${process.cwd()}`)
    .digest("hex")
    .slice(0, 16);

  console.log(`\n  Submitting registration request...`);

  try {
    const res = await fetch("https://runcore.sh/api/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email, instanceId, requestedAt: new Date().toISOString() }),
      signal: AbortSignal.timeout(10_000),
    });

    if (res.ok) {
      console.log(`  Request submitted. You'll receive an activation token when approved.`);
      console.log(`  Run \`runcore activate <token>\` when you get it.\n`);
    } else {
      const text = await res.text();
      console.log(`  Registration failed: ${text}`);
    }
  } catch (err) {
    console.log(`  Could not reach runcore.sh — check your connection.`);
  }
}

async function activate() {
  const jwt = args[1];
  if (!jwt) {
    console.log("  Usage: runcore activate <token>");
    return;
  }

  const root = getFlag(args, "--dir") ?? process.env.CORE_HOME ?? process.cwd();
  const { saveActivationToken } = await import("./tier/token.js");

  try {
    const token = await saveActivationToken(root, jwt);
    console.log(`\n  Activated! Tier: ${token.tier}`);
    console.log(`  Org: ${token.org}`);
    console.log(`  Expires: ${token.expires}`);
    console.log(`\n  Restart runcore to apply.\n`);
  } catch (err) {
    console.log(`  Activation failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function showTier() {
  const root = getFlag(args, "--dir") ?? process.env.CORE_HOME ?? process.cwd();
  const { loadActivationToken } = await import("./tier/token.js");
  const { TIER_CAPS } = await import("./tier/types.js");

  const result = await loadActivationToken(root);
  const tier = result?.token.tier ?? "local";
  const caps = TIER_CAPS[tier];

  console.log(`\n  Current tier: ${tier}`);
  if (result) {
    console.log(`  Org: ${result.token.org}`);
    console.log(`  Expires: ${result.token.expires}`);
  }
  console.log(`\n  Capabilities:`);
  for (const [cap, enabled] of Object.entries(caps)) {
    console.log(`    ${enabled ? "+" : "-"} ${cap}`);
  }
  console.log();
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

  if (command === "register") {
    await register();
    return;
  }

  if (command === "activate") {
    await activate();
    return;
  }

  if (command === "tier") {
    await showTier();
    return;
  }

  // Load tier before deciding startup path
  const root = resolve(getFlag(args, "--dir") ?? process.env.CORE_HOME ?? process.cwd());
  await ensureBrain(root);

  const { currentTier } = await import("./tier/token.js");
  const tier = await currentTier(root);

  if (tier === "local") {
    // Level 1: brain-only — MCP server, Ollama, no HTTP server
    await startBrainOnly(root);
  } else {
    // Level 2+: full server with tier-appropriate capabilities
    await startServer(tier);
  }

  // Auto-update after startup
  import("./updater.js").then(({ autoUpdate }) => {
    autoUpdate().then(async (pending) => {
      if (pending) {
        const { setPendingUpdate } = await import("./nerve/state.js");
        setPendingUpdate({ current: pending.current, latest: pending.latest });
        console.log(`\n  Update available: v${pending.latest} (UI changes — approve in Dash)`);
      }
    });
  }).catch(() => {});
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
