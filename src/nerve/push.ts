/**
 * Web Push — sends notifications to nerve endings (phone, browser, etc.)
 *
 * VAPID keys generated on first run and stored in brain/identity/.
 * Subscriptions stored in brain/memory/push-subscriptions.jsonl.
 * Stateless: any instance can send to any subscribed nerve.
 */

import webPush from "web-push";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { readBrainLines, appendBrainLine, ensureBrainJsonl } from "../lib/brain-io.js";
import { createLogger } from "../utils/logger.js";
import type { NerveState, DotColor } from "./state.js";

const log = createLogger("nerve-push");
import { BRAIN_DIR } from "../lib/paths.js";
const KEYS_PATH = join(BRAIN_DIR, "identity", ".vapid-keys.json");
const SUBS_PATH = join(BRAIN_DIR, "memory", "push-subscriptions.jsonl");

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

interface PushSubscriptionRecord {
  id: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  createdAt: string;
  label?: string;
}

let vapidKeys: VapidKeys | null = null;

/** Initialize VAPID keys — generate on first run, load on subsequent. */
export async function initPush(): Promise<string> {
  if (existsSync(KEYS_PATH)) {
    const raw = await readFile(KEYS_PATH, "utf-8");
    vapidKeys = JSON.parse(raw);
  } else {
    const keys = webPush.generateVAPIDKeys();
    vapidKeys = { publicKey: keys.publicKey, privateKey: keys.privateKey };
    await mkdir(join(BRAIN_DIR, "identity"), { recursive: true });
    await writeFile(KEYS_PATH, JSON.stringify(vapidKeys, null, 2), "utf-8");
    log.info("Generated new VAPID keys");
  }

  webPush.setVapidDetails(
    "mailto:hello@herrmangroup.com",
    vapidKeys!.publicKey,
    vapidKeys!.privateKey
  );

  await ensureBrainJsonl(SUBS_PATH, JSON.stringify({ _schema: "push-subscriptions", _version: "1.0" }));
  log.info("Push notifications initialized");
  return vapidKeys!.publicKey;
}

/** Get the VAPID public key (needed by clients to subscribe). */
export function getVapidPublicKey(): string {
  if (!vapidKeys) throw new Error("Push not initialized");
  return vapidKeys.publicKey;
}

/** Store a push subscription from a nerve endpoint. */
export async function addSubscription(
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  label?: string
): Promise<string> {
  const id = `push_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const record: PushSubscriptionRecord = {
    id,
    endpoint: subscription.endpoint,
    keys: subscription.keys,
    createdAt: new Date().toISOString(),
    label,
  };
  await appendBrainLine(SUBS_PATH, JSON.stringify(record));
  log.info(`Push subscription added: ${id}${label ? ` (${label})` : ""}`);
  return id;
}

/** Load all active subscriptions. */
async function loadSubscriptions(): Promise<PushSubscriptionRecord[]> {
  const lines = await readBrainLines(SUBS_PATH);
  const subs: PushSubscriptionRecord[] = [];
  const removed = new Set<string>();

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj._schema) continue;
      if (obj.status === "removed" && obj.id) { removed.add(obj.id); continue; }
      if (obj.id && obj.endpoint) subs.push(obj);
    } catch { continue; }
  }

  return subs.filter(s => !removed.has(s.id));
}

/** Remove a dead subscription (append-only). */
async function removeSubscription(id: string): Promise<void> {
  await appendBrainLine(SUBS_PATH, JSON.stringify({ id, status: "removed", removedAt: new Date().toISOString() }));
}

/** Send a push notification to all subscribed nerve endings. */
export async function pushToAll(title: string, body: string, data?: Record<string, unknown>): Promise<number> {
  const subs = await loadSubscriptions();
  let sent = 0;

  for (const sub of subs) {
    const pushSub = {
      endpoint: sub.endpoint,
      keys: sub.keys,
    };

    try {
      await webPush.sendNotification(pushSub, JSON.stringify({
        title,
        body,
        data: { ...data, timestamp: new Date().toISOString() },
      }));
      sent++;
    } catch (err: any) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        // Subscription expired or invalid — remove it
        await removeSubscription(sub.id);
        log.info(`Removed expired subscription: ${sub.id}`);
      } else {
        log.warn(`Push failed for ${sub.id}: ${err.message}`);
      }
    }
  }

  return sent;
}

/** Map nerve state to push notification when dots change. */
let lastState: { sense: DotColor; work: DotColor; joy: DotColor } | null = null;

export async function checkAndNotify(state: NerveState): Promise<void> {
  const current = {
    sense: state.sense.color,
    work: state.work.color,
    joy: state.joy.color,
  };

  if (!lastState) {
    lastState = current;
    return;
  }

  // Only notify on transitions TO amber
  const transitions: string[] = [];

  if (current.sense === "amber" && lastState.sense !== "amber") {
    transitions.push(`Sense: ${state.sense.label} — ${state.sense.detail}`);
  }
  if (current.work === "amber" && lastState.work !== "amber") {
    transitions.push(`Work: ${state.work.label} — ${state.work.detail}`);
  }
  if (current.joy === "amber" && lastState.joy !== "amber") {
    transitions.push(`Joy: ${state.joy.label} — ${state.joy.detail}`);
  }

  lastState = current;

  if (transitions.length > 0) {
    const body = transitions.join("\n");
    await pushToAll("Attention", body, { state: current });
  }
}

// ── Background push monitor ─────────────────────────────────────────────────
// Runs server-side on a timer, independent of any client connection.
// This is what makes push work when the phone is in your pocket.

let monitorInterval: ReturnType<typeof setInterval> | null = null;

export function startPushMonitor(
  getState: () => Promise<NerveState>,
  intervalMs = 30_000
): void {
  if (monitorInterval) return;

  monitorInterval = setInterval(async () => {
    try {
      const state = await getState();
      await checkAndNotify(state);
    } catch (err) {
      log.warn("Push monitor tick failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, intervalMs);

  log.info(`Push monitor started: checking every ${intervalMs / 1000}s`);
}

export function stopPushMonitor(): void {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
    log.info("Push monitor stopped");
  }
}
