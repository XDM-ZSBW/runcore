#!/usr/bin/env node --max-old-space-size=4096
/**
 * Core CLI — boot a local-first AI agent from any directory.
 *
 * Usage:
 *   core                           Init (if needed) + start
 *   core [--port <n>] [--dir <d>]  Start with options
 *   core status                    Check if running
 *   core --help                    Show help
 */

import { mkdir, writeFile, access, readFile, cp, readdir, stat } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { exec } from "node:child_process";
import { createServer } from "node:net";

const PKG_NAME = "@runcore-sh/runcore";
let VERSION = "0.1.0";

// Read version from package.json at runtime so it stays in sync
try {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf-8"));
  VERSION = pkg.version ?? VERSION;
} catch {}

// ── .env loader (brain directory, no deps) ────────────────────────

/**
 * Load a .env file from the given directory into process.env.
 * Existing env vars are NOT overwritten (explicit env takes precedence).
 * Supports KEY=VALUE, KEY="VALUE", KEY='VALUE', blank lines, and # comments.
 */
async function loadDotEnv(dir: string): Promise<number> {
  try {
    const envPath = join(dir, ".env");
    const text = await readFile(envPath, "utf-8");
    let count = 0;
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      // Strip surrounding quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      // Don't overwrite existing env vars
      if (process.env[key] === undefined) {
        process.env[key] = val;
        count++;
      }
    }
    return count;
  } catch {
    // No .env file — that's fine, all vars are optional
    return 0;
  }
}

const HELP = `
runcore v${VERSION} — local-first AI agent runtime
https://runcore.sh

Usage:
  runcore                     Start your agent (auto-inits if needed)
  runcore init                Scaffold a fresh brain from template
  runcore --port <n>          Start on a specific port (default: random available)
  runcore --dir <path>        Use a specific directory
  runcore status              Check if running
  runcore update              Update to latest version
  runcore import <folder...>  Import files into your brain
  runcore import --dry-run    Preview what would be imported
  runcore register            Register for BYOK/Spawn tier
  runcore activate <token>    Activate with a signed token
  runcore sync                Download extensions for your tier
  runcore sync --force        Re-download even if cached
  runcore sync --check        Check for updates without downloading
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

    // Existing brain found — check if this is an upgrade (new package version)
    let existingVersion = "";
    try {
      const sRaw = await readFile(join(brainDir, "settings.json"), "utf-8");
      const s = JSON.parse(sRaw);
      existingVersion = s._coreVersion ?? "";
    } catch {}

    if (existingVersion && existingVersion !== VERSION) {
      console.log(`\n  Existing brain found (v${existingVersion}).`);
      console.log(`  Upgrading to v${VERSION}.\n`);
    } else if (!existingVersion) {
      // First run with versioning — stamp current version
      try {
        const sPath = join(brainDir, "settings.json");
        const sRaw = await readFile(sPath, "utf-8");
        const s = JSON.parse(sRaw);
        s._coreVersion = VERSION;
        await writeFile(sPath, JSON.stringify(s, null, 2), "utf-8");
      } catch {}
    }

    return false; // already exists
  } catch {
    // needs init
  }

  console.log("First run — setting up brain...");

  // Copy brain-template shipped with the package
  const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const templateDir = join(pkgRoot, "brain-template");

  try {
    await access(templateDir);
    await cp(templateDir, brainDir, { recursive: true });
  } catch {
    // Fallback: create minimal v2 structure if template not found (dev mode)
    const dirs = [
      // v2 structure
      "brain/log", "brain/files", "brain/.config",
      // Subdirs under log/ for organization (still flat conceptually)
      "brain/log/memory", "brain/log/ops", "brain/log/metrics",
      // Legacy compat — created so existing code paths don't break
      "brain/agents", "brain/sessions", "brain/vault",
    ];
    for (const dir of dirs) {
      await mkdir(join(root, dir), { recursive: true });
    }
  }

  // Ensure runtime directories exist (not in template — created at boot)
  const runtimeDirs = [
    "brain/agents/logs", "brain/agents/tasks", "brain/agents/runtime",
    "brain/sessions", "brain/vault",
  ];
  for (const dir of runtimeDirs) {
    await mkdir(join(root, dir), { recursive: true });
  }

  // Ensure settings.json exists with defaults
  const settingsPath = join(brainDir, "settings.json");
  try {
    await access(settingsPath);
  } catch {
    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          _coreVersion: VERSION,
          airplaneMode: true,
          models: { chat: "auto", agent: "auto" },
          encryptBrainFiles: false,
          safeWordMode: "restart",
          instanceName: "Core",
          integrations: { enabled: false, services: {} },
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
  const envCount = await loadDotEnv(root);
  if (envCount > 0) console.log(`  Loaded .env from ${root} (${envCount} vars)`);
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
  const explicitPort = getFlag(args, "--port") ?? process.env.CORE_PORT;
  const dirArg = getFlag(args, "--dir") ?? process.env.CORE_HOME;

  // If user specified a port, try it with fallback. Otherwise let the OS assign (port 0).
  let port: number;
  if (explicitPort) {
    const preferred = parseInt(explicitPort, 10);
    port = await findPort(preferred);
    if (port !== preferred) {
      console.log(`  Port ${preferred} in use, using ${port}`);
    }
  } else {
    port = 0; // OS assigns a guaranteed-available port
  }

  process.env.CORE_PORT = String(port);
  if (dirArg) {
    process.chdir(resolve(dirArg));
  }

  const root = process.cwd();

  // Auto-init if no brain exists
  await ensureBrain(root);

  // Load .env from brain directory (user keys live here, not in the runtime package)
  const envCount = await loadDotEnv(root);
  if (envCount > 0) console.log(`  Loaded .env from ${root} (${envCount} vars)`);

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

  // Auto-open browser for zero-friction onboarding
  const token = getStartupToken();
  const url = token
    ? `http://localhost:${resolvedPort}?token=${token}`
    : `http://localhost:${resolvedPort}`;

  const openCmd =
    process.platform === "win32" ? `start "" "${url}"`
    : process.platform === "darwin" ? `open "${url}"`
    : `xdg-open "${url}"`;
  exec(openCmd, () => {});

  console.log(`\n  Core v${VERSION} — ${tier.toUpperCase()} tier on port ${resolvedPort}\n`);
}

