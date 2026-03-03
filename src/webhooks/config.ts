/**
 * Webhook configuration management.
 *
 * Loads, validates, and resolves webhook provider configurations.
 * Secrets can reference environment variables or be provided as literals.
 * Configuration can be loaded from a file or constructed programmatically.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { logActivity } from "../activity/log.js";
import { createLogger } from "../utils/logger.js";
import { getProvider, listProviders } from "./registry.js";

const log = createLogger("webhooks.config");
import type {
  WebhookProviderConfig,
  WebhookSystemConfig,
  WebhookRetryOpts,
} from "./types.js";

// ── In-memory config store ───────────────────────────────────────────────────

let systemConfig: WebhookSystemConfig = { providers: {} };

/** Get the current webhook system configuration. */
export function getConfig(): WebhookSystemConfig {
  return systemConfig;
}

/** Replace the entire system configuration. */
export function setConfig(config: WebhookSystemConfig): void {
  systemConfig = config;
}

// ── Provider config CRUD ─────────────────────────────────────────────────────

/** Get configuration for a specific provider. */
export function getProviderConfig(
  name: string,
): WebhookProviderConfig | undefined {
  return systemConfig.providers[name];
}

/** Set configuration for a specific provider. Merges with existing config. */
export function setProviderConfig(config: WebhookProviderConfig): void {
  const existing = systemConfig.providers[config.name];
  systemConfig.providers[config.name] = existing
    ? { ...existing, ...config }
    : config;
}

/**
 * Set multiple provider configs in one call.
 * Avoids repeated object spread overhead when configuring all providers at startup.
 */
export function setProviderConfigs(configs: WebhookProviderConfig[]): void {
  const start = performance.now();
  for (const config of configs) {
    setProviderConfig(config);
  }
  const ms = performance.now() - start;
  // Use debug log instead of logActivity to avoid polluting the insight engine
  // with routine startup perf data (was causing feedback loop — DASH-70)
  if (ms > 5) {
    log.debug(`setProviderConfigs took ${ms.toFixed(1)}ms for ${configs.length} providers`);
  }
}

/** Remove configuration for a provider. */
export function removeProviderConfig(name: string): boolean {
  if (!(name in systemConfig.providers)) return false;
  delete systemConfig.providers[name];
  return true;
}

/** List all configured provider names. */
export function listConfiguredProviders(): string[] {
  return Object.keys(systemConfig.providers);
}

// ── Secret resolution ────────────────────────────────────────────────────────

/**
 * Resolve a secret value. If the value looks like an environment variable
 * name (all uppercase, underscores, digits), read from process.env.
 * Otherwise, treat it as a literal secret.
 */
export function resolveSecret(secretRef: string): string | undefined {
  // Env var pattern: all uppercase letters, digits, underscores
  if (/^[A-Z][A-Z0-9_]*$/.test(secretRef)) {
    return process.env[secretRef];
  }
  return secretRef;
}

/**
 * Get the resolved secret for a provider.
 * Returns undefined if no secret is configured or the env var is not set.
 */
export function getProviderSecret(name: string): string | undefined {
  const config = systemConfig.providers[name];
  if (!config?.secret) return undefined;
  return resolveSecret(config.secret);
}

// ── Retry config resolution ──────────────────────────────────────────────────

/**
 * Get the effective retry options for a provider.
 * Provider-specific config overrides system defaults.
 */
export function getProviderRetryOpts(name: string): WebhookRetryOpts {
  const defaults = systemConfig.defaults?.retry ?? {};
  const providerOpts = systemConfig.providers[name]?.retry ?? {};
  return { ...defaults, ...providerOpts };
}

// ── Provider status ──────────────────────────────────────────────────────────

/** Check if a provider is enabled in the configuration. */
export function isProviderEnabled(name: string): boolean {
  const config = systemConfig.providers[name];
  if (!config) return true; // Unconfigured providers default to enabled
  return config.enabled !== false;
}

/**
 * Validate the configuration for a specific provider.
 * Returns a list of issues found.
 */
export function validateProviderConfig(name: string): string[] {
  const issues: string[] = [];
  const config = systemConfig.providers[name];

  if (!config) {
    issues.push(`No configuration found for provider "${name}"`);
    return issues;
  }

  if (config.secret) {
    const resolved = resolveSecret(config.secret);
    if (!resolved) {
      issues.push(
        `Secret for "${name}" references env var "${config.secret}" which is not set`,
      );
    }
  }

  if (!getProvider(name)) {
    issues.push(
      `Provider "${name}" is configured but not registered in the registry`,
    );
  }

  return issues;
}

/**
 * Validate the entire system configuration.
 * Returns a map of provider name → issues.
 */
export function validateConfig(): Record<string, string[]> {
  const result: Record<string, string[]> = {};

  for (const name of Object.keys(systemConfig.providers)) {
    const issues = validateProviderConfig(name);
    if (issues.length > 0) {
      result[name] = issues;
    }
  }

  // Check for registered providers missing configuration
  for (const name of listProviders()) {
    if (!systemConfig.providers[name]) {
      result[name] = [
        `Provider "${name}" is registered but has no configuration`,
      ];
    }
  }

  return result;
}

// ── File-based config loading ────────────────────────────────────────────────

/**
 * Load webhook configuration from a JSON file.
 * Returns true if the file was loaded successfully.
 */
export function loadConfigFromFile(filePath: string): boolean {
  const start = performance.now();
  try {
    const resolved = path.resolve(filePath);

    const readStart = performance.now();
    const content = fs.readFileSync(resolved, "utf-8");
    const readMs = performance.now() - readStart;

    const parseStart = performance.now();
    const parsed = JSON.parse(content) as WebhookSystemConfig;
    const parseMs = performance.now() - parseStart;

    if (!parsed.providers || typeof parsed.providers !== "object") {
      logActivity({
        source: "system",
        summary: `Webhook config file missing "providers" object: ${filePath}`,
      });
      return false;
    }

    systemConfig = parsed;
    const totalMs = performance.now() - start;
    logActivity({
      source: "system",
      summary: `Loaded webhook config from ${filePath} (${Object.keys(parsed.providers).length} providers, read:${readMs.toFixed(1)}ms, parse:${parseMs.toFixed(1)}ms, total:${totalMs.toFixed(1)}ms)`,
    });
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logActivity({
      source: "system",
      summary: `Failed to load webhook config from ${filePath}: ${msg}`,
    });
    return false;
  }
}

/**
 * Save the current webhook configuration to a JSON file.
 * Secrets that reference env vars are saved as-is (the reference, not the resolved value).
 */
export function saveConfigToFile(filePath: string): boolean {
  try {
    const resolved = path.resolve(filePath);
    const dir = path.dirname(resolved);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(resolved, JSON.stringify(systemConfig, null, 2), "utf-8");
    logActivity({
      source: "system",
      summary: `Saved webhook config to ${filePath}`,
    });
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logActivity({
      source: "system",
      summary: `Failed to save webhook config to ${filePath}: ${msg}`,
    });
    return false;
  }
}
