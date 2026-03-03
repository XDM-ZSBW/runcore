/**
 * Brain module manifest types.
 *
 * Each brain/<module>/module.json describes a module so the runtime
 * can discover it, inject its prompt into the system message, and
 * load its instruction file when keywords match the user's message.
 */

export interface ManifestFile {
  path: string;
  role: "data" | "log" | "config";
  description?: string;
}

export interface ManifestEndpoint {
  path: string;
  method: string;
  description?: string;
}

export interface BrainModuleManifest {
  name: string;
  description: string;
  keywords: string[];
  files?: ManifestFile[];
  endpoints?: ManifestEndpoint[];
  prompt?: string;
  promptOrder?: number;
}

export interface BrainModule {
  manifest: BrainModuleManifest;
  dir: string;
  instructionFile: string | null;
  keywordPattern: RegExp;
}

export interface ModuleResolution {
  module: BrainModule;
  matchedKeyword: string;
}
