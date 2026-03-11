/**
 * Core Brain — public API.
 * The brain for Core: context assembly, modular memory, and internal actions (retrieve, learn).
 */

export { Brain } from "./brain.js";
export {
  InMemoryLongTermMemory,
  FileSystemLongTermMemory,
  createWorkingMemory,
  updateWorkingMemory,
  formatWorkingMemoryForContext,
} from "./memory/index.js";
export { assembleSections, sectionsToMessages, estimateTokens } from "./context/index.js";

export type { BrainConfig, GetContextOptions, GetContextResult, LearnInput, ContextMessage, ContextSections, WorkingMemory, MemoryEntry, LongTermMemoryType } from "./types.js";
export type { LongTermMemoryStore } from "./memory/long-term.js";
export type { ContextAssemblerConfig } from "./context/assembler.js";

// Distributed tracing — hosted tier, load via: await import("./tracing/index.js")
// Type re-exports are safe (zero runtime cost):
export type { TracingConfig, CorrelationContext, Span, SpanEvent, Trace, TraceDetail } from "./tracing/index.js";

// Structured logging
export { createLogger, log, enableFileLogging, setMinLevel, runWithCorrelationId, runWithContext } from "./utils/logger.js";
export type { Logger, LogLevel, LogEntry } from "./utils/logger.js";

// LLM response caching
export { TieredCache, MemoryCache, FileCache, createCache, generateCacheKey, hashString } from "./cache/index.js";
export type { CacheStore, LLMCacheConfig, MemoryCacheConfig, CacheStats, FileCacheConfig, CacheKeyInput } from "./cache/index.js";

// Skill validation
export { parseSkillYaml, validateSkill, validateSkillFile } from "./brain/skills.js";
export type { SkillDefinition, SkillValidationResult } from "./brain/skills.js";

// Pulse — metabolic activation (DASH-102)
export {
  emitCdt,
  emitVoltage,
  onActivation,
  createCdtEvent,
  createVoltageEvent,
  getActivationEvents,
  getPressureIntegrator,
  initPressureIntegrator,
} from "./pulse/index.js";
export type {
  ActivationEvent,
  ActivationEventBase,
  VoltageActivation,
  CdtActivation,
  ActivationListener,
  EmitCdtOptions,
  EmitVoltageOptions,
  PulseConfig,
  PulseStatus,
} from "./pulse/index.js";

// Package registry
export { PackageRegistry, createPackageRegistry, getPackageRegistry, RegistryStore, PackageInstaller } from "./registry/index.js";
export { validateManifest, validatePublishInput, validatePackageContent, checkDependencies } from "./registry/index.js";
export { search as searchRegistry, listTags as listRegistryTags, listAuthors as listRegistryAuthors } from "./registry/index.js";
export type { PackageKind, PackageManifest, PackageDependency, PackageStatus, RegistryEntry, SearchResult, SearchOptions, PackageValidation, InstallResult, PublishInput } from "./registry/index.js";
