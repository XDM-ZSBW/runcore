/**
 * Dictionary Protocol — Shared types.
 *
 * The dictionary is the canonical set of specs, glossary, defaults, and protocols
 * that define how Core works. Published via npm, synced by instances.
 */

/** A single spec entry in the dictionary. */
export interface DictionarySpec {
  name: string;
  title: string;
  status: string;
  content: string;
  checksum: string;
}

/** Glossary: canonical term definitions. */
export type Glossary = Record<string, string>;

/** Default configuration values recommended by the dictionary. */
export interface DictionaryDefaults {
  dehydration: {
    quiet_threshold_multiplier: number;
    stage_duration: string;
    grace_period: string;
  };
  calibration: {
    recalibration_interval_interactions: number;
    recalibration_interval_ticks: number;
  };
  posture: {
    board_decay_minutes: number;
    pulse_decay_minutes: number;
  };
  pain: {
    token_budget_warn: number;
    error_spike_threshold: number;
  };
  [key: string]: Record<string, unknown>;
}

/** The full dictionary payload. */
export interface Dictionary {
  version: string;
  publishedAt: string;
  specs: DictionarySpec[];
  glossary: Glossary;
  defaults: DictionaryDefaults;
}

/** Local version tracking stored at brain/dictionary/version.json. */
export interface DictionaryVersionFile {
  version: string;
  synced_at: string;
}

/** A changelog entry appended to brain/dictionary/changelog.jsonl. */
export interface DictionaryChangelogEntry {
  version: string;
  timestamp: string;
  specsAdded: string[];
  specsUpdated: string[];
  specsRemoved: string[];
  summary: string;
}

/** Result of a sync check. */
export interface SyncResult {
  status: "updated" | "current" | "offline";
  localVersion: string;
  remoteVersion?: string;
  changes?: DictionaryChangelogEntry;
}

/** Compatibility check result. */
export interface CompatibilityResult {
  compatible: boolean;
  localVersion: string;
  remoteVersion: string;
  breakingChanges: string[];
  warnings: string[];
}
