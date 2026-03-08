/**
 * Core settings — airplane mode + model selection.
 * Backed by brain/settings.json. Cached in memory after first load.
 */

import { readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { checkOllama } from "./llm/ollama.js";
import type { ProviderName } from "./llm/providers/types.js";
import { createLogger } from "./utils/logger.js";
import { setWriteEncryptionEnabled } from "./lib/key-store.js";
import { BRAIN_DIR } from "./lib/paths.js";

const log = createLogger("settings");

const SETTINGS_PATH = join(BRAIN_DIR, "settings.json");

// --- Schema ---

export interface TtsConfig {
  enabled: boolean;
  port: number;
  voice: string;
  autoPlay: boolean;
}

export interface SttConfig {
  enabled: boolean;
  port: number;
  model: string;
}

export interface AvatarConfig {
  enabled: boolean;
  port: number;
  musetalkPath: string;
  photoPath: string;
}

export interface BackupConfig {
  enabled: boolean;
  schedule: "daily" | "weekly" | "manual";
  providers: ("local" | "gdrive")[];
  localBackupDir: string;
  maxBackups: number;
  backupHour: number;
}

export interface PulseSettings {
  threshold: number;    // Θ — "anxious" (30), "balanced" (60), "stoic" (100)
  mode: "pressure" | "timer" | "hybrid";  // default "hybrid"
}

export interface VisualMemoryConfig {
  enabled: boolean;              // default: true
  autoSave: boolean;             // default: true — save every image automatically
  maxImagesPerTurn: number;      // default: 2 — max images re-injected into context
  maxImageBytes: number;         // default: 10 * 1024 * 1024 (10 MB)
  descriptionModel: "chat" | "utility";  // default: "utility"
}

export interface MeshConfig {
  /** Announce this instance on the local network via mDNS.
   *  Disable on shared/public networks (airports, coffee shops, coworking). */
  lanAnnounce: boolean;
  /** Allow incoming mesh connections from discovered peers. */
  allowIncoming: boolean;
}

export interface IntegrationSettings {
  /** Master kill switch. false = no secrets hydrated, full air-gap. */
  enabled: boolean;
  /** Per-service toggles. Unlisted services default to enabled. */
  services?: Record<string, boolean>;
}

export interface CoreSettings {
  /** Display name for this instance. Default: "Core". */
  instanceName?: string;
  airplaneMode: boolean;
  /** Hard network isolation. When true, ALL outbound LLM API calls are blocked
   *  at the request layer — only local providers (Ollama) are allowed.
   *  Unlike airplaneMode (which just swaps the provider), this enforces the block
   *  even if code explicitly requests a cloud provider. */
  privateMode: boolean;
  /** Explicit provider override. When set, takes precedence over airplaneMode. */
  provider?: ProviderName;
  models: { chat: string; utility: string };
  /** Encrypt all brain files at rest (JSONL, YAML, MD, JSON).
   *  When false, files are written as plaintext even if an encryption key is available. */
  encryptBrainFiles: boolean;
  /** When to require password entry.
   *  "always" — every page load (default). "restart" — only after server/browser restart. */
  safeWordMode: "always" | "restart";
  tts: TtsConfig;
  stt: SttConfig;
  avatar: AvatarConfig;
  backup: BackupConfig;
  pulse: PulseSettings;
  mesh: MeshConfig;
  visualMemory?: VisualMemoryConfig;
  /** Integration gate — master switch + per-service toggles. */
  integrations?: IntegrationSettings;
  /** Opt-in: send anonymized self-reported issues to runcore.sh for backlog aggregation. */
  issueReporting?: boolean;
}

/** @deprecated Use CoreSettings instead. */
export type DashSettings = CoreSettings;

const DEFAULTS: CoreSettings = {
  instanceName: "Core",
  airplaneMode: false,
  privateMode: false,
  models: { chat: "auto", utility: "auto" },
  encryptBrainFiles: true,
  safeWordMode: "always",
  tts: { enabled: true, port: 3579, voice: "en_US-lessac-medium", autoPlay: true },
  stt: { enabled: true, port: 3580, model: "ggml-base.en.bin" },
  avatar: { enabled: false, port: 3581, musetalkPath: "", photoPath: "public/avatar/photo.png" },
  backup: { enabled: false, schedule: "daily", providers: ["local"], localBackupDir: ".core-backups", maxBackups: 7, backupHour: 3 },
  pulse: { threshold: 60, mode: "hybrid" },
  mesh: { lanAnnounce: false, allowIncoming: false },
};

// --- Cache ---

let cached: CoreSettings = { ...DEFAULTS, models: { ...DEFAULTS.models }, tts: { ...DEFAULTS.tts }, stt: { ...DEFAULTS.stt }, avatar: { ...DEFAULTS.avatar }, backup: { ...DEFAULTS.backup, providers: [...DEFAULTS.backup.providers] }, pulse: { ...DEFAULTS.pulse }, mesh: { ...DEFAULTS.mesh } };

// --- Load / Save ---

/**
 * Read brain/settings.json, returning defaults if missing or malformed.
 * On first run (no settings file), probes Ollama to pick the right default:
 * Ollama available → airplaneMode: true, otherwise false.
 */
export async function loadSettings(): Promise<CoreSettings> {
  let fileExists = false;
  try {
    await access(SETTINGS_PATH);
    fileExists = true;
  } catch {}

  if (fileExists) {
    try {
      const raw = await readFile(SETTINGS_PATH, "utf-8");
      const parsed = JSON.parse(raw);
      const validProviders: ProviderName[] = ["openrouter", "anthropic", "openai", "ollama"];
      cached = {
        airplaneMode: typeof parsed.airplaneMode === "boolean" ? parsed.airplaneMode : DEFAULTS.airplaneMode,
        privateMode: typeof parsed.privateMode === "boolean" ? parsed.privateMode : DEFAULTS.privateMode,
        provider: validProviders.includes(parsed.provider) ? parsed.provider : undefined,
        models: {
          chat: typeof parsed.models?.chat === "string" ? parsed.models.chat : DEFAULTS.models.chat,
          utility: typeof parsed.models?.utility === "string" ? parsed.models.utility : DEFAULTS.models.utility,
        },
        encryptBrainFiles: typeof parsed.encryptBrainFiles === "boolean" ? parsed.encryptBrainFiles
          : typeof parsed.encryptEpisodicFiles === "boolean" ? parsed.encryptEpisodicFiles
          : DEFAULTS.encryptBrainFiles,
        safeWordMode: ["always", "restart"].includes(parsed.safeWordMode) ? parsed.safeWordMode : DEFAULTS.safeWordMode,
        tts: {
          enabled: typeof parsed.tts?.enabled === "boolean" ? parsed.tts.enabled : DEFAULTS.tts.enabled,
          port: typeof parsed.tts?.port === "number" ? parsed.tts.port : DEFAULTS.tts.port,
          voice: typeof parsed.tts?.voice === "string" ? parsed.tts.voice : DEFAULTS.tts.voice,
          autoPlay: typeof parsed.tts?.autoPlay === "boolean" ? parsed.tts.autoPlay : DEFAULTS.tts.autoPlay,
        },
        stt: {
          enabled: typeof parsed.stt?.enabled === "boolean" ? parsed.stt.enabled : DEFAULTS.stt.enabled,
          port: typeof parsed.stt?.port === "number" ? parsed.stt.port : DEFAULTS.stt.port,
          model: typeof parsed.stt?.model === "string" ? parsed.stt.model : DEFAULTS.stt.model,
        },
        avatar: {
          enabled: typeof parsed.avatar?.enabled === "boolean" ? parsed.avatar.enabled : DEFAULTS.avatar.enabled,
          port: typeof parsed.avatar?.port === "number" ? parsed.avatar.port : DEFAULTS.avatar.port,
          musetalkPath: typeof parsed.avatar?.musetalkPath === "string" ? parsed.avatar.musetalkPath : DEFAULTS.avatar.musetalkPath,
          photoPath: typeof parsed.avatar?.photoPath === "string" ? parsed.avatar.photoPath : DEFAULTS.avatar.photoPath,
        },
        backup: {
          enabled: typeof parsed.backup?.enabled === "boolean" ? parsed.backup.enabled : DEFAULTS.backup.enabled,
          schedule: ["daily", "weekly", "manual"].includes(parsed.backup?.schedule) ? parsed.backup.schedule : DEFAULTS.backup.schedule,
          providers: Array.isArray(parsed.backup?.providers) ? parsed.backup.providers.filter((p: string) => ["local", "gdrive"].includes(p)) : DEFAULTS.backup.providers,
          localBackupDir: typeof parsed.backup?.localBackupDir === "string" ? parsed.backup.localBackupDir : DEFAULTS.backup.localBackupDir,
          maxBackups: typeof parsed.backup?.maxBackups === "number" ? parsed.backup.maxBackups : DEFAULTS.backup.maxBackups,
          backupHour: typeof parsed.backup?.backupHour === "number" ? parsed.backup.backupHour : DEFAULTS.backup.backupHour,
        },
        pulse: {
          threshold: typeof parsed.pulse?.threshold === "number" ? parsed.pulse.threshold : DEFAULTS.pulse.threshold,
          mode: ["pressure", "timer", "hybrid"].includes(parsed.pulse?.mode) ? parsed.pulse.mode : DEFAULTS.pulse.mode,
        },
        mesh: {
          lanAnnounce: typeof parsed.mesh?.lanAnnounce === "boolean" ? parsed.mesh.lanAnnounce : DEFAULTS.mesh.lanAnnounce,
          allowIncoming: typeof parsed.mesh?.allowIncoming === "boolean" ? parsed.mesh.allowIncoming : DEFAULTS.mesh.allowIncoming,
        },
        instanceName: typeof parsed.instanceName === "string" ? parsed.instanceName
          : typeof parsed.agentName === "string" ? parsed.agentName  // compat with Dash
          : undefined,
        integrations: parsed.integrations && typeof parsed.integrations === "object" ? {
          enabled: typeof parsed.integrations.enabled === "boolean" ? parsed.integrations.enabled : true,
          services: parsed.integrations.services && typeof parsed.integrations.services === "object"
            ? parsed.integrations.services
            : undefined,
        } : undefined,
      };
    } catch {
      cached = { ...DEFAULTS, models: { ...DEFAULTS.models }, pulse: { ...DEFAULTS.pulse } };
    }
  } else {
    // First run — probe Ollama to pick a sensible default
    const ollama = await checkOllama();
    const useLocal = ollama.available;
    cached = {
      airplaneMode: useLocal,
      privateMode: DEFAULTS.privateMode,
      models: { ...DEFAULTS.models },
      encryptBrainFiles: DEFAULTS.encryptBrainFiles,
      safeWordMode: DEFAULTS.safeWordMode,
      tts: { ...DEFAULTS.tts },
      stt: { ...DEFAULTS.stt },
      avatar: { ...DEFAULTS.avatar },
      backup: { ...DEFAULTS.backup, providers: [...DEFAULTS.backup.providers] },
      pulse: { ...DEFAULTS.pulse },
      mesh: { ...DEFAULTS.mesh },
    };
    // Persist so subsequent starts don't re-probe
    await saveSettings(cached).catch(() => {});
    if (useLocal) {
      log.info("First run: Ollama detected, defaulting to airplane mode");
    } else {
      log.info("First run: Ollama not available, defaulting to OpenRouter");
    }
  }
  setWriteEncryptionEnabled(cached.encryptBrainFiles);
  return cached;
}

/** Write current settings to brain/settings.json. */
export async function saveSettings(s: DashSettings): Promise<void> {
  await writeFile(SETTINGS_PATH, JSON.stringify(s, null, 2) + "\n", "utf-8");
}

/** Sync getter for the in-memory cached settings. Call loadSettings() at startup first. */
export function getSettings(): CoreSettings {
  return cached;
}

/** Merge partial updates, save to disk, update cache. Returns the new settings. */
export async function updateSettings(partial: Partial<CoreSettings>): Promise<CoreSettings> {
  if (typeof partial.airplaneMode === "boolean") {
    cached.airplaneMode = partial.airplaneMode;
  }
  if (typeof partial.privateMode === "boolean") {
    cached.privateMode = partial.privateMode;
  }
  if (partial.provider !== undefined) {
    cached.provider = partial.provider;
  }
  if (partial.models) {
    if (typeof partial.models.chat === "string") cached.models.chat = partial.models.chat;
    if (typeof partial.models.utility === "string") cached.models.utility = partial.models.utility;
  }
  if (typeof partial.encryptBrainFiles === "boolean") {
    cached.encryptBrainFiles = partial.encryptBrainFiles;
    setWriteEncryptionEnabled(partial.encryptBrainFiles);
  }
  if (partial.safeWordMode && ["always", "restart"].includes(partial.safeWordMode)) {
    cached.safeWordMode = partial.safeWordMode;
  }
  if (partial.tts) {
    if (typeof partial.tts.enabled === "boolean") cached.tts.enabled = partial.tts.enabled;
    if (typeof partial.tts.port === "number") cached.tts.port = partial.tts.port;
    if (typeof partial.tts.voice === "string") cached.tts.voice = partial.tts.voice;
    if (typeof partial.tts.autoPlay === "boolean") cached.tts.autoPlay = partial.tts.autoPlay;
  }
  if (partial.stt) {
    if (typeof partial.stt.enabled === "boolean") cached.stt.enabled = partial.stt.enabled;
    if (typeof partial.stt.port === "number") cached.stt.port = partial.stt.port;
    if (typeof partial.stt.model === "string") cached.stt.model = partial.stt.model;
  }
  if (partial.avatar) {
    if (typeof partial.avatar.enabled === "boolean") cached.avatar.enabled = partial.avatar.enabled;
    if (typeof partial.avatar.port === "number") cached.avatar.port = partial.avatar.port;
    if (typeof partial.avatar.musetalkPath === "string") cached.avatar.musetalkPath = partial.avatar.musetalkPath;
    if (typeof partial.avatar.photoPath === "string") cached.avatar.photoPath = partial.avatar.photoPath;
  }
  if (partial.backup) {
    if (typeof partial.backup.enabled === "boolean") cached.backup.enabled = partial.backup.enabled;
    if (partial.backup.schedule) cached.backup.schedule = partial.backup.schedule;
    if (Array.isArray(partial.backup.providers)) cached.backup.providers = partial.backup.providers;
    if (typeof partial.backup.localBackupDir === "string") cached.backup.localBackupDir = partial.backup.localBackupDir;
    if (typeof partial.backup.maxBackups === "number") cached.backup.maxBackups = partial.backup.maxBackups;
    if (typeof partial.backup.backupHour === "number") cached.backup.backupHour = partial.backup.backupHour;
  }
  if (partial.pulse) {
    if (typeof partial.pulse.threshold === "number") cached.pulse.threshold = partial.pulse.threshold;
    if (["pressure", "timer", "hybrid"].includes(partial.pulse.mode as string)) cached.pulse.mode = partial.pulse.mode!;
  }
  if (partial.mesh) {
    if (typeof partial.mesh.lanAnnounce === "boolean") cached.mesh.lanAnnounce = partial.mesh.lanAnnounce;
    if (typeof partial.mesh.allowIncoming === "boolean") cached.mesh.allowIncoming = partial.mesh.allowIncoming;
  }
  if (partial.integrations) {
    if (!cached.integrations) cached.integrations = { enabled: true };
    if (typeof partial.integrations.enabled === "boolean") {
      cached.integrations.enabled = partial.integrations.enabled;
    }
    if (partial.integrations.services && typeof partial.integrations.services === "object") {
      cached.integrations.services = {
        ...cached.integrations.services,
        ...partial.integrations.services,
      };
    }
  }
  await saveSettings(cached);
  return cached;
}

// --- Resolvers ---

/** Returns the active provider. privateMode and master integration kill switch force Ollama. */
export function resolveProvider(): ProviderName {
  // Private mode → force local-only (hard enforcement happens in guard.ts)
  if (cached.privateMode) return "ollama";
  // Master integration gate off → force local-only
  if (cached.integrations?.enabled === false) return "ollama";
  if (cached.provider) return cached.provider;
  return cached.airplaneMode ? "ollama" : "openrouter";
}

/**
 * Returns the chat (streaming) model string, or undefined for "auto"
 * (lets the LLM module fall through to its own default).
 */
export function resolveChatModel(): string | undefined {
  const v = cached.models.chat;
  return v === "auto" ? undefined : v;
}

/**
 * Returns the utility (background tasks) model string, or undefined for "auto"
 * (lets completeChat fall through to its own default).
 */
export function resolveUtilityModel(): string | undefined {
  const v = cached.models.utility;
  return v === "auto" ? undefined : v;
}

/** Returns the TTS configuration. */
export function getTtsConfig(): TtsConfig {
  return cached.tts;
}

/** Returns the STT configuration. */
export function getSttConfig(): SttConfig {
  return cached.stt;
}

/** Returns the Avatar configuration. */
export function getAvatarConfig(): AvatarConfig {
  return cached.avatar;
}

/** Returns the Backup configuration. */
export function getBackupConfig(): BackupConfig {
  return cached.backup;
}

/** Returns the Pulse configuration. */
export function getPulseSettings(): PulseSettings {
  return cached.pulse;
}

/** Returns the Mesh configuration. */
export function getMeshConfig(): MeshConfig {
  return cached.mesh;
}
