/**
 * Instance identity — configurable name for this Core instance.
 * Read from brain/settings.json at startup. Defaults to "Core".
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

let instanceName = "Core";

/**
 * Initialize instance name from brain/settings.json.
 * Uses readFileSync to avoid circular dependencies with settings.ts.
 * Call once at startup before anything else.
 */
export function initInstanceName(): void {
  try {
    const raw = readFileSync(join(process.cwd(), "brain", "settings.json"), "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed.instanceName === "string" && parsed.instanceName.trim()) {
      instanceName = parsed.instanceName.trim();
    }
  } catch {
    // Missing or malformed — keep default "Core"
  }
}

/** Returns the instance name (e.g. "Core", "Dash", "TestBot"). */
export function getInstanceName(): string {
  return instanceName;
}

/** Returns the instance name in lowercase (e.g. "core", "dash"). */
export function getInstanceNameLower(): string {
  return instanceName.toLowerCase();
}

/**
 * Resolve an environment variable with instance-aware prefix.
 * Checks CORE_ first, then falls back to DASH_ for backwards compatibility.
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
