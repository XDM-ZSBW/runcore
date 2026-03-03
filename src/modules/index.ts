/**
 * Brain Modules — Public API.
 */

// Types
export type {
  BrainModuleManifest,
  ManifestFile,
  ManifestEndpoint,
  BrainModule,
  ModuleResolution,
} from "./types.js";

// Registry
export {
  ModuleRegistry,
  createModuleRegistry,
  getModuleRegistry,
} from "./registry.js";
