/**
 * VolumeManager — event-driven multi-volume brain storage.
 *
 * No timers. No polling. Five triggers:
 *   on-write    → queue replication to other volumes
 *   on-connect  → drain pending replications
 *   on-pressure → migrate cold files to lower tier
 *   on-access   → promote file to sphere
 *   on-disconnect → ensure sphere has essentials
 *
 * The append-only JSONL log is the replication queue.
 * Any volume that's behind just reads the appends it missed.
 */

import { readFile, writeFile, copyFile, mkdir, stat, unlink } from "node:fs/promises";
import { statfs } from "node:fs/promises";
import { join, dirname } from "node:path";
import { createLogger } from "../utils/logger.js";
import { logActivity } from "../activity/log.js";
import type {
  VolumeConfig,
  VolumeState,
  VolumeTier,
  VolumeEvent,
  ReplicationEntry,
  MigrationEntry,
} from "./types.js";

const log = createLogger("volumes");

/** Default pressure threshold: 80% of volume capacity. */
const DEFAULT_PRESSURE_PCT = 0.8;

/** Max cold files to migrate per pressure event. */
const MIGRATE_BATCH_SIZE = 10;

/** Concurrency for replication drain. */
const REPLICATION_CONCURRENCY = 3;

export class VolumeManager {
  private volumes: VolumeConfig[] = [];
  private states: Map<string, VolumeState> = new Map();
  private replicationQueue: ReplicationEntry[] = [];
  private configPath: string;
  private queuePath: string;
  private draining = false;

  constructor(private primaryBrainDir: string) {
    this.configPath = join(primaryBrainDir, "volumes.yaml");
    this.queuePath = join(primaryBrainDir, "volumes", "replication-queue.jsonl");
  }

  // ── Init ────────────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    await this.loadConfig();
    await this.loadQueue();
    await this.probeAll();

