/**
 * Tier system — capability levels gated by trust.
 *
 * Level 1: Local    — brain + Ollama, zero network
 * Level 2: BYOK     — full server/UI/mesh, your keys
 * Level 3: Spawn    — agent spawning + multi-agent orchestration
 * Level 4: Hosted   — runs on Herrman Group infrastructure
 */

export type TierName = "local" | "byok" | "spawn" | "hosted";

export const TIER_LEVEL: Record<TierName, number> = {
  local: 1,
  byok: 2,
  spawn: 3,
  hosted: 4,
};

export interface TierCapabilities {
  brain: boolean;
  memory: boolean;
  ollama: boolean;
  server: boolean;
  ui: boolean;
  mesh: boolean;
  alerting: boolean;
  spawning: boolean;
  governance: boolean;
  vault: boolean;
  voice: boolean;
  integrations: boolean;
}

export const TIER_CAPS: Record<TierName, TierCapabilities> = {
  local: {
    brain: true,
    memory: true,
    ollama: true,
    server: false,
    ui: false,
    mesh: false,
    alerting: false,
    spawning: false,
    governance: false,
    vault: false,
    voice: false,
    integrations: false,
  },
  byok: {
    brain: true,
    memory: true,
    ollama: true,
    server: true,
    ui: true,
    mesh: true,
    alerting: true,
    spawning: false,
    governance: false,
    vault: true,
    voice: true,
    integrations: true,
  },
  spawn: {
    brain: true,
    memory: true,
    ollama: true,
    server: true,
    ui: true,
    mesh: true,
    alerting: true,
    spawning: true,
    governance: true,
    vault: true,
    voice: true,
    integrations: true,
  },
  hosted: {
    brain: true,
    memory: true,
    ollama: true,
    server: true,
    ui: true,
    mesh: true,
    alerting: true,
    spawning: true,
    governance: true,
    vault: true,
    voice: true,
    integrations: true,
  },
};

export interface ActivationToken {
  /** Unique token ID — used for revocation checks */
  jti: string;
  tier: TierName;
  org: string;
  email: string;
  issued: string;
  expires: string;
}

export interface RegistrationRequest {
  name: string;
  email: string;
  instanceId: string;
  requestedAt: string;
}

export interface FreezeSignal {
  jti: string;
  reason: string;
  issuedBy: string;
  issuedAt: string;
}
