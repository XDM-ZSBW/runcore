/**
 * Stub exports for gated modules.
 *
 * These provide clean error messages when someone tries to use
 * a gated feature without the required tier. Type stubs (.d.ts)
 * ship for autocomplete; these runtime stubs throw on access.
 */

import type { TierName } from "../tier/types.js";
import type { ExtensionName } from "./manifest.js";

/**
 * Create a proxy that throws a tier upgrade message on any property access.
 * Used as a drop-in replacement for gated module exports.
 */
export function createTierStub<T extends object>(
  moduleName: string,
  extension: ExtensionName,
  requiredTier: TierName
): T {
  const message =
    `"${moduleName}" requires the "${requiredTier}" tier. ` +
    `Run \`runcore register\` to upgrade, then \`runcore sync\` to download.`;

  return new Proxy({} as T, {
    get(_target, prop) {
      if (prop === Symbol.toPrimitive || prop === "toString" || prop === "valueOf") {
        return () => `[Stub: ${moduleName}]`;
      }
      if (typeof prop === "symbol") return undefined;
      throw new Error(message);
    },
    apply() {
      throw new Error(message);
    },
    construct() {
      throw new Error(message);
    },
  });
}

// ── Pre-built stubs for common gated modules ──

/** Vault stub (BYOK tier) */
export const VaultStub = createTierStub("vault", "ext-byok", "byok");

/** Notifications stub (BYOK tier) */
export const NotificationsStub = createTierStub("notifications", "ext-byok", "byok");

/** Agent spawn stub (Spawn tier) */
export const AgentSpawnStub = createTierStub("agents/spawn", "ext-spawn", "spawn");

/** Governed spawn stub (Spawn tier) */
export const GovernedSpawnStub = createTierStub("agents/governed-spawn", "ext-spawn", "spawn");

/** Browser stub (Hosted tier) */
export const BrowserStub = createTierStub("browser", "ext-hosted", "hosted");

/** Tracing stub (Hosted tier) */
export const TracingStub = createTierStub("tracing", "ext-hosted", "hosted");
