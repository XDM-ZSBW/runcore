/**
 * Ledger module — append-only interaction log and bond distance.
 */

export type {
  InteractionType,
  InteractionLedgerEntry,
  LedgerEntry,
  BondDistance,
  VaultOperation,
  VaultLedgerEntry,
  MerkleRootRecord,
} from "./types.js";

export {
  LedgerOperation,
  createLedgerEntry,
  computeContentHash,
  computeEntryHash,
  INTERACTION_WEIGHTS,
  DECAY_HALF_LIFE_DAYS,
} from "./types.js";

export {
  loadLedger,
  recordInteraction,
  getEntityInteractions,
  getInteractionsByType,
  getInteractionsInRange,
  listEntities,
  getAllEntries,
  getLastInteraction,
  countByEntity,
} from "./store.js";

export {
  computeBondDistance,
  computeAllDistances,
  getClosestEntities,
  getDriftingEntities,
} from "./distance.js";
