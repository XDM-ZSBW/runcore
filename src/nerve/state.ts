/**
 * Nerve State — translates raw system internals into three-dot field.
 *
 * Three dots: Sense, Work, Joy.
 * Three colors: blue (calm), green (moving), amber (attention).
 * No identities. No agent names. Just aggregate state.
 *
 * The public API is a feeling.
 */

import { getPressureIntegrator } from "../pulse/pressure.js";
import { getBoardProvider } from "../board/provider.js";
import { listTasks as listAgentTasks } from "../agents/index.js";
import { readBrainLines } from "../lib/brain-io.js";
import { join, resolve } from "node:path";

const BRAIN_DIR = resolve(process.cwd(), "brain");

// Pending major update — set by auto-updater, read by Sense dot
let pendingUpdate: { current: string; latest: string } | null = null;

export function setPendingUpdate(info: { current: string; latest: string }): void {
  pendingUpdate = info;
}

export function clearPendingUpdate(): void {
  pendingUpdate = null;
}

export type DotColor = "blue" | "green" | "amber";

export interface DotState {
  color: DotColor;
  label: string;
  detail: string;
  items: DrilldownItem[];
}

export interface DrilldownItem {
  text: string;
  age?: string;
  type: "info" | "active" | "attention";
}

export interface NerveState {
  sense: DotState;
  work: DotState;
  joy: DotState;
  timestamp: string;
}

function ago(ms: number): string {
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

/** Read open loops from crystallizer JSONL. */
async function getOpenLoops(): Promise<{ open: number; precipitated: number; items: any[] }> {
  try {
    const lines = await readBrainLines(join(BRAIN_DIR, "memory", "open-loops.jsonl"));
    const loopMap = new Map<string, any>();
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj._schema) continue;
        if (obj.id) loopMap.set(obj.id, obj);
      } catch { continue; }
    }
    const loops = Array.from(loopMap.values());
    return {
      open: loops.filter((l: any) => l.status === "open").length,
      precipitated: loops.filter((l: any) => l.status === "precipitated").length,
      items: loops.filter((l: any) => l.status === "open" || l.status === "precipitated"),
    };
  } catch {
    return { open: 0, precipitated: 0, items: [] };
  }
}

/** Read recent notifications. */
async function getRecentNotifications(): Promise<{ count: number; items: any[] }> {
  try {
    const lines = await readBrainLines(join(BRAIN_DIR, "operations", "notifications.jsonl"));
    const cutoff = Date.now() - 24 * 60 * 60 * 1000; // last 24h
    const recent: any[] = [];
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj._schema) continue;
        if (obj.timestamp && new Date(obj.timestamp).getTime() > cutoff) {
          recent.push(obj);
        }
      } catch { continue; }
    }
    return { count: recent.length, items: recent.slice(-10).reverse() };
  } catch {
    return { count: 0, items: [] };
  }
}

/** Compute Sense dot — what the system is perceiving. */
async function computeSense(): Promise<DotState> {
  const integrator = getPressureIntegrator();
  const loops = await getOpenLoops();
  const notifs = await getRecentNotifications();
  const items: DrilldownItem[] = [];

  // Voltage state
  let voltageColor: DotColor = "blue";
  let voltageLabel = "Quiet";
  if (integrator) {
    const status = integrator.getStatus();
    if (status.voltage > status.threshold * 0.7) {
      voltageColor = "amber";
      voltageLabel = "Pressure building";
      items.push({ text: `Voltage: ${Math.round(status.voltage)}/${status.threshold}mV`, type: "attention" });
    } else if (status.voltage > status.threshold * 0.3) {
      voltageColor = "green";
      voltageLabel = "Active";
      items.push({ text: `Voltage: ${Math.round(status.voltage)}/${status.threshold}mV`, type: "active" });
    }
  }

  // Precipitated loops = amber
  if (loops.precipitated > 0) {
    voltageColor = "amber";
    voltageLabel = "Something crystallized";
    for (const l of loops.items.filter((l: any) => l.status === "precipitated")) {
      items.push({ text: `Precipitated: "${l.query}"`, type: "attention" });
    }
  }

  // Open loops
  if (loops.open > 0) {
    items.push({ text: `${loops.open} open loop${loops.open !== 1 ? "s" : ""} filtering`, type: "info" });
    for (const l of loops.items.filter((l: any) => l.status === "open").slice(0, 3)) {
      const evidence = l.evidence?.length ?? 0;
      items.push({ text: `"${l.query}" — ${evidence}/${l.threshold} evidence`, type: "active" });
    }
  }

  // Pending major update
  if (pendingUpdate) {
    voltageColor = "amber";
    voltageLabel = "Update available";
    items.push({ text: `Core ${pendingUpdate.latest} available (UI changes)`, type: "attention" });
  }

  // Recent notifications
  if (notifs.count > 0) {
    items.push({ text: `${notifs.count} notification${notifs.count !== 1 ? "s" : ""} in last 24h`, type: "info" });
  }

  const detail = items.length === 0
    ? "Nothing to report"
    : items.filter(i => i.type !== "info").map(i => i.text).join(". ") || `${loops.open} loops, ${notifs.count} notifications`;

  return {
    color: voltageColor,
    label: voltageLabel,
    detail,
    items,
  };
}

