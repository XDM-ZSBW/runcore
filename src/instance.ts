/**
 * Instance identity — configurable name for this Core instance.
 * Read from brain/settings.json at startup. Defaults to "Core".
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BRAIN_DIR } from "./lib/paths.js";

let instanceName = "Core";

/**
 * Initialize instance name from brain/settings.json.
 * Uses readFileSync to avoid circular dependencies with settings.ts.
 * Call once at startup before anything else.
 */
export function initInstanceName(): void {
  try {
    const raw = readFileSync(join(BRAIN_DIR, "settings.json"), "utf-8");
    const parsed = JSON.parse(raw);
    const name = parsed.agentName ?? parsed.instanceName;
    if (typeof name === "string" && name.trim()) {
      instanceName = name.trim();
    }
  } catch {
    // Missing or malformed — keep default "Core"
  }
}

/** Returns the instance name (e.g. "Core", "Dash", "TestBot"). */
export function getInstanceName(): string {
  return instanceName;
}

/** Update the instance name at runtime (e.g. after pairing). */
export function setInstanceName(name: string): void {
  if (name.trim()) instanceName = name.trim();
}

/** Returns the instance name in lowercase (e.g. "core", "dash"). */
export function getInstanceNameLower(): string {
  return instanceName.toLowerCase();
}

/**
 * Resolve an environment variable with instance-aware prefix.
 * Checks CORE_ first, then falls back to DASH_ for backwards compatibility.
 * The DASH_ fallback ensures existing deployments using DASH_* env vars
 * continue to work without reconfiguration.
 */
export function resolveEnv(suffix: string): string | undefined {
  return process.env[`CORE_${suffix}`] ?? process.env[`DASH_${suffix}`];
}

/** Returns the configured alert email sender address. */
export function getAlertEmailFrom(): string {
  return resolveEnv("ALERT_EMAIL_FROM") ?? `${getInstanceNameLower()}@localhost`;
}

/** Returns the configured alert email recipient address. */
export function getAlertEmailTo(): string | undefined {
  return resolveEnv("ALERT_EMAIL_TO");
}
