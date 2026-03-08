/**
 * Issue reporter — sends anonymized self-reported issues to runcore.sh.
 *
 * Opt-in: only reports if settings.telemetry.issueReporting is true.
 * Batched: collects issues and sends in batches (max every 5 minutes).
 * Idempotent: tracks which issues have been reported to avoid duplicates.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BRAIN_DIR } from "../lib/paths.js";
import { createLogger } from "../utils/logger.js";
import { getInstanceName } from "../instance.js";
import { getSettings } from "../settings.js";
import type { SelfReportedIssue } from "./types.js";

const log = createLogger("agents.issue-reporter");

const RUNCORE_ISSUES_URL = "https://runcore.sh/api/issues/report";
const REPORTED_FILE = join(BRAIN_DIR, "operations", "reported-issues.json");
const MIN_BATCH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

let lastReportTime = 0;
let reportedIds: Set<string> = new Set();
let loaded = false;

/** Load the set of already-reported issue IDs from disk. */
async function loadReportedIds(): Promise<void> {
  if (loaded) return;
  try {
    const data = await readFile(REPORTED_FILE, "utf-8");
    const ids = JSON.parse(data) as string[];
    reportedIds = new Set(ids);
  } catch {
    reportedIds = new Set();
  }
  loaded = true;
}

/** Persist the reported IDs to disk. */
async function saveReportedIds(): Promise<void> {
  try {
    await mkdir(join(BRAIN_DIR, "operations"), { recursive: true });
    // Keep last 500 IDs to prevent unbounded growth
    const ids = [...reportedIds].slice(-500);
    await writeFile(REPORTED_FILE, JSON.stringify(ids), "utf-8");
  } catch (err) {
    log.warn("Failed to save reported IDs", { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Check if issue reporting is enabled.
 * Uses CoreSettings — opt-in only.
 */
function isReportingEnabled(): boolean {
  return getSettings().issueReporting === true;
}

/**
 * Report issues to runcore.sh.
 * Call this after processAgentIssues() stores new issues.
 * Batches and deduplicates automatically.
 */
export async function reportIssuesUpstream(issues: SelfReportedIssue[]): Promise<void> {
  if (issues.length === 0) return;

  // Check opt-in
  if (!isReportingEnabled()) {
    log.debug("Issue reporting disabled (opt-in via settings.yaml: issueReporting: true)");
    return;
  }

  // Rate limit batches
  const now = Date.now();
  if (now - lastReportTime < MIN_BATCH_INTERVAL_MS) {
    log.debug("Skipping report — too soon since last batch");
    return;
  }

  await loadReportedIds();

  // Filter out already-reported issues
  const newIssues = issues.filter(i => !reportedIds.has(i.id));
  if (newIssues.length === 0) {
    log.debug("All issues already reported");
    return;
  }

  // Build payload — strip agentTaskId (internal) and reportedAt (use server time)
  const payload = {
    instanceId: getInstanceName(),
    issues: newIssues.map(i => ({
      title: i.title,
      description: i.description,
      severity: i.severity,
      category: i.category,
      files: i.files,
      suggestion: i.suggestion,
      coreVersion: i.coreVersion,
    })),
  };

  try {
    const response = await fetch(RUNCORE_ISSUES_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });

    if (response.ok) {
      const result = await response.json() as { accepted: number; duplicates: number };
      log.info(`Reported ${result.accepted} issue(s) upstream (${result.duplicates} duplicates)`);

      // Mark as reported
      for (const issue of newIssues) {
        reportedIds.add(issue.id);
      }
      await saveReportedIds();
      lastReportTime = now;
    } else if (response.status === 429) {
      log.warn("Rate limited by runcore.sh — will retry later");
      lastReportTime = now; // Back off
    } else {
      log.warn(`Report failed: ${response.status}`);
    }
  } catch (err) {
    // Network errors are expected (offline, DNS, etc.) — don't spam logs
    log.debug("Report failed (network)", { error: err instanceof Error ? err.message : String(err) });
  }
}
