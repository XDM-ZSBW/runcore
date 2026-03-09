/**
 * Volume types — multi-volume brain storage with event-driven tiering.
 *
 * Three tiers: sphere (hot), warm, archive (cold).
 * No timers. Triggers are: on-write, on-connect, on-pressure, on-access, on-disconnect.
 */

export type VolumeTier = "sphere" | "warm" | "archive";

export interface VolumeConfig {
  name: string;
  path: string;
  tier: VolumeTier;
  /** Max bytes before pressure trigger fires. Default: 80% of volume. */
  pressureThresholdBytes?: number;
  /** If true, registry is replicated here (default true for all tiers). */
  replicateRegistry?: boolean;
}

export interface VolumeState {
  name: string;
  tier: VolumeTier;
  path: string;
  online: boolean;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  pressure: boolean;
  lastSeen: string;
}

/** A pending replication — file needs to be copied to a volume. */
export interface ReplicationEntry {
  fileId: string;
  checksum: string;
  sourceVolume: string;
  targetVolume: string;
  queuedAt: string;
  status: "pending" | "in-progress" | "done" | "failed";
  error?: string;
}

/** A migration — file moving from one tier to another. */
export interface MigrationEntry {
  fileId: string;
  fromVolume: string;
  toVolume: string;
  reason: "pressure" | "access-promote" | "lifecycle" | "manual";
  migratedAt: string;
}

/** Events that trigger volume operations. */
export type VolumeEvent =
  | { type: "write"; fileId: string; volume: string }
  | { type: "connect"; volume: string }
  | { type: "disconnect"; volume: string }
  | { type: "pressure"; volume: string; usedPct: number }
  | { type: "access"; fileId: string; volume: string };
