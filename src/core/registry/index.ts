/**
 * Template & Skill Sharing Registry — Public API.
 */

// Types
export type {
  RegistryItemType,
  RegistryItemStatus,
  TemplateCategory,
  RegistryEntry,
  RegistryVersion,
  PublishRequest,
  PublishResult,
  ValidationResult,
  RegistrySearchQuery,
  RegistrySearchResult,
  InstallRequest,
  InstallResult,
} from "./types.js";
export { STATUS_TRANSITIONS, RegistryStatusError } from "./types.js";

// Store
export { RegistryStore } from "./store.js";

// Publisher
export {
  publishEntry,
  validatePublishRequest,
  generateEntryId,
  computeChecksum,
  compareSemver,
} from "./publisher.js";

// Search
export { searchRegistry } from "./search.js";

// Versions
export type { VersionHistory, VersionSummary } from "./versions.js";
export {
  getVersionHistory,
  getVersionContent,
  getLatestVersion,
  rollbackToVersion,
  isUpdateAvailable,
  getNewerVersions,
  verifyChecksum,
  hasVersion,
} from "./versions.js";

// Registry (main service)
export {
  SharingRegistry,
  createSharingRegistry,
  getSharingRegistry,
} from "./registry.js";