/** Compute Work dot — what's in motion. */
async function computeWork(): Promise<DotState> {
  const items: DrilldownItem[] = [];
  let color: DotColor = "blue";
  let label = "Idle";

  // Agent tasks
  try {
    const tasks = await listAgentTasks();
    const running = tasks.filter((t: any) => t.status === "running");
    const queued = tasks.filter((t: any) => t.status === "queued");
    const failed = tasks.filter((t: any) => t.status === "failed");
    const completed = tasks.filter((t: any) => t.status === "completed");

    if (running.length > 0) {
      color = "green";
      label = "Working";
      items.push({ text: `${running.length} agent${running.length !== 1 ? "s" : ""} running`, type: "active" });
    }
    if (queued.length > 0) {
      items.push({ text: `${queued.length} queued`, type: "info" });
    }
    if (failed.length > 0) {
      color = "amber";
      label = "Needs attention";
      items.push({ text: `${failed.length} failed`, type: "attention" });
    }
    if (completed.length > 0) {
      items.push({ text: `${completed.length} completed`, type: "info" });
    }
  } catch { /* agents not initialized */ }

  // Board items
  try {
    const board = getBoardProvider();
    if (board) {
      const issues = await board.listIssues() ?? [];
      const todo = issues.filter((i: any) => i.state === "todo" || i.state === "open");
      const inProgress = issues.filter((i: any) => i.state === "in_progress" || i.state === "doing");

      if (inProgress.length > 0) {
        if (color === "blue") { color = "green"; label = "In progress"; }
        items.push({ text: `${inProgress.length} board item${inProgress.length !== 1 ? "s" : ""} in progress`, type: "active" });
      }
      if (todo.length > 0) {
        items.push({ text: `${todo.length} in backlog`, type: "info" });
      }
    }
  } catch { /* board not available */ }

  const detail = items.length === 0
    ? "Nothing in motion"
    : items.filter(i => i.type !== "info").map(i => i.text).join(". ") || "Quiet";

  return { color, label, detail, items };
}

/** Compute Joy dot — how outcomes feel. */
async function computeJoy(): Promise<DotState> {
  const items: DrilldownItem[] = [];
  let color: DotColor = "blue";
  let label = "Steady";

  // Check for precipitated loops (crystallized answers = joy)
  const loops = await getOpenLoops();
  if (loops.precipitated > 0) {
    color = "green";
    label = "Discovery";
    items.push({ text: `${loops.precipitated} question${loops.precipitated !== 1 ? "s" : ""} answered themselves`, type: "active" });
  }

  // Recent completions
  try {
    const tasks = await listAgentTasks();
    const now = Date.now();
    const recentCompleted = tasks.filter((t: any) => {
      if (t.status !== "completed") return false;
      const completedAt = t.completedAt ? new Date(t.completedAt).getTime() : 0;
      return now - completedAt < 3_600_000; // last hour
    });
    if (recentCompleted.length > 0) {
      if (color === "blue") { color = "green"; label = "Productive"; }
      items.push({ text: `${recentCompleted.length} task${recentCompleted.length !== 1 ? "s" : ""} completed this hour`, type: "active" });
    }
  } catch { /* agents not initialized */ }

  // Check for notifications needing human input
  const notifs = await getRecentNotifications();
  const needsHuman = notifs.items.filter((n: any) =>
    n.message?.includes("NEEDS_HUMAN") || n.message?.includes("needs your input")
  );
  if (needsHuman.length > 0) {
    color = "amber";
    label = "Waiting on you";
    items.push({ text: `${needsHuman.length} item${needsHuman.length !== 1 ? "s" : ""} waiting for your input`, type: "attention" });
  }

  const detail = items.length === 0
    ? "All good"
    : items.map(i => i.text).join(". ");

  return { color, label, detail, items };
}

/** Get the full nerve state — three dots of field. */
export async function getNerveState(): Promise<NerveState> {
  const [sense, work, joy] = await Promise.all([
    computeSense(),
    computeWork(),
    computeJoy(),
  ]);

  return {
    sense,
    work,
    joy,
    timestamp: new Date().toISOString(),
  };
}
