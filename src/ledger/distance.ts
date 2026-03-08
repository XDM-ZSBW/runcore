/**
 * Bond distance calculation from ledger entries.
 *
 * Distance quantifies relationship strength: 0 = closest, 1 = strangest.
 * Uses exponential decay so recent interactions matter more than old ones.
 *
 * Formula: distance = 1 / (1 + weightedInteractions)
 * Each interaction is weighted by type and decayed by age.
 */

import type { InteractionLedgerEntry, BondDistance } from "./types.js";
import { INTERACTION_WEIGHTS, DECAY_HALF_LIFE_DAYS } from "./types.js";
import { getEntityInteractions, listEntities } from "./store.js";

const MS_PER_DAY = 86_400_000;

/** Compute exponential decay factor for an interaction's age. */
function decayFactor(interactionDate: Date, now: Date): number {
  const daysSince = (now.getTime() - interactionDate.getTime()) / MS_PER_DAY;
  if (daysSince < 0) return 1; // future-dated entries get full weight
  return Math.exp((-daysSince * Math.LN2) / DECAY_HALF_LIFE_DAYS);
}

/** Compute weighted score for a set of ledger entries. */
function computeWeightedScore(entries: InteractionLedgerEntry[], now: Date): number {
  let score = 0;
  for (const entry of entries) {
    const weight = INTERACTION_WEIGHTS[entry.type] ?? 0;
    const decay = decayFactor(new Date(entry.timestamp), now);
    score += weight * decay;
  }
  return score;
}

/** Calculate bond distance for a single entity. */
export async function computeBondDistance(
  entity: string,
  now?: Date,
): Promise<BondDistance> {
  const referenceTime = now ?? new Date();
  const interactions = await getEntityInteractions(entity);

  if (interactions.length === 0) {
    return {
      entity,
      distance: 1.0,
      weightedScore: 0,
      interactionCount: 0,
      lastInteraction: null,
    };
  }

  const weightedScore = computeWeightedScore(interactions, referenceTime);
  const distance = 1 / (1 + Math.max(0, weightedScore));
  const lastEntry = interactions[interactions.length - 1]!;

  return {
    entity,
    distance: Math.min(1, Math.max(0, distance)),
    weightedScore,
    interactionCount: interactions.length,
    lastInteraction: lastEntry.timestamp,
  };
}

/** Calculate bond distance for all known entities. Sorted by distance (closest first). */
export async function computeAllDistances(
  now?: Date,
): Promise<BondDistance[]> {
  const entities = await listEntities();
  const distances = await Promise.all(
    entities.map((entity) => computeBondDistance(entity, now)),
  );
  return distances.sort((a, b) => a.distance - b.distance);
}

/** Get the N closest entities by bond distance. */
export async function getClosestEntities(
  n: number,
  now?: Date,
): Promise<BondDistance[]> {
  const all = await computeAllDistances(now);
  return all.slice(0, n);
}

/** Get entities beyond a distance threshold (drifting relationships). */
export async function getDriftingEntities(
  threshold: number,
  now?: Date,
): Promise<BondDistance[]> {
  const all = await computeAllDistances(now);
  return all.filter((d) => d.distance > threshold);
}
