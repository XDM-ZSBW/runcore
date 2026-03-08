/**
 * Configuration loader — merges CLI args, env vars, config files, and defaults.
 *
 * Precedence (highest → lowest):
 *   1. CLI arguments
 *   2. Environment variables
 *   3. Config file (JSON)
 *   4. Schema defaults
 */

import { readFileSync } from "node:fs";
import { resolve, extname } from "node:path";
import { ProjectConfigSchema, type ProjectConfig } from "./schema.js";

export interface LoadConfigOptions {
  argv?: string[];
  env?: Record<string, string | undefined>;
  skipFile?: boolean;
}

export class ConfigError extends Error {
  constructor(message: string, public readonly details?: unknown) {
    super(message);
    this.name = "ConfigError";
  }
}

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function hasFlag(args: string[], ...flags: string[]): boolean {
  return flags.some((f) => args.includes(f));
}

function parseCliArgs(argv: string[]): Record<string, unknown> {
  const cli: Record<string, unknown> = {};

  const brainDir = getFlag(argv, "--brain") ?? getFlag(argv, "--dir");
  if (brainDir) cli.brainDir = brainDir;

  const dataDir = getFlag(argv, "--data");
  if (dataDir) cli.dataDir = dataDir;

  const port = getFlag(argv, "--port");
  if (port) {
    const n = parseInt(port, 10);
    if (Number.isNaN(n)) throw new ConfigError(`Invalid --port value: ${port}`);
    cli.api = { port: n };
  }

  if (hasFlag(argv, "--encrypt")) cli.encrypt = true;
  if (hasFlag(argv, "--no-encrypt")) cli.encrypt = false;

  const logLevel = getFlag(argv, "--log-level");
  if (logLevel) cli.logging = { level: logLevel };

  const env = getFlag(argv, "--env");
  if (env) cli.environment = env;

  return cli;
}

function parseEnvVars(env: Record<string, string | undefined>): Record<string, unknown> {
  const raw: Record<string, unknown> = {};

  if (env.CORE_PROJECT_NAME) raw.projectName = env.CORE_PROJECT_NAME;
  if (env.NODE_ENV === "production") raw.environment = "prod";
  else if (env.NODE_ENV === "staging") raw.environment = "staging";
  else if (env.NODE_ENV === "test") raw.environment = "test";
  else if (env.NODE_ENV === "development") raw.environment = "dev";
  else if (env.CORE_ENV) raw.environment = env.CORE_ENV;

  if (env.CORE_HOME) raw.brainDir = env.CORE_HOME;
  if (env.CORE_DATA) raw.dataDir = env.CORE_DATA;
  if (env.CORE_ENCRYPT === "true") raw.encrypt = true;
  if (env.CORE_SAFE_WORD) raw.safeWord = env.CORE_SAFE_WORD;

  const api: Record<string, unknown> = {};
  if (env.CORE_PORT) api.port = parseInt(env.CORE_PORT, 10);
  if (env.CORS_ORIGINS) api.cors = env.CORS_ORIGINS.split(",");
  if (env.TRUST_PROXY === "true") api.trustProxy = true;
  if (Object.keys(api).length) raw.api = api;

  const logging: Record<string, unknown> = {};
  if (env.LOG_LEVEL) logging.level = env.LOG_LEVEL;
  if (env.LOG_FORMAT) logging.format = env.LOG_FORMAT;
  if (Object.keys(logging).length) raw.logging = logging;

  return raw;
}

const CONFIG_FILE_NAMES = ["runcore.config.json", ".corerc.json"];

function findConfigFile(argv: string[], env: Record<string, string | undefined>): string | null {
  const explicit = getFlag(argv, "--config");
  if (explicit) return resolve(explicit);

  for (const name of CONFIG_FILE_NAMES) {
    const path = resolve(name);
    try { readFileSync(path); return path; } catch {}
  }

  if (env.CORE_HOME) {
    const path = resolve(env.CORE_HOME, "config.json");
    try { readFileSync(path); return path; } catch {}
  }

  return null;
}

function loadConfigFile(filePath: string): Record<string, unknown> {
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch (err) {
    throw new ConfigError(`Cannot read config file: ${filePath}`, err);
  }
  try {
    return JSON.parse(content) as Record<string, unknown>;
  } catch (err) {
    throw new ConfigError(`Invalid JSON in config file: ${filePath}`, err);
  }
}

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const sv = source[key];
    if (sv !== undefined && sv !== null && typeof sv === "object" && !Array.isArray(sv)) {
      result[key] = deepMerge(
        (result[key] as Record<string, unknown>) ?? {},
        sv as Record<string, unknown>,
      );
    } else if (sv !== undefined) {
      result[key] = sv;
    }
  }
  return result;
}

export function loadConfig(options: LoadConfigOptions = {}): ProjectConfig {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? (process.env as Record<string, string | undefined>);

  let fileConfig: Record<string, unknown> = {};
  if (!options.skipFile) {
    const configPath = findConfigFile(argv, env);
    if (configPath) fileConfig = loadConfigFile(configPath);
  }

  const envConfig = parseEnvVars(env);
  const cliConfig = parseCliArgs(argv);
  const merged = deepMerge(deepMerge(fileConfig, envConfig), cliConfig);

  if (typeof merged.brainDir === "string") merged.brainDir = resolve(merged.brainDir);
  if (typeof merged.dataDir === "string") merged.dataDir = resolve(merged.dataDir);

  const result = ProjectConfigSchema.safeParse(merged);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new ConfigError(`Invalid configuration:\n${issues}`, result.error);
  }
  return result.data;
}

export function tryLoadConfig(
  options: LoadConfigOptions = {},
): { config: ProjectConfig; error: null } | { config: null; error: ConfigError } {
  try {
    return { config: loadConfig(options), error: null };
  } catch (err) {
    if (err instanceof ConfigError) return { config: null, error: err };
    return { config: null, error: new ConfigError("Unexpected error loading config", err) };
  }
}