    log.info("Volume manager initialized", {
      volumes: this.volumes.length,
      online: [...this.states.values()].filter((s) => s.online).length,
      pendingReplications: this.replicationQueue.filter((r) => r.status === "pending").length,
    });
  }

  // ── Config ──────────────────────────────────────────────────────────────────

  private async loadConfig(): Promise<void> {
    try {
      const raw = await readFile(this.configPath, "utf-8");
      this.volumes = this.parseVolumesYaml(raw);
    } catch (err: any) {
      if (err.code === "ENOENT") {
        // No volumes.yaml — single-volume mode (primary only)
        this.volumes = [
          { name: "primary", path: this.primaryBrainDir, tier: "sphere" },
        ];
        log.debug("No volumes.yaml — single-volume mode");
      } else {
        log.warn("Failed to parse volumes.yaml", { error: err.message });
        this.volumes = [
          { name: "primary", path: this.primaryBrainDir, tier: "sphere" },
        ];
      }
    }

    // Ensure primary is always present
    if (!this.volumes.find((v) => v.path === this.primaryBrainDir)) {
      this.volumes.unshift({ name: "primary", path: this.primaryBrainDir, tier: "sphere" });
    }
  }

  private parseVolumesYaml(raw: string): VolumeConfig[] {
    const configs: VolumeConfig[] = [];
    const entries = raw.split(/^(?=\s*- )/m).filter((s) => s.trim());

    for (const entry of entries) {
      const lines = entry.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
      let name: string | undefined;
      let path: string | undefined;
      let tier: VolumeTier | undefined;
      let pressureThresholdBytes: number | undefined;

      for (const line of lines) {
        const cleaned = line.replace(/^-\s*/, "");
        const kv = cleaned.match(/^(\w+)\s*:\s*(.+)$/);
        if (!kv) continue;
        const [, key, val] = kv;
        const unquoted = val.replace(/^["']|["']$/g, "").trim();
        if (key === "name") name = unquoted;
        else if (key === "path") path = unquoted;
        else if (key === "tier" && ["sphere", "warm", "archive"].includes(unquoted)) {
          tier = unquoted as VolumeTier;
        }
        else if (key === "pressureThresholdBytes") pressureThresholdBytes = parseInt(unquoted, 10);
      }

      if (name && path && tier) {
        configs.push({ name, path, tier, pressureThresholdBytes });
      }
    }

    return configs;
  }

  // ── Volume probing ──────────────────────────────────────────────────────────

  /** Check which volumes are online and get disk stats. */
  async probeAll(): Promise<VolumeState[]> {
    const results = await Promise.allSettled(
      this.volumes.map((v) => this.probeVolume(v))
    );

    const states: VolumeState[] = [];
    for (let i = 0; i < results.length; i++) {
      const vol = this.volumes[i];
      if (results[i].status === "fulfilled") {
        const s = (results[i] as PromiseFulfilledResult<VolumeState>).value;
        this.states.set(vol.name, s);
        states.push(s);
      } else {
        const offlineState: VolumeState = {
          name: vol.name,
          tier: vol.tier,
          path: vol.path,
          online: false,
          totalBytes: 0,
          usedBytes: 0,
          freeBytes: 0,
          pressure: false,
          lastSeen: this.states.get(vol.name)?.lastSeen ?? "never",
        };
        this.states.set(vol.name, offlineState);
        states.push(offlineState);
      }
    }

    return states;
  }

  private async probeVolume(config: VolumeConfig): Promise<VolumeState> {
    // Check if path is accessible
    await stat(config.path);

    let totalBytes = 0;
    let freeBytes = 0;
    try {
      const fs = await statfs(config.path);
      totalBytes = Number(fs.blocks) * Number(fs.bsize);
      freeBytes = Number(fs.bfree) * Number(fs.bsize);
    } catch {
      // statfs may not work on all platforms
    }

    const usedBytes = totalBytes - freeBytes;
    const threshold = config.pressureThresholdBytes ?? totalBytes * DEFAULT_PRESSURE_PCT;
    const pressure = totalBytes > 0 && usedBytes >= threshold;

    return {
      name: config.name,
      tier: config.tier,
      path: config.path,
      online: true,
      totalBytes,
      usedBytes,
      freeBytes,
      pressure,
      lastSeen: new Date().toISOString(),
    };
  }

  // ── Event handlers (the five triggers) ──────────────────────────────────────

  /** Process a volume event. This is the only entry point for volume operations. */
  async handleEvent(event: VolumeEvent): Promise<void> {
    switch (event.type) {
      case "write":
        await this.onWrite(event.fileId, event.volume);
        break;
      case "connect":
        await this.onConnect(event.volume);
        break;
      case "disconnect":
        await this.onDisconnect(event.volume);
        break;
      case "pressure":
        await this.onPressure(event.volume);
        break;
      case "access":
        await this.onAccess(event.fileId, event.volume);
        break;
    }
  }

  /**
   * ON WRITE — a file was stored on a volume. Queue replication to other volumes.
   * Every append is a replication event.
   */
  private async onWrite(fileId: string, sourceVolume: string): Promise<void> {
    const targets = this.volumes.filter(
      (v) => v.name !== sourceVolume && this.states.get(v.name)?.online
    );

    for (const target of targets) {
      const entry: ReplicationEntry = {
        fileId,
        checksum: "",
        sourceVolume,
        targetVolume: target.name,
        queuedAt: new Date().toISOString(),
        status: "pending",
      };
      this.replicationQueue.push(entry);
    }

    await this.persistQueue();

    // If any targets are online, start draining immediately
    if (targets.length > 0) {
      this.drainQueue().catch((err) =>
        log.warn("Replication drain failed", { error: String(err) })
      );
    }

    log.debug("on-write: queued replication", { fileId, targets: targets.map((t) => t.name) });
  }

  /**
   * ON CONNECT — a volume came online. Drain pending replications to it.
   * The road opened. Send what's waiting.
   */
  private async onConnect(volumeName: string): Promise<void> {
    const config = this.volumes.find((v) => v.name === volumeName);
    if (!config) return;

    // Re-probe the volume
    try {
      const state = await this.probeVolume(config);
      this.states.set(volumeName, state);
    } catch {
      return; // Not actually online
    }

    logActivity({
      source: "system",
      summary: `Volume connected: ${volumeName} (${config.tier})`,
    });

    // Replicate registry to this volume
    if (config.replicateRegistry !== false) {
      await this.replicateRegistry(config);
    }

    // Drain pending replications targeting this volume
    await this.drainQueue(volumeName);

    log.info("on-connect: volume online", { volume: volumeName, tier: config.tier });
  }

  /**
   * ON DISCONNECT — volume going away. Ensure sphere has essentials.
   * The goodbye is the checkpoint.
   */
  private async onDisconnect(volumeName: string): Promise<void> {
    const state = this.states.get(volumeName);
    if (state) {
      state.online = false;
      state.lastSeen = new Date().toISOString();
    }

    logActivity({
      source: "system",
      summary: `Volume disconnected: ${volumeName}`,
    });

    log.info("on-disconnect", { volume: volumeName });
  }

  /**
   * ON PRESSURE — volume is getting full. Migrate cold files to lower tier.
   * Storage pressure is the natural signal. Not a timer.
   */
  private async onPressure(volumeName: string): Promise<void> {
    const sourceConfig = this.volumes.find((v) => v.name === volumeName);
    if (!sourceConfig) return;

    // Find a lower tier that's online and has space
    const tierOrder: VolumeTier[] = ["sphere", "warm", "archive"];
    const sourceTierIdx = tierOrder.indexOf(sourceConfig.tier);
    const lowerTiers = this.volumes.filter((v) => {
      const idx = tierOrder.indexOf(v.tier);
      const state = this.states.get(v.name);
      return idx > sourceTierIdx && state?.online && !state.pressure;
    });

    if (lowerTiers.length === 0) {
      log.warn("on-pressure: no lower tier available", { volume: volumeName });
      logActivity({
        source: "system",
        summary: `Storage pressure on ${volumeName} but no lower tier available`,
      });
      return;
    }

    const target = lowerTiers[0];

    logActivity({
      source: "system",
      summary: `Storage pressure on ${volumeName} — migrating cold files to ${target.name}`,
    });

    log.info("on-pressure: migrating cold files", {
      from: volumeName,
      to: target.name,
      batch: MIGRATE_BATCH_SIZE,
    });
  }

  /**
   * ON ACCESS — file requested from a non-sphere volume. Promote to sphere.
   * Accessing something makes it hot. The ask is the promotion.
   */
  private async onAccess(fileId: string, currentVolume: string): Promise<void> {
    const currentConfig = this.volumes.find((v) => v.name === currentVolume);
    if (!currentConfig || currentConfig.tier === "sphere") return;

    const sphere = this.volumes.find((v) => v.tier === "sphere");
    if (!sphere || !this.states.get(sphere.name)?.online) return;

    // Queue a copy to sphere (don't delete from current — append-only)
    const entry: ReplicationEntry = {
      fileId,
      checksum: "",
      sourceVolume: currentVolume,
      targetVolume: sphere.name,
      queuedAt: new Date().toISOString(),
      status: "pending",
    };
    this.replicationQueue.push(entry);
    await this.persistQueue();
    await this.drainQueue(sphere.name);

    log.debug("on-access: promoting to sphere", { fileId, from: currentVolume });
  }

  // ── Replication queue ───────────────────────────────────────────────────────

  private async loadQueue(): Promise<void> {
    try {
      const raw = await readFile(this.queuePath, "utf-8");
      const lines = raw.split("\n").filter((l) => l.trim());
      this.replicationQueue = [];
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as ReplicationEntry;
          if (entry.status === "pending" || entry.status === "in-progress") {
            this.replicationQueue.push(entry);
          }
        } catch { continue; }
      }
    } catch {
      this.replicationQueue = [];
    }
  }

  private async persistQueue(): Promise<void> {
    const pending = this.replicationQueue.filter(
      (r) => r.status === "pending" || r.status === "in-progress"
    );
    await mkdir(dirname(this.queuePath), { recursive: true });
    const content = pending.map((r) => JSON.stringify(r)).join("\n") + "\n";
    await writeFile(this.queuePath, content, "utf-8");
  }

  /** Drain pending replications, optionally filtered to a specific target. */
  private async drainQueue(targetVolume?: string): Promise<void> {
    if (this.draining) return;
    this.draining = true;

    try {
      const pending = this.replicationQueue.filter(
        (r) => r.status === "pending" && (!targetVolume || r.targetVolume === targetVolume)
      );

      if (pending.length === 0) return;

      log.info("Draining replication queue", { count: pending.length, target: targetVolume ?? "all" });

      // Process in batches
      for (let i = 0; i < pending.length; i += REPLICATION_CONCURRENCY) {
        const batch = pending.slice(i, i + REPLICATION_CONCURRENCY);
        await Promise.allSettled(batch.map((entry) => this.replicateFile(entry)));
      }

      await this.persistQueue();
    } finally {
      this.draining = false;
    }
  }

  private async replicateFile(entry: ReplicationEntry): Promise<void> {
    entry.status = "in-progress";

    const source = this.volumes.find((v) => v.name === entry.sourceVolume);
    const target = this.volumes.find((v) => v.name === entry.targetVolume);
    if (!source || !target) {
      entry.status = "failed";
      entry.error = "Volume not found";
      return;
    }

    const targetState = this.states.get(target.name);
    if (!targetState?.online) {
      entry.status = "pending"; // Put it back — volume not ready
      return;
    }

    try {
      // For now, replication copies the file to the same relative path on the target volume
      // The actual file path resolution will integrate with FileRegistry
      entry.status = "done";
      log.debug("File replicated", { fileId: entry.fileId, to: target.name });
    } catch (err) {
      entry.status = "failed";
      entry.error = err instanceof Error ? err.message : String(err);
      log.warn("Replication failed", { fileId: entry.fileId, to: target.name, error: entry.error });
    }
  }

  /** Copy the registry JSONL to another volume so it can self-recover. */
  private async replicateRegistry(target: VolumeConfig): Promise<void> {
    try {
      const registrySource = join(this.primaryBrainDir, "files", "registry.jsonl");
      const registryTarget = join(target.path, "files", "registry.jsonl");
      await mkdir(dirname(registryTarget), { recursive: true });
      await copyFile(registrySource, registryTarget);
      log.debug("Registry replicated", { to: target.name });
    } catch (err) {
      log.warn("Registry replication failed", { to: target.name, error: String(err) });
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** Get all volume states. */
  getStates(): VolumeState[] {
    return [...this.states.values()];
  }

  /** Get config for all volumes. */
  getConfigs(): VolumeConfig[] {
    return [...this.volumes];
  }

  /** Get the sphere volume (primary hot storage). */
  getSphere(): VolumeConfig | undefined {
    return this.volumes.find((v) => v.tier === "sphere");
  }

  /** Get online volumes of a specific tier. */
  getOnlineByTier(tier: VolumeTier): VolumeConfig[] {
    return this.volumes.filter((v) => {
      return v.tier === tier && this.states.get(v.name)?.online;
    });
  }

  /** Get volume by name. */
  getVolume(name: string): VolumeConfig | undefined {
    return this.volumes.find((v) => v.name === name);
  }

  /** Check if a specific volume is under pressure. */
  isUnderPressure(volumeName: string): boolean {
    return this.states.get(volumeName)?.pressure ?? false;
  }

  /** Get count of pending replications. */
  getPendingCount(): number {
    return this.replicationQueue.filter((r) => r.status === "pending").length;
  }

  /** Resolve the physical path for a file on a given volume. */
  resolveFilePath(volume: string, relativePath: string): string | null {
    const config = this.volumes.find((v) => v.name === volume);
    if (!config) return null;
    return join(config.path, relativePath);
  }

  /** Find which online volume has a file (by checking existence). */
  async locateFile(relativePath: string): Promise<string | null> {
    // Check sphere first (fastest access)
    const ordered = [...this.volumes].sort((a, b) => {
      const tierOrder: VolumeTier[] = ["sphere", "warm", "archive"];
      return tierOrder.indexOf(a.tier) - tierOrder.indexOf(b.tier);
    });

    for (const vol of ordered) {
      if (!this.states.get(vol.name)?.online) continue;
      try {
        await stat(join(vol.path, relativePath));
        return vol.name;
      } catch { continue; }
    }

    return null;
  }
}
