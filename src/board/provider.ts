/**
 * Board provider registry.
 * Holds the active provider and exposes it to server routes / chat commands.
 * Providers register themselves at startup; only one is active at a time.
 */

import type { BoardProvider } from "./types.js";

let activeProvider: BoardProvider | null = null;

/** Set the active board provider (called at startup). */
export function setBoardProvider(provider: BoardProvider): void {
  activeProvider = provider;
}

/** Get the active board provider, or null if none registered. */
export function getBoardProvider(): BoardProvider | null {
  return activeProvider;
}

/** Convenience: is any board provider available and configured? */
export function isBoardAvailable(): boolean {
  return activeProvider !== null && activeProvider.isAvailable();
}
