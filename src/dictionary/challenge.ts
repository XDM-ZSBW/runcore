/**
 * Dictionary Protocol — Challenge mechanism.
 *
 * Instances can challenge dictionary entries by emitting structured signals.
 * Challenges carry the target spec, evidence, proposed change, and confidence.
 *
 * Portable: signal emission is injectable via SignalEmitter interface
 * instead of importing a specific compost module.
 */

import { readFile, appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { createLogger } from "../utils/logger.js";

const log = createLogger("dictionary:challenge");

// ── Signal emitter (injectable) ────────────────────────────────────────────

/** Minimal signal result returned by the emitter. */
export interface EmittedSignal {
  id: string;
}

/**
 * Interface for emitting compost signals.
 * Inject an implementation that wraps your compost/emitter module.
 * If not provided, challenges are stored locally but not emitted.
 */
export interface SignalEmitter {
  emitSignal(input: {
    signalType: string;
    pattern: Record<string, unknown>;
    confidence: number;
    contextTag: string;
  }): Promise<EmittedSignal>;
}

// ── Types ─────────────────────────────────────────────────────────────────

export type ChallengeCategory =
  | "spec_feedback"
  | "default_value"
  | "glossary_term"
  | "protocol_change";

export type ChallengeStatus =
  | "pending"
  | "accepted"
  | "rejected"
  | "superseded"
  | "withdrawn";

export interface ChallengeRequest {
  spec: string;
  section?: string;
  challenge: string;
  evidence: string;
  proposed: string;
  confidence: number;
  category?: ChallengeCategory;
}

export interface ChallengeRecord {
  id: string;
  signalId: string;
  createdAt: string;
  category: ChallengeCategory;
  spec: string;
  section?: string;
  challenge: string;
  evidence: string;
  proposed: string;
  confidence: number;
  dictionaryVersion: string;
  status: ChallengeStatus;
  updatedAt: string;
}

// ── Local challenge log ──────────────────────────────────────────────────

const DEFAULT_CHALLENGE_LOG = "brain/dictionary/challenges.jsonl";
let challengeLogPath = DEFAULT_CHALLENGE_LOG;

export function setChallengeLogPath(path: string): void {
  challengeLogPath = path;
}

function genChallengeId(): string {
  return "dc_" + Date.now().toString(36) + "_" + randomBytes(4).toString("hex");
}

// ── Core API ─────────────────────────────────────────────────────────────

/**
 * Submit a dictionary challenge.
 *
 * If a SignalEmitter is provided, emits a governance signal.
 * Always appends a ChallengeRecord to the local challenge log.
 */
export async function submitChallenge(
  request: ChallengeRequest,
  dictionaryVersion: string,
  emitter?: SignalEmitter,
): Promise<ChallengeRecord> {
  if (!request.spec) throw new Error("Challenge must target a spec");
  if (!request.challenge) throw new Error("Challenge must include a description");
  if (!request.evidence) throw new Error("Challenge must include evidence");
  if (!request.proposed) throw new Error("Challenge must include a proposed alternative");

  const confidence = Math.max(0, Math.min(1, request.confidence));
  const category = request.category ?? "spec_feedback";
  const now = new Date().toISOString();

  const pattern: Record<string, unknown> = {
    type: "dictionary_challenge",
    category,
    spec: request.spec,
    challenge: request.challenge,
    evidence: request.evidence,
    proposed: request.proposed,
    confidence,
    dictionaryVersion,
  };
  if (request.section) {
    pattern.section = request.section;
  }

  // Emit signal if emitter provided
  let signalId = `local_${genChallengeId()}`;
  if (emitter) {
    const signal = await emitter.emitSignal({
      signalType: "governance",
      pattern,
      confidence,
      contextTag: `dictionary-challenge:${request.spec}`,
    });
    signalId = signal.id;
    log.info("Dictionary challenge emitted", {
      spec: request.spec,
      challenge: request.challenge,
      signalId,
    });
  } else {
    log.info("Dictionary challenge stored locally (no signal emitter)", {
      spec: request.spec,
      challenge: request.challenge,
    });
  }

  const record: ChallengeRecord = {
    id: genChallengeId(),
    signalId,
    createdAt: now,
    category,
    spec: request.spec,
    section: request.section,
    challenge: request.challenge,
    evidence: request.evidence,
    proposed: request.proposed,
    confidence,
    dictionaryVersion,
    status: "pending",
    updatedAt: now,
  };

  await mkdir(dirname(challengeLogPath), { recursive: true });
  await appendFile(challengeLogPath, JSON.stringify(record) + "\n", "utf-8");

  return record;
}

export async function readChallenges(): Promise<ChallengeRecord[]> {
  try {
    const raw = await readFile(challengeLogPath, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    return lines.map(line => JSON.parse(line) as ChallengeRecord).reverse();
  } catch {
    return [];
  }
}

export async function readChallengesByStatus(
  status: ChallengeStatus,
): Promise<ChallengeRecord[]> {
  const all = await readChallenges();
  return all.filter(c => c.status === status);
}

export async function readChallengesForSpec(
  spec: string,
): Promise<ChallengeRecord[]> {
  const all = await readChallenges();
  return all.filter(c => c.spec === spec);
}

export async function updateChallengeStatus(
  challengeId: string,
  newStatus: ChallengeStatus,
): Promise<ChallengeRecord | null> {
  const all = await readChallenges();
  const existing = all.find(c => c.id === challengeId);
  if (!existing) return null;

  const updated: ChallengeRecord = {
    ...existing,
    status: newStatus,
    updatedAt: new Date().toISOString(),
  };

  await appendFile(challengeLogPath, JSON.stringify(updated) + "\n", "utf-8");

  log.info("Challenge status updated", {
    id: challengeId,
    from: existing.status,
    to: newStatus,
  });

  return updated;
}

export async function getCurrentChallenges(): Promise<ChallengeRecord[]> {
  const all = await readChallenges();
  const seen = new Set<string>();
  const current: ChallengeRecord[] = [];

  for (const record of all) {
    if (!seen.has(record.id)) {
      seen.add(record.id);
      current.push(record);
    }
  }

  return current;
}
