/**
 * JSONL schema migration framework.
 * Checks _version on the schema header line and runs migrations lazily on first read.
 * Migrations are registered per-schema and run in version order.
 */

import { createLogger } from "../utils/logger.js";

const log = createLogger("schema-migration");

type MigrationFn = (entry: Record<string, unknown>) => Record<string, unknown>;

interface Migration {
  fromVersion: string;
  toVersion: string;
  migrate: MigrationFn;
}

const registry = new Map<string, Migration[]>();

/**
 * Register a migration for a schema.
 * Migrations run in order: 1.0 → 1.1 → 1.2.
 */
export function registerMigration(
  schema: string,
  fromVersion: string,
  toVersion: string,
  migrate: MigrationFn,
): void {
  const key = schema;
  if (!registry.has(key)) registry.set(key, []);
  registry.get(key)!.push({ fromVersion, toVersion, migrate });
}

/**
 * Apply migrations to a parsed JSONL entry based on its schema version.
 * Returns the migrated entry and the final version.
 * If no migrations are needed, returns the entry unchanged.
 */
export function migrateEntry(
  schema: string,
  currentVersion: string,
  entry: Record<string, unknown>,
): { entry: Record<string, unknown>; version: string } {
  const migrations = registry.get(schema);
  if (!migrations || migrations.length === 0) {
    return { entry, version: currentVersion };
  }

  let version = currentVersion;
  let result = entry;

  // Apply migrations in chain: find the one matching current version, apply, repeat
  let applied = true;
  while (applied) {
    applied = false;
    for (const m of migrations) {
      if (m.fromVersion === version) {
        try {
          result = m.migrate(result);
          version = m.toVersion;
          applied = true;
          break;
        } catch (err) {
          log.warn(`Migration ${schema} ${m.fromVersion}→${m.toVersion} failed: ${err instanceof Error ? err.message : String(err)}`);
          return { entry: result, version };
        }
      }
    }
  }

  return { entry: result, version };
}

/**
 * Extract schema name and version from a JSONL schema header line.
 * Returns null if the line is not a schema header.
 */
export function parseSchemaHeader(
  line: string,
): { schema: string; version: string } | null {
  try {
    const obj = JSON.parse(line);
    if (obj._schema && obj._version) {
      return { schema: obj._schema, version: obj._version };
    }
  } catch {
    // Not a valid JSON line
  }
  return null;
}

/**
 * Check if a schema has any registered migrations from the given version.
 */
export function hasMigrations(schema: string, fromVersion: string): boolean {
  const migrations = registry.get(schema);
  if (!migrations) return false;
  return migrations.some((m) => m.fromVersion === fromVersion);
}
