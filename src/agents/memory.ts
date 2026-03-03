/**
 * Writes agent task outcomes to episodic LTM (experiences.jsonl).
 * Memory entries are the durable control surface — notifications are ephemeral,
 * but these persist and are retrievable by future turns via Brain.retrieve().
 */

import { join } from "node:path";
import { FileSystemLongTermMemory } from "../memory/file-backed.js";
import type { AgentTask } from "./types.js";
import type { QueueTask } from "../queue/types.js";
import { createLogger } from "../utils/logger.js";
import { getEncryptionKey } from "../lib/key-store.js";
import { appendBrainLine, ensureBrainJsonl } from "../lib/brain-io.js";

const log = createLogger("agent-memory");

const MEMORY_DIR = join(process.cwd(), "brain", "memory");

// ─── Scar Registry ────────────────────────────────────────────────────────────

/** A self-repair proven by code, tests, and validation. */
export interface ScarRecord {
  id: string;
  /** Root-cause anchor: what broke and why. */
  anchor: string;
  /** One-line summary of the original wound/failure. */
  woundSummary: string;
  /** ISO timestamp when the fix was confirmed. */
  healedAt: string;
  /** The agent task ID that performed the fix. */
  agentId: string;
  /** Artifacts produced by the self-repair. */
  artifacts: {
    /** Measures added to prevent recurrence. */
    prevention: string[];
    /** Signals added to detect the issue earlier. */
    detection: string[];
    /** Code changes that corrected the defect. */
    correction: string[];
    /** Test files/cases that guard against regression. */
    regressionTests: string[];
  };
}

const SCARS_FILE = join(MEMORY_DIR, "scars.jsonl");
const SCARS_SCHEMA = JSON.stringify({
  _schema: "scar",
  _version: "1.0",
  _description: "Self-repairs proven by code + tests + validation. Append-only.",
});

function generateScarId(): string {
  return `scar_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

/** Append a scar record to brain/memory/scars.jsonl. */
export async function recordScar(
  record: Omit<ScarRecord, "id">,
): Promise<ScarRecord> {
  const full: ScarRecord = { id: generateScarId(), ...record };
  await ensureBrainJsonl(SCARS_FILE, SCARS_SCHEMA);
  await appendBrainLine(SCARS_FILE, JSON.stringify(full));
  log.info("Scar recorded", { id: full.id, anchor: full.anchor, agentId: full.agentId });
  return full;
}

/** Lazy LTM factory — picks up encryption key at call time, not import time. */
function getLtm(): FileSystemLongTermMemory {
  return new FileSystemLongTermMemory(MEMORY_DIR, getEncryptionKey() ?? undefined);
}

/** Write an episodic memory entry for an agent task outcome. */
export async function rememberTaskOutcome(
  task: AgentTask,
  output?: string,
): Promise<void> {
  const outputSnippet = output?.trim().slice(0, 500) || "";

  const lines = [
    `Agent task "${task.label}" ${task.status}.`,
    task.origin === "ai" ? "Triggered by AI." : "Triggered by user.",
    task.exitCode != null ? `Exit code: ${task.exitCode}.` : "",
    task.error ? `Error: ${task.error}` : "",
    outputSnippet ? `Result: ${outputSnippet}` : "",
  ].filter(Boolean);

  await getLtm().add({
    type: "episodic",
    content: lines.join(" "),
    meta: {
      source: "agent",
      taskId: task.id,
      status: task.status,
      label: task.label,
      origin: task.origin,
      ...(task.exitCode != null ? { exitCode: task.exitCode } : {}),
      ...(task.boardTaskId ? { boardTaskId: task.boardTaskId } : {}),
    },
  });
  log.info("Task outcome recorded", { taskId: task.id, label: task.label, status: task.status });
}

/** Write an episodic memory entry when a board/queue task reaches a terminal state. */
export async function rememberTaskCompletion(
  task: QueueTask,
  fromState: string,
): Promise<void> {
  const verb = task.state === "done" ? "completed" : "cancelled";
  const desc = task.description?.slice(0, 300) || "";

  // Build resolution trail from exchanges (agent comments, chat notes, etc.)
  const resolutionNotes = task.exchanges
    .map((ex) => `[${ex.author}] ${ex.body}`)
    .join(" → ");
  const trail = resolutionNotes ? resolutionNotes.slice(0, 600) : "";

  const lines = [
    `Task ${task.identifier} ${verb}: "${task.title}".`,
    task.project ? `Project: ${task.project}.` : "",
    `Transitioned from ${fromState}.`,
    desc ? `Details: ${desc}` : "",
    trail ? `Resolution trail: ${trail}` : "",
  ].filter(Boolean);

  await getLtm().add({
    type: "episodic",
    content: lines.join(" "),
    meta: {
      source: "task-bridge",
      taskId: task.id,
      identifier: task.identifier,
      project: task.project || "",
      state: task.state,
      fromState,
      exchangeCount: task.exchanges.length,
      ...(task.agentTaskId ? { agentTaskId: task.agentTaskId } : {}),
      ...(task.origin ? { origin: task.origin } : {}),
    },
  });
  log.info("Task completion recorded", { taskId: task.id, identifier: task.identifier, state: task.state });
}
