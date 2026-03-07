/**
 * Agent Governance Gate — CORE-9
 *
 * Pre-spawn validation that replaces the `--dangerously-skip-permissions`
 * prompt with voucher-based authorization, locked-path enforcement, and
 * principle injection.
 *
 * Every governed spawn:
 * 1. Issues a scoped voucher for the task
 * 2. Reads locked paths and builds a deny-list for the agent's prompt
 * 3. Injects core principles as behavioral constraints
 * 4. Wraps the prompt with governance preamble
 * 5. Logs the governance decision to the audit trail
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { issueVoucher, checkVoucher, revokeVoucher } from "../voucher.js";
import { getLockedPaths, loadLockedPaths } from "../lib/locked.js";
import { checkSpawnPolicy, loadSpawnPolicy } from "./spawn-policy.js";
import type { LongTermMemoryStore } from "../memory/long-term.js";
import { logActivity } from "../activity/log.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("governance");

const BRAIN_DIR = resolve(process.cwd(), "brain");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of a governance check — pass or deny with reason. */
export interface GovernanceDecision {
  allowed: boolean;
  voucherToken?: string;
  deniedReason?: string;
  governedPrompt: string;
  lockedPaths: string[];
  auditEntry: GovernanceAuditEntry;
}

/** Audit record for every governance decision. */
export interface GovernanceAuditEntry {
  timestamp: string;
  taskId: string;
  label: string;
  decision: "allow" | "deny";
  voucherToken?: string;
  voucherScope?: string;
  lockedPathCount: number;
  reason?: string;
}

/** Options for the governance gate. */
export interface GovernanceOptions {
  taskId: string;
  label: string;
  prompt: string;
  origin: "user" | "ai" | "system";
  /** LTM store for voucher operations. */
  ltm: LongTermMemoryStore;
  /** Override voucher scope (default: "agent:spawn:{taskId}"). */
  scope?: string;
  /** Voucher TTL in minutes (default: 30). */
  voucherTtlMinutes?: number;
  /** Skip voucher issuance (for system-originated tasks). */
  skipVoucher?: boolean;
  /** Agent type for spawn policy checks (e.g. "administration", "brand"). */
  agentType?: string;
  /** Current total running agent count (for spawn policy max check). */
  currentAgentCount?: number;
  /** Current running count of this specific agent type. */
  currentTypeCount?: number;
}

// ---------------------------------------------------------------------------
// Governance preamble components
// ---------------------------------------------------------------------------

function buildLockedPathsSection(paths: string[]): string {
  if (paths.length === 0) return "";
  const pathList = paths.map((p) => `  - brain/${p}`).join("\n");
  return `
## Locked Paths (DO NOT ACCESS)
The following paths are locked by governance policy. Do NOT read, write, or
reference these files. Violations will be logged and may terminate your session.

${pathList}
`;
}

function buildVoucherSection(token: string, scope: string): string {
  return `
## Governance Voucher
You are operating under voucher \`${token}\` with scope \`${scope}\`.
This voucher is time-limited. If you receive a governance violation, stop immediately.
`;
}

async function loadPrinciples(): Promise<string> {
  try {
    const principlesPath = join(BRAIN_DIR, "identity", "principles.md");
    const content = await readFile(principlesPath, "utf-8");
    // Extract just the key principles, not the full document
    const lines = content.split("\n");
    const keyPrinciples: string[] = [];
    for (const line of lines) {
      if (line.startsWith("**") && line.endsWith("**")) {
        keyPrinciples.push(line);
      }
    }
    if (keyPrinciples.length === 0) return "";
    return `
## Operating Principles
You must adhere to these principles during execution:
${keyPrinciples.map((p) => `- ${p}`).join("\n")}
`;
  } catch {
    log.warn("Could not load principles — proceeding without them");
    return "";
  }
}

// ---------------------------------------------------------------------------
// Main governance gate
// ---------------------------------------------------------------------------

/**
 * Run the governance gate before spawning an agent.
 * Returns a GovernanceDecision with the governed prompt (or denial).
 */
