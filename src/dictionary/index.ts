/**
 * Dictionary Protocol — Barrel export.
 *
 * The dictionary is the canonical set of specs, patterns, and protocols
 * that define how Core works. Published via npm, synced by instances.
 */

export type {
  Dictionary,
  DictionarySpec,
  DictionaryDefaults,
  DictionaryVersionFile,
  DictionaryChangelogEntry,
  Glossary,
  SyncResult,
  CompatibilityResult,
} from "./types.js";

export {
  parseSemver,
  formatSemver,
  compareSemver,
  isValidSemver,
  getBumpType,
  bumpVersion,
} from "./versioning.js";

export {
  checkCompatibility,
  canCommunicate,
  validateDictionary,
} from "./compatibility.js";

export {
  scanSpecs,
  publishDictionary,
  buildDiff,
} from "./publisher.js";
export type { PublishOptions } from "./publisher.js";

export { DictionaryClient } from "./client.js";
export type { DictionaryClientOptions } from "./client.js";

export {
  startDictionaryUpdater,
  stopDictionaryUpdater,
  isDictionaryUpdaterRunning,
  getLastSyncResult,
  getDictionaryClient,
} from "./updater.js";
export type { DictionaryUpdaterConfig } from "./updater.js";

export { bootSync } from "./sync.js";
export type { SyncConfig, BootSyncResult } from "./sync.js";

export { matchSpecs, indexSpecs, buildSpecIndex } from "./matcher.js";
export type { IndexedSpec } from "./matcher.js";

export {
  submitChallenge,
  readChallenges,
  readChallengesByStatus,
  readChallengesForSpec,
  updateChallengeStatus,
  getCurrentChallenges,
  setChallengeLogPath,
} from "./challenge.js";
export type {
  ChallengeCategory,
  ChallengeStatus,
  ChallengeRequest,
  ChallengeRecord,
  SignalEmitter,
  EmittedSignal,
} from "./challenge.js";
