/**
 * Registry heartbeat — periodic check-in for tier >= byok.
 *
 * Reports: version, tier, uptime.
 * Receives: token validity, freeze signals.
 * Non-blocking, best-effort. Failures are logged, not fatal.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TierName, FreezeSignal } from "./types.js";

const REGISTRY_URL = "https://runcore.sh/api/registry";
const HEARTBEAT_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const REVALIDATE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let revalidateTimer: ReturnType<typeof setInterval> | null = null;
let startedAt = Date.now();
let frozen = false;

export interface HeartbeatResponse {
  valid: boolean;
  frozen?: boolean;
  freeze?: FreezeSignal;
  tier?: TierName;
}

export type FreezeHandler = (signal: FreezeSignal) => void;
export type DowngradeHandler = (newTier: TierName) => void;

let onFreeze: FreezeHandler | null = null;
let onDowngrade: DowngradeHandler | null = null;

export function onFreezeSignal(handler: FreezeHandler): void {
  onFreeze = handler;
}

export function onTierDowngrade(handler: DowngradeHandler): void {
  onDowngrade = handler;
}

export function isFrozen(): boolean {
  return frozen;
}

function getVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dirname, "../../package.json"), "utf-8")
    );
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

async function sendHeartbeat(jwt: string, tier: TierName): Promise<void> {
  try {
    const res = await fetch(`${REGISTRY_URL}/heartbeat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({
        version: getVersion(),
        tier,
        uptime: Math.floor((Date.now() - startedAt) / 1000),
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) return;

    const data = (await res.json()) as HeartbeatResponse;

    if (data.frozen && data.freeze) {
      frozen = true;
      onFreeze?.(data.freeze);
    }

    if (!data.valid) {
      // Token revoked — downgrade to local
      onDowngrade?.("local");
    }

    if (data.tier && data.tier !== tier) {
      // Tier changed (upgrade or downgrade by admin)
      onDowngrade?.(data.tier);
    }
  } catch {
    // Best effort — swallow network errors
  }
}

async function revalidateToken(jwt: string): Promise<boolean> {
  try {
    const res = await fetch(`${REGISTRY_URL}/validate`, {
      headers: { Authorization: `Bearer ${jwt}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { valid: boolean };
    return data.valid === true;
  } catch {
    return true; // Assume valid if we can't reach registry (offline-first)
  }
}

export function startHeartbeat(jwt: string, tier: TierName, root?: string): void {
  startedAt = Date.now();

  // Retry bond if not yet confirmed
  if (root) {
    retryBondIfNeeded(root, jwt).catch(() => {});
  }

  // Immediate first heartbeat
  sendHeartbeat(jwt, tier);

  heartbeatTimer = setInterval(() => sendHeartbeat(jwt, tier), HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();

  revalidateTimer = setInterval(async () => {
    const valid = await revalidateToken(jwt);
    if (!valid) onDowngrade?.("local");
  }, REVALIDATE_INTERVAL_MS);
  revalidateTimer.unref();
}

/** Retry bond announcement if keys exist locally but registry hasn't confirmed. */
async function retryBondIfNeeded(root: string, jwt: string): Promise<void> {
  try {
    const { loadBondKeys, bond } = await import("./bond.js");
    const keys = await loadBondKeys(root);
    if (!keys) return; // No keys = not activated yet, nothing to retry

    // Try to announce again — bond() handles the idempotency
    const parts = jwt.split(".");
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"));
    await bond(root, jwt, payload.jti);
  } catch {
    // Best effort
  }
}

export function stopHeartbeat(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (revalidateTimer) clearInterval(revalidateTimer);
  heartbeatTimer = null;
  revalidateTimer = null;
}