export async function governanceGate(
  opts: GovernanceOptions,
): Promise<GovernanceDecision> {
  const {
    taskId,
    label,
    prompt,
    origin,
    ltm,
    scope: scopeOverride,
    voucherTtlMinutes = 30,
    skipVoucher = false,
  } = opts;

  const scope = scopeOverride ?? `agent:spawn:${taskId}`;
  const timestamp = new Date().toISOString();

  // 1. Load locked paths
  const lockedPaths = await loadLockedPaths();

  // 1b. Spawn policy check (if agentType provided)
  if (opts.agentType) {
    await loadSpawnPolicy();
    const spawnCheck = checkSpawnPolicy(
      opts.agentType,
      opts.currentAgentCount ?? 0,
      opts.currentTypeCount ?? 0,
    );
    if (!spawnCheck.allowed) {
      const reason = `Spawn policy denied: ${spawnCheck.reason}`;
      log.warn(reason, { taskId, agentType: opts.agentType });

      const auditEntry: GovernanceAuditEntry = {
        timestamp,
        taskId,
        label,
        decision: "deny",
        lockedPathCount: lockedPaths.length,
        reason,
      };

      logActivity({
        source: "agent",
        summary: `Governance DENIED (spawn policy): ${label}`,
        detail: reason,
        actionLabel: origin === "ai" ? "AUTONOMOUS" : "PROMPTED",
        reason: "governance-gate",
      });

      return {
        allowed: false,
        deniedReason: reason,
        governedPrompt: prompt,
        lockedPaths,
        auditEntry,
      };
    }
  }

  // 2. Issue voucher (unless skipped for system tasks)
  let voucherToken: string | undefined;
  if (!skipVoucher) {
    try {
      voucherToken = await issueVoucher(ltm, scope, voucherTtlMinutes);
      log.info("Voucher issued for agent", { taskId, token: voucherToken, scope });
    } catch (err) {
      const reason = `Voucher issuance failed: ${err instanceof Error ? err.message : String(err)}`;
      log.error(reason, { taskId });

      const auditEntry: GovernanceAuditEntry = {
        timestamp,
        taskId,
        label,
        decision: "deny",
        lockedPathCount: lockedPaths.length,
        reason,
      };

      logActivity({
        source: "agent",
        summary: `Governance DENIED: ${label}`,
        detail: reason,
        actionLabel: origin === "ai" ? "AUTONOMOUS" : "PROMPTED",
        reason: "governance-gate",
      });

      return {
        allowed: false,
        deniedReason: reason,
        governedPrompt: prompt,
        lockedPaths,
        auditEntry,
      };
    }
  }

  // 3. Load principles
  const principlesSection = await loadPrinciples();

  // 4. Build governed prompt
  const governancePreamble = [
    "## Governance Context",
    "This agent session is governed by the Core orchestration system.",
    "You are running with `--dangerously-skip-permissions`. In exchange,",
    "governance controls replace the permission prompt. Violating these",
    "controls will terminate your session.",
    "",
    voucherToken ? buildVoucherSection(voucherToken, scope) : "",
    buildLockedPathsSection(lockedPaths),
    principlesSection,
    "## Heartbeat Requirement",
    "Your actions are monitored. Extended silence (no file writes, no output)",
    "will trigger a timeout and termination. Stay on task.",
    "",
    "---",
    "",
  ]
    .filter(Boolean)
    .join("\n");

  const governedPrompt = governancePreamble + prompt;

  // 5. Log the decision
  const auditEntry: GovernanceAuditEntry = {
    timestamp,
    taskId,
    label,
    decision: "allow",
    voucherToken,
    voucherScope: scope,
    lockedPathCount: lockedPaths.length,
  };

  logActivity({
    source: "agent",
    summary: `Governance ALLOWED: ${label}`,
    detail: `Voucher: ${voucherToken ?? "skipped"}, locked paths: ${lockedPaths.length}`,
    actionLabel: origin === "ai" ? "AUTONOMOUS" : "PROMPTED",
    reason: "governance-gate",
  });

  log.info("Governance gate passed", { taskId, label, voucherToken });

  return {
    allowed: true,
    voucherToken,
    governedPrompt,
    lockedPaths,
    auditEntry,
  };
}

/**
 * Revoke a governance voucher (call on agent completion or termination).
 */
export async function revokeGovernanceVoucher(
  ltm: LongTermMemoryStore,
  token: string,
): Promise<void> {
  try {
    await revokeVoucher(ltm, token);
    log.info("Governance voucher revoked", { token });
  } catch (err) {
    log.warn("Failed to revoke voucher", {
      token,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Validate that a voucher is still active (for mid-session checks).
 */
export async function validateGovernanceVoucher(
  ltm: LongTermMemoryStore,
  token: string,
): Promise<boolean> {
  const result = await checkVoucher(ltm, token);
  return result.valid;
}
