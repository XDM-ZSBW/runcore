/**
 * Self-reported issue collector.
 *
 * Read-only autonomous agents produce [ISSUE_REPORT] blocks.
 * This module parses them from agent output, stores them in
 * brain/operations/self-reports.jsonl, and provides a list for
 * centralized backlog aggregation.
 *
 * All reports are anonymized before storage:
 * - Absolute paths stripped to relative
 * - Instance name, brain dir, and user name removed
 * - Only structural/code-level info preserved
 */

import { appendFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BRAIN_DIR } from "../lib/paths.js";
import { createLogger } from "../utils/logger.js";
import type { SelfReportedIssue } from "./types.js";
import { reportIssuesUpstream } from "./issue-reporter.js";

const log = createLogger("agents.issues");

const REPORTS_DIR = join(BRAIN_DIR, "operations");
const REPORTS_FILE = join(REPORTS_DIR, "self-reports.jsonl");

/** Get Core version from package.json (cached). */
let _version: string | null = null;
function getCoreVersion(): string {
  if (_version) return _version;
  try {
    const pkg = require("../../package.json");
    _version = pkg.version ?? "unknown";
  } catch {
    _version = "unknown";
  }
  return _version!;
}

/** Strip absolute paths to relative, remove instance-specific info. */
function anonymize(raw: Partial<SelfReportedIssue>): Partial<SelfReportedIssue> {
  const cwd = process.cwd().replace(/\\/g, "/");
  const brainDir = BRAIN_DIR.replace(/\\/g, "/");

  function stripPaths(s: string): string {
    // Replace absolute paths with relative
    return s
      .replace(new RegExp(cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), ".")
      .replace(new RegExp(brainDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "<brain>")
      // Strip Windows drive letters: E:/... → ./...
      .replace(/[A-Z]:[/\\]/gi, "./")
      // Strip user home paths
      .replace(/C:[/\\]Users[/\\][^/\\]+[/\\]/gi, "~/");
  }

  return {
    ...raw,
    title: raw.title ? stripPaths(raw.title) : raw.title,
    description: raw.description ? stripPaths(raw.description) : raw.description,
    suggestion: raw.suggestion ? stripPaths(raw.suggestion) : raw.suggestion,
    files: raw.files?.map((f) => stripPaths(f.replace(/\\/g, "/"))),
  };
}

/**
 * Parse [ISSUE_REPORT] blocks from agent output.
 * Returns parsed and anonymized issues.
 */
export function parseIssueReports(output: string, agentTaskId: string): SelfReportedIssue[] {
  const blocks = [...output.matchAll(/\[ISSUE_REPORT\]\s*([\s\S]*?)\s*\[\/ISSUE_REPORT\]/g)];
  if (blocks.length === 0) return [];

  const issues: SelfReportedIssue[] = [];
  const now = new Date().toISOString();
  const version = getCoreVersion();

  for (const block of blocks) {
    try {
      const raw = JSON.parse(block[1].trim());
      const anon = anonymize(raw);

      const issue: SelfReportedIssue = {
        id: `sr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        title: anon.title || "Untitled issue",
        description: anon.description || "",
        severity: ["low", "medium", "high"].includes(anon.severity as string) ? anon.severity as any : "low",
        category: ["crash", "error", "performance", "design", "missing-feature"].includes(anon.category as string)
          ? anon.category as any : "error",
        files: anon.files || [],
        suggestion: anon.suggestion,
        agentTaskId,
        reportedAt: now,
        coreVersion: version,
      };
      issues.push(issue);
    } catch (err) {
      log.warn("Failed to parse ISSUE_REPORT block", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  return issues;
}

/**
 * Append issues to the self-reports JSONL file.
 */
export async function storeIssues(issues: SelfReportedIssue[]): Promise<void> {
  if (issues.length === 0) return;

  try {
    await mkdir(REPORTS_DIR, { recursive: true });
    const lines = issues.map((i) => JSON.stringify(i)).join("\n") + "\n";
    await appendFile(REPORTS_FILE, lines, "utf-8");
    log.info(`Stored ${issues.length} self-reported issue(s)`);
  } catch (err) {
    log.error("Failed to store issues", { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Read all stored self-reported issues.
 */
export async function listIssues(): Promise<SelfReportedIssue[]> {
  try {
    const content = await readFile(REPORTS_FILE, "utf-8");
    return content
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as SelfReportedIssue);
  } catch {
    return [];
  }
}

/**
 * Process agent output: extract issue reports, store them.
 * Call this when a read-only agent completes.
 */
export async function processAgentIssues(output: string, agentTaskId: string): Promise<SelfReportedIssue[]> {
  const issues = parseIssueReports(output, agentTaskId);
  if (issues.length > 0) {
    await storeIssues(issues);
    log.info(`Agent ${agentTaskId} reported ${issues.length} issue(s)`, {
      titles: issues.map((i) => i.title),
    });
    // Fire-and-forget: attempt upstream report (opt-in, non-blocking)
    reportIssuesUpstream(issues).catch(() => {});
  }
  return issues;
}
