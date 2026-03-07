/**
 * Auto-updater — silent updates for non-UI changes, human approval for UI changes.
 *
 * Rule: if the human can't see it, feel it, or interact with it differently, ship it.
 * Only gate on changes that affect the human's experience.
 *
 * Semver contract:
 *   patch (0.0.x) — silent. Bug fixes, security, scoring geometry.
 *   minor (0.x.0) — silent. New capabilities activate automatically.
 *   major (x.0.0) — ask. UI/nerve/contract changes. Human decides.
 */

import { exec, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createLogger } from "./utils/logger.js";

const log = createLogger("updater");
const PKG_NAME = "@runcore-sh/runcore";

interface VersionInfo {
  current: string;
  latest: string;
  updateType: "patch" | "minor" | "major" | "none";
  requiresApproval: boolean;
}

/** Parse semver into [major, minor, patch]. */
function parseSemver(v: string): [number, number, number] {
  const parts = v.replace(/^v/, "").split(".").map(Number);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

/** Determine update type between two versions. */
function compareVersions(current: string, latest: string): VersionInfo["updateType"] {
  const [cMaj, cMin, cPat] = parseSemver(current);
  const [lMaj, lMin, lPat] = parseSemver(latest);

  if (lMaj > cMaj) return "major";
  if (lMaj === cMaj && lMin > cMin) return "minor";
  if (lMaj === cMaj && lMin === cMin && lPat > cPat) return "patch";
  return "none";
}

/** Read current version from package.json. */
async function getCurrentVersion(): Promise<string> {
  try {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf-8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Fetch latest version from npm registry. */
async function fetchLatestVersion(): Promise<string | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${PKG_NAME}/latest`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { version: string };
    return data.version ?? null;
  } catch {
    return null;
  }
}

/** Check for updates and return version info. */
export async function checkUpdate(): Promise<VersionInfo | null> {
  const current = await getCurrentVersion();
  const latest = await fetchLatestVersion();
  if (!latest) return null;

  const updateType = compareVersions(current, latest);
  if (updateType === "none") return null;

  return {
    current,
    latest,
    updateType,
    requiresApproval: updateType === "major",
  };
}

/** Apply update — runs npm update, then restarts the process. */
function applyUpdate(latest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    log.info(`Applying update to v${latest}...`);

    // Detect if globally installed or local
    const isGlobal = process.argv[1]?.includes("node_modules/.bin") === false;
    const cmd = isGlobal
      ? `npm i -g ${PKG_NAME}@${latest}`
      : `npm update ${PKG_NAME}`;

    exec(cmd, { timeout: 120_000 }, (err) => {
      if (err) {
        log.warn(`Update failed: ${err.message}`);
        reject(err);
        return;
      }
      log.info(`Updated to v${latest}`);
      resolve();
    });
  });
}

/** Restart the current process with the same arguments. */
function restart(): void {
  const args = process.argv.slice(1);
  log.info("Restarting...");

  const child = spawn(process.execPath, args, {
    stdio: "inherit",
    detached: true,
  });

  child.unref();
  process.exit(0);
}

/**
 * Run the auto-update cycle. Called after server is running.
 *
 * - patch/minor: apply silently, restart
 * - major: return info for nerve state to surface to human
 */
export async function autoUpdate(): Promise<VersionInfo | null> {
  const info = await checkUpdate();
  if (!info) return null;

  if (info.requiresApproval) {
    // Major update — don't touch anything. Surface through nerve state.
    log.info(`Major update available: v${info.current} → v${info.latest} (requires approval)`);
    return info;
  }

  // Patch or minor — silent update
  log.info(`Auto-updating: v${info.current} → v${info.latest} (${info.updateType})`);
  try {
    await applyUpdate(info.latest);
    restart();
  } catch {
    // Update failed — not critical, try again next boot
    log.warn("Auto-update failed, will retry next startup");
  }

  return null;
}

/**
 * Accept a pending major update. Called when human approves via UI.
 */
export async function acceptMajorUpdate(): Promise<void> {
  const info = await checkUpdate();
  if (!info || info.updateType !== "major") {
    log.info("No major update pending");
    return;
  }

  await applyUpdate(info.latest);
  restart();
}