// ── Status ─────────────────────────────────────────────────────────

async function status() {
  const portFlag = getFlag(args, "--port") ?? process.env.CORE_PORT;

  let port: number;
  if (portFlag) {
    port = parseInt(portFlag, 10);
  } else {
    // Discover from runtime lock
    const { discoverRunning } = await import("./runtime-lock.js");
    const lock = discoverRunning();
    if (!lock) {
      console.log("Core is not running (no runtime lock found)");
      process.exit(1);
      return;
    }
    port = lock.port;
  }

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

async function importFolders() {
  const root = resolve(getFlag(args, "--dir") ?? process.env.CORE_HOME ?? process.cwd());
  const dryRun = hasFlag(args, "--dry-run", "--preview");

  // Collect folder paths (everything after "import" that isn't a flag)
  const folders = args.slice(1).filter(a => !a.startsWith("--"));
  if (folders.length === 0) {
    console.log(`
  Usage: runcore import <folder> [folder2] [folder3...]

  Scans folders and copies files into your brain structure.
  Source files are never moved or modified.

  Options:
    --dry-run    Preview what would be imported
    --dir <path> Use a specific brain directory

  Examples:
    runcore import ~/Documents
    runcore import ~/Obsidian ~/Projects --dry-run
    runcore import "C:\\Users\\Dad\\Documents"
`);
    return;
  }

  // Resolve paths
  const { resolve: resolvePath } = await import("node:path");
  const sources = folders.map(f => resolvePath(f));

  console.log(`\n  ${dryRun ? "Preview:" : "Importing from"} ${sources.length} folder${sources.length > 1 ? "s" : ""}...`);
  for (const s of sources) console.log(`    ${s}`);
  console.log();

  const { importToBrain } = await import("./files/import.js");
  const result = await importToBrain({
    sources,
    brainRoot: root,
    dryRun,
  });

  if (result.imported === 0 && result.skipped === 0) {
    console.log("  No importable files found.\n");
    return;
  }

  // Summary by category
  console.log(`  ${dryRun ? "Would import" : "Imported"}: ${result.imported} files`);
  if (result.skipped > 0) console.log(`  Skipped (limit): ${result.skipped}`);
  console.log();
  for (const [cat, count] of Object.entries(result.categories)) {
    const dest = {
      note: "brain/knowledge/notes/",
      daily: "brain/memory/imported/",
      research: "brain/knowledge/research/",
      asset: "brain/knowledge/assets/",
      template: "brain/content/templates/",
      bookmark: "brain/knowledge/bookmarks/",
    }[cat] || "brain/";
    console.log(`    ${count} ${cat}${count !== 1 ? "s" : ""} → ${dest}`);
  }

  if (dryRun) {
    console.log(`\n  Run without --dry-run to import.\n`);
  } else {
    console.log(`\n  Manifest saved to brain/.core/import-manifest.json`);
    console.log(`  Source files were not modified.\n`);
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

    // Bond handshake — establish ongoing trust
    console.log(`\n  Bonding...`);
    const { bond } = await import("./tier/bond.js");
    const result = await bond(root, jwt, token.jti);
    if (result.bonded) {
      console.log(`  Bonded (fingerprint: ${result.fingerprint})`);
    } else {
      console.log(`  Bond pending — will complete on next heartbeat.`);
    }

    // Auto-sync extensions for activated tier
    console.log(`\n  Syncing extensions...`);
    await syncExtensions(resolve(root), false, false);

    console.log(`\n  Restart runcore to apply.\n`);
  } catch (err) {
    console.log(`  Activation failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function syncExtensions(root: string, force: boolean, checkOnly: boolean) {
  const { loadActivationToken } = await import("./tier/token.js");
  const { meetsMinimum } = await import("./tier/gate.js");
  const { setCoreVersion, ensureExtension, listCached, cacheRoot } = await import("./extensions/index.js");
  const { checkForUpdate } = await import("./extensions/client.js");
  const { EXTENSION_TIERS } = await import("./extensions/manifest.js");

  setCoreVersion(VERSION);

  const activation = await loadActivationToken(root);
  const tier = activation?.token.tier ?? "local";

  if (tier === "local") {
    console.log("  Local tier — no extensions to sync.");
    console.log("  Run `runcore register` to unlock integrations + agents.\n");
    return;
  }

  // Determine which extensions this tier can access
  const eligible = Object.entries(EXTENSION_TIERS)
    .filter(([_, requiredTier]) => meetsMinimum(tier, requiredTier))
    .map(([name]) => name as keyof typeof EXTENSION_TIERS);

  if (checkOnly) {
    console.log(`  Tier: ${tier} — checking ${eligible.length} extension(s)...\n`);
    for (const name of eligible) {
      if (!activation) continue;
      const update = await checkForUpdate(name, VERSION, activation.raw);
      if (update.available) {
        console.log(`  ${name}: update available (${update.latestVersion})`);
      } else {
        console.log(`  ${name}: up to date`);
      }
    }
    return;
  }

  console.log(`  Tier: ${tier} — syncing ${eligible.length} extension(s)...\n`);

  for (const name of eligible) {
    try {
      const result = await ensureExtension(name, root, { force });
      if (result.cached) {
        console.log(`  ${name}: ${result.modules} modules ${force ? "re-downloaded" : "ready"}`);
      } else {
        console.log(`  ${name}: skipped (tier insufficient)`);
      }
    } catch (err) {
      console.log(`  ${name}: failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Show cache info
  const cached = await listCached();
  if (cached.length > 0) {
    const totalBytes = cached.reduce((sum, c) => sum + c.sizeBytes, 0);
    const totalMB = (totalBytes / 1024 / 1024).toFixed(1);
    console.log(`\n  Cache: ${cacheRoot()}`);
    console.log(`  Total: ${totalMB} MB across ${cached.length} extension(s)`);
  }
}

async function sync() {
  const root = resolve(getFlag(args, "--dir") ?? process.env.CORE_HOME ?? process.cwd());
  const force = hasFlag(args, "--force");
  const checkOnly = hasFlag(args, "--check");

  console.log();
  await syncExtensions(root, force, checkOnly);
  console.log();
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

  // Extension cache status
  try {
    const { listCached, cacheRoot } = await import("./extensions/index.js");
    const cached = await listCached();
    if (cached.length > 0) {
      console.log(`\n  Extensions (${cacheRoot()}):`);
      for (const ext of cached) {
        const sizeMB = (ext.sizeBytes / 1024 / 1024).toFixed(1);
        console.log(`    ${ext.name}@${ext.version} (${sizeMB} MB)`);
      }
    } else if (tier !== "local") {
      console.log(`\n  No extensions cached. Run \`runcore sync\` to download.`);
    }
  } catch {
    // Extensions module not available — skip
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

  if (command === "init") {
    const root = resolve(getFlag(args, "--dir") ?? process.env.CORE_HOME ?? process.cwd());
    const created = await ensureBrain(root);
    if (!created) {
      console.log(`  Brain already exists at ${join(root, "brain")}`);
    }
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

  if (command === "import") {
    await importFolders();
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

  if (command === "sync") {
    await sync();
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

  // All tiers start the full server — local tier just has fewer capabilities
  await startServer(tier);

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
