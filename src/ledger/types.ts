/**
 * Ledger types — append-only interaction log for entity relationships.
 *
 * The ledger records every meaningful interaction between the brain
 * and external entities (bonds, services, humans). Used for bond
 * distance calculation and relationship tracking.
 */

import { createHash } from "node:crypto";

/** Types of interactions recorded in the ledger. */
export type InteractionType =
  | "contact"   // Direct interaction (message, call, meeting)
  | "mention"   // Entity referenced without direct interaction
  | "share"     // Data shared via tunnel or export
  | "revoke";   // Trust reduction (bond muted/revoked, access removed)

/** A single interaction ledger entry recording a relationship event. */
export interface InteractionLedgerEntry {
  /** ISO 8601 timestamp of the interaction. */
  timestamp: string;
  /** The type of interaction. */
  type: InteractionType;
  /** Fingerprint or identifier of the entity interacted with. */
  entity: string;
  /** Human-readable summary of the interaction. */
  summary: string;
  /** Optional metadata (e.g., channel, vault fields shared). */
  meta?: Record<string, string>;
  /** Soft-delete marker. */
  status?: "active" | "archived";
}

/** Weights for each interaction type used in bond distance calculation. */
export const INTERACTION_WEIGHTS: Record<InteractionType, number> = {
  contact: 1.0,
  mention: 0.2,
  share: 0.5,
  revoke: -2.0,
};

/** Half-life in days for interaction decay. */
export const DECAY_HALF_LIFE_DAYS = 90;

// ── Vault Ledger Types ──────────────────────────────────────────────────────

/** Operations recorded in the vault ledger. */
export type VaultOperation =
  | "encrypt"    // Payload encrypted into vault
  | "decrypt"    // Payload decrypted for use
  | "rotate"     // Key rotation event
  | "share"      // Encrypted payload shared via tunnel
  | "revoke"     // Access to a vault entry revoked
  | "archive";   // Entry soft-deprecated

/** A tamper-evident vault ledger entry forming a hash chain. */
export interface VaultLedgerEntry {
  /** Unique entry identifier. */
  id: string;
  /** ISO 8601 timestamp. */
  timestamp: string;
  /** The vault operation performed. */
  operation: VaultOperation;
  /** Fingerprint or identifier of the entity involved. */
  entityId: string;
  /** SHA-256 hash of the encrypted vault payload. */
  contentHash: string;
  /** SHA-256 hash of the previous entry (empty string for genesis). */
  previousHash: string;
  /** Digital signature over the entry's canonical fields. */
  signature: string;
  /** Arbitrary metadata (channel, scope, etc.). */
  metadata: Record<string, string>;
  /** Soft-delete marker. */
  status?: "active" | "archived";
}

/** Merkle root persisted to brain/ledger/merkle-root.json. */
export interface MerkleRootRecord {
  /** SHA-256 Merkle root of all entry hashes. */
  root: string;
  /** Number of entries covered. */
  entryCount: number;
  /** ISO 8601 timestamp of computation. */
  computedAt: string;
}

// ── Core Vault Ledger Entry Structure ────────────────────────────────────────

/** Operations that can be recorded in the core vault ledger. */
export enum LedgerOperation {
  Add = "add",
  Modify = "modify",
  Delete = "delete",
  Access = "access",
  Grant = "grant",
  Revoke = "revoke",
  TagChange = "tag-change",
}

/** A single core vault ledger entry forming a hash-chained audit trail. */
export interface LedgerEntry {
  /** Unique entry identifier. */
  id: string;
  /** ISO 8601 timestamp of the operation. */
  timestamp: string;
  /** The ledger operation performed. */
  operation: LedgerOperation;
  /** Identifier of the entity this operation targets. */
  entityId: string;
  /** SHA-256 hash of the encrypted vault payload. */
  contentHash: string;
  /** SHA-256 hash of the previous entry (empty string for genesis). */
  previousHash: string;
  /** Digital signature over the entry's canonical fields. */
  signature: string;
  /** Arbitrary metadata (scope, channel, tags, etc.). */
  metadata: Record<string, string>;
}

/** Create a new LedgerEntry with a generated ID and current timestamp. */
export function createLedgerEntry(
  fields: Omit<LedgerEntry, "id" | "timestamp">,
): LedgerEntry {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return {
    id: `le_${ts}_${rand}`,
    timestamp: new Date().toISOString(),
    ...fields,
  };
}

/** Compute SHA-256 content hash over an encrypted vault payload. */
export function computeContentHash(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Compute the SHA-256 hash of a LedgerEntry for previousHash chain links. */
export function computeEntryHash(entry: LedgerEntry): string {
  const canonical = JSON.stringify({
    id: entry.id,
    timestamp: entry.timestamp,
    operation: entry.operation,
    entityId: entry.entityId,
    contentHash: entry.contentHash,
    previousHash: entry.previousHash,
    metadata: entry.metadata,
  });
  return createHash("sha256").update(canonical, "utf-8").digest("hex");
}

/** Bond distance result for a single entity. */
export interface BondDistance {
  /** Entity fingerprint or identifier. */
  entity: string;
  /** Distance from 0 (closest) to 1 (strangest). */
  distance: number;
  /** Total weighted interactions (before distance transform). */
  weightedScore: number;
  /** Number of raw interactions considered. */
  interactionCount: number;
  /** Most recent interaction timestamp. */
  lastInteraction: string | null;
}
