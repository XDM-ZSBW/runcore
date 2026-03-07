/**
 * Spawn Policy Loader — governs what agent types can be spawned and how many.
 *
 * Reads brain/templates/spawn-policy.yaml (or instance-specific path).
 * Provides checkSpawnPolicy() for the governance gate to call before spawn.
 *
 * Hand-rolled YAML parser (no external deps).
 */

import { readFile } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createLogger } from "../utils/logger.js";

const log = createLogger("agents.spawn-policy");

const BRAIN_DIR = resolve(process.cwd(), "brain");
const DEFAULT_POLICY_PATH = join(BRAIN_DIR, "templates", "spawn-policy.yaml");

// ── Types ────────────────────────────────────────────────────────────────────

export interface AllowedType {
  max: number;
  autoSpawn: boolean;
}

export interface SpawnPolicy {
  owner: string;
  governedBy: string;
  maxAgents: number;
  allowedTypes: Map<string, AllowedType>;
  denyTypes: string[];
  requireOwnerApproval: boolean;
}

export interface SpawnPolicyCheck {
  allowed: boolean;
  reason?: string;
}

// ── Cache ────────────────────────────────────────────────────────────────────

let cached: SpawnPolicy | null = null;

// ── YAML parser ──────────────────────────────────────────────────────────────

function parseSpawnPolicy(raw: string): SpawnPolicy {
  const lines = raw.split("\n");

  let owner = "";
  let governedBy = "";
  let maxAgents = 4;
  let requireOwnerApproval = true;
  const allowedTypes = new Map<string, AllowedType>();
  const denyTypes: string[] = [];

  // State: which section are we in?
  type Section = "root" | "allowed_types" | "allowed_type_entry" | "deny_types";
  let section: Section = "root";
  let currentType = "";

  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (!trimmed || trimmed.match(/^\s*#/)) continue;

    const indent = (line.match(/^(\s*)/) ?? ["", ""])[1].length;

    // Top-level key: value
    if (indent === 0) {
      const kv = trimmed.match(/^(\w[\w_]*)\s*:\s*(.+)$/);
      if (kv) {
        const [, key, val] = kv;
        const unquoted = val.replace(/^["']|["']$/g, "").trim();
        if (key === "owner") owner = unquoted;
        else if (key === "governed_by") governedBy = unquoted;
        else if (key === "max_agents") maxAgents = parseInt(unquoted, 10) || 4;
        else if (key === "require_owner_approval") requireOwnerApproval = unquoted === "true";
        section = "root";
        continue;
      }

      // Section header
      const sectionHeader = trimmed.match(/^(\w[\w_]*)\s*:\s*$/);
      if (sectionHeader) {
        if (sectionHeader[1] === "allowed_types") section = "allowed_types";
        else if (sectionHeader[1] === "deny_types") section = "deny_types";
        else section = "root";
        continue;
      }
    }

    // Under allowed_types — type name headers (indent 2)
    if (section === "allowed_types" && indent >= 2) {
      const typeHeader = trimmed.trim().match(/^([\w-]+)\s*:\s*$/);
      if (typeHeader) {
        currentType = typeHeader[1];
        allowedTypes.set(currentType, { max: 1, autoSpawn: false });
        section = "allowed_type_entry";
        continue;
      }
    }

    // Under a specific allowed type entry (indent 4)
    if (section === "allowed_type_entry" && indent >= 4) {
      const kv = trimmed.trim().match(/^(\w[\w_]*)\s*:\s*(.+)$/);
      if (kv) {
        const [, key, val] = kv;
        const entry = allowedTypes.get(currentType);
        if (entry) {
          if (key === "max") entry.max = parseInt(val, 10) || 1;
          else if (key === "auto_spawn") entry.autoSpawn = val.trim() === "true";
        }
        continue;
      }
      // New type header at indent 2 — go back to allowed_types
      const typeHeader = trimmed.trim().match(/^([\w-]+)\s*:\s*$/);
      if (typeHeader) {
        currentType = typeHeader[1];
        allowedTypes.set(currentType, { max: 1, autoSpawn: false });
        continue;
      }
    }

    // deny_types list items
    if (section === "deny_types") {
      const listItem = trimmed.match(/^\s+-\s+(.+)$/);
      if (listItem) {
        denyTypes.push(listItem[1].replace(/^["']|["']$/g, "").trim());
      }
    }
  }

  return { owner, governedBy, maxAgents, allowedTypes, denyTypes, requireOwnerApproval };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Load and cache the spawn policy.
 */
export async function loadSpawnPolicy(policyPath?: string): Promise<SpawnPolicy> {
  if (cached) return cached;
  const filePath = policyPath ?? DEFAULT_POLICY_PATH;
  try {
    const raw = await readFile(filePath, "utf-8");
    cached = parseSpawnPolicy(raw);
    log.info("Spawn policy loaded", {
      maxAgents: cached.maxAgents,
      allowedTypes: Array.from(cached.allowedTypes.keys()),
      denyTypes: cached.denyTypes,
    });
  } catch (err: any) {
    if (err.code === "ENOENT") {
      log.warn("No spawn-policy.yaml found — using permissive defaults");
    } else {
      log.warn("Failed to parse spawn-policy.yaml", { error: err.message });
    }
    cached = {
      owner: "",
      governedBy: "",
      maxAgents: 4,
      allowedTypes: new Map(),
      denyTypes: [],
      requireOwnerApproval: false,
    };
  }
  return cached;
}

/**
 * Get the cached spawn policy (loads synchronously if not cached).
 */
export function getSpawnPolicy(): SpawnPolicy {
  if (!cached) {
    try {
      if (existsSync(DEFAULT_POLICY_PATH)) {
        const raw = readFileSync(DEFAULT_POLICY_PATH, "utf-8");
        cached = parseSpawnPolicy(raw);
      }
    } catch {
      // Fall through to defaults
    }
    if (!cached) {
      cached = {
        owner: "",
        governedBy: "",
        maxAgents: 4,
        allowedTypes: new Map(),
        denyTypes: [],
        requireOwnerApproval: false,
      };
    }
  }
  return cached;
}

/**
 * Check whether spawning an agent of the given type is allowed.
 *
 * @param agentType   - The agent type to spawn (e.g. "administration", "brand")
 * @param currentCount - Total number of currently running agents
 * @param typeCount    - Number of currently running agents of this specific type
 */
export function checkSpawnPolicy(
  agentType: string,
  currentCount: number,
  typeCount: number,
): SpawnPolicyCheck {
  const policy = getSpawnPolicy();

  // Check deny list
  if (policy.denyTypes.includes(agentType)) {
    return { allowed: false, reason: `Agent type "${agentType}" is denied by spawn policy` };
  }

  // Check global max
  if (currentCount >= policy.maxAgents) {
    return { allowed: false, reason: `Max agents reached (${policy.maxAgents})` };
  }

  // Check type-specific max
  const typeConfig = policy.allowedTypes.get(agentType);
  if (typeConfig && typeCount >= typeConfig.max) {
    return { allowed: false, reason: `Max "${agentType}" agents reached (${typeConfig.max})` };
  }

  // If the type isn't in allowed_types and the map is non-empty, it's implicitly denied
  if (policy.allowedTypes.size > 0 && !typeConfig) {
    return { allowed: false, reason: `Agent type "${agentType}" is not in allowed_types` };
  }

  return { allowed: true };
}

/**
 * Force reload of spawn policy.
 */
export async function reloadSpawnPolicy(policyPath?: string): Promise<SpawnPolicy> {
  cached = null;
  return loadSpawnPolicy(policyPath);
}
