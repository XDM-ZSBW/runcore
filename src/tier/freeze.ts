/**
 * Freeze — dormant mode for agents.
 *
 * When a freeze signal arrives (via heartbeat or local endpoint):
 * 1. All agents go dormant (mid-task, mid-token — frozen, not killed)
 * 2. Metabolic pulses pause
 * 3. No new work starts
 * 4. State is preserved for triage
 *
 * The operator then reviews the frozen field and selectively resumes.
 */

import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { FreezeSignal } from "./types.js";

let frozenState: FreezeSignal | null = null;
let freezeListeners: Array<(signal: FreezeSignal) => void> = [];
let thawListeners: Array<() => void> = [];

export function isFrozen(): boolean {
  return frozenState !== null;
}

export function getFreezeSignal(): FreezeSignal | null {
  return frozenState;
}

export function onFreeze(listener: (signal: FreezeSignal) => void): void {
  freezeListeners.push(listener);
}

export function onThaw(listener: () => void): void {
  thawListeners.push(listener);
}

/** Freeze all agents. Called by heartbeat handler or local /api/freeze endpoint. */
export async function freeze(signal: FreezeSignal, root: string): Promise<void> {
  frozenState = signal;

  // Log the freeze event
  const entry = JSON.stringify({
    type: "freeze",
    ...signal,
    frozenAt: new Date().toISOString(),
  });
  await appendFile(
    join(root, "brain", "ops", "audit.jsonl"),
    entry + "\n"
  ).catch(() => {});

  // Notify all listeners (agent pool, metabolic pulse, work queue)
  for (const listener of freezeListeners) {
    try {
      listener(signal);
    } catch {
      // Don't let a listener failure prevent freeze
    }
  }

  console.log(`\n  FROZEN — ${signal.reason}`);
  console.log(`  Issued by: ${signal.issuedBy} at ${signal.issuedAt}`);
  console.log(`  All agents dormant. Awaiting operator triage.\n`);
}

/** Thaw — resume operations after operator review. */
export async function thaw(root: string): Promise<void> {
  if (!frozenState) return;

  const entry = JSON.stringify({
    type: "thaw",
    previousFreeze: frozenState.jti,
    thawedAt: new Date().toISOString(),
  });
  await appendFile(
    join(root, "brain", "ops", "audit.jsonl"),
    entry + "\n"
  ).catch(() => {});

  frozenState = null;

  for (const listener of thawListeners) {
    try {
      listener();
    } catch {
      // Don't let a listener failure prevent thaw
    }
  }

  console.log("  THAWED — operations resuming.\n");
}
