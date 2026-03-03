/**
 * Issue SLA tracking — monitor response and resolution times against targets.
 *
 * Defines SLA targets by priority level (critical, high, medium, low).
 * Measures first-response time and resolution time.
 * Generates compliance reports with breach details.
 */

import { createLogger } from "../utils/logger.js";
import { logActivity } from "../activity/log.js";
import * as client from "./client.js";
import { triageFromIssue } from "./issue-triage.js";
import type {
  SLAConfig,
  SLAReport,
  SLACompliance,
  SLABreach,
  IssuePriority,
  GitHubIssue,
} from "./types.js";

const log = createLogger("github.issue-sla");

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

// ── Default SLA configuration ────────────────────────────────────────────────

const DEFAULT_SLA: SLAConfig = {
  targets: {
    critical: { responseHours: 4, resolutionHours: 24 },
    high: { responseHours: 8, resolutionHours: 72 },
    medium: { responseHours: 24, resolutionHours: 168 }, // 7 days
    low: { responseHours: 72, resolutionHours: 720 },     // 30 days
  },
};

let activeSLA: SLAConfig = { ...DEFAULT_SLA };

/**
 * Update the SLA configuration.
 */
export function setSLAConfig(config: Partial<SLAConfig>): void {
  activeSLA = {
    targets: {
      ...DEFAULT_SLA.targets,
      ...config.targets,
    },
  };
}

/** Get current SLA configuration. */
export function getSLAConfig(): SLAConfig {
  return activeSLA;
}

// ── SLA measurement ──────────────────────────────────────────────────────────

function hoursBetween(a: string, b: string): number {
  return Math.abs(new Date(b).getTime() - new Date(a).getTime()) / MS_PER_HOUR;
}

/**
 * Determine priority for an issue using the triage system.
 */
function getIssuePriority(issue: GitHubIssue): IssuePriority {
  // Use the existing triage system to classify
  const triage = triageFromIssue("", "", issue);
  return triage.priority;
}

/**
 * Find first response time for an issue.
 * First response = first comment from someone other than the issue author.
 */
async function getFirstResponseTime(
  owner: string,
  repo: string,
  issue: GitHubIssue,
): Promise<number | null> {
  const comments = await client.listIssueComments(owner, repo, issue.number, { per_page: 10 });
  if (!comments || comments.length === 0) return null;

  // Find first comment not from the issue author
  const firstResponse = comments.find((c) => c.user.login !== issue.user.login);
  if (!firstResponse) return null;

  return hoursBetween(issue.created_at, firstResponse.created_at);
}

/**
 * Get resolution time for a closed issue.
 */
function getResolutionTime(issue: GitHubIssue): number | null {
  if (issue.state !== "closed" || !issue.closed_at) return null;
  return hoursBetween(issue.created_at, issue.closed_at);
}

// ── Report generation ────────────────────────────────────────────────────────

function emptyCompliance(): SLACompliance {
  return { total: 0, withinSLA: 0, breached: 0, complianceRate: 100 };
}

/**
 * Generate an SLA compliance report for a repository.
 */
export async function getSLAReport(
  owner: string,
  repo: string,
  opts?: { days?: number },
): Promise<SLAReport | null> {
  const days = opts?.days ?? 30;
  const since = new Date(Date.now() - days * MS_PER_DAY).toISOString();

  log.info(`Generating SLA report for ${owner}/${repo} (last ${days} days)`);

  const issues = await client.listIssues(owner, repo, { state: "all", per_page: 100, since });
  if (!issues) {
    log.warn(`Failed to fetch issues for ${owner}/${repo}`);
    return null;
  }

  // Filter to actual issues (not PRs) created in the period
  const periodIssues = issues.filter(
    (i) => !i.pull_request && new Date(i.created_at).getTime() >= new Date(since).getTime(),
  );

  const overall = emptyCompliance();
  const byPriority: Record<IssuePriority, SLACompliance> = {
    critical: emptyCompliance(),
    high: emptyCompliance(),
    medium: emptyCompliance(),
    low: emptyCompliance(),
  };
  const breaches: SLABreach[] = [];

  for (const issue of periodIssues) {
    const priority = getIssuePriority(issue);
    const target = activeSLA.targets[priority];

    overall.total++;
    byPriority[priority].total++;

    let isBreached = false;

    // Check resolution SLA for closed issues
    const resolutionHours = getResolutionTime(issue);
    if (resolutionHours !== null && resolutionHours > target.resolutionHours) {
      isBreached = true;
      breaches.push({
        issueNumber: issue.number,
        title: issue.title,
        priority,
        type: "resolution",
        targetHours: target.resolutionHours,
        actualHours: Math.round(resolutionHours * 10) / 10,
        url: issue.html_url,
      });
    }

    // Check response SLA — only if we can fetch first response
    const firstResponseHours = await getFirstResponseTime(owner, repo, issue);
    if (firstResponseHours !== null && firstResponseHours > target.responseHours) {
      isBreached = true;
      breaches.push({
        issueNumber: issue.number,
        title: issue.title,
        priority,
        type: "response",
        targetHours: target.responseHours,
        actualHours: Math.round(firstResponseHours * 10) / 10,
        url: issue.html_url,
      });
    }

    // For open issues past their resolution SLA, also flag them
    if (issue.state === "open") {
      const ageHours = hoursBetween(issue.created_at, new Date().toISOString());
      if (ageHours > target.resolutionHours) {
        isBreached = true;
        breaches.push({
          issueNumber: issue.number,
          title: issue.title,
          priority,
          type: "resolution",
          targetHours: target.resolutionHours,
          actualHours: Math.round(ageHours * 10) / 10,
          url: issue.html_url,
        });
      }
    }

    if (isBreached) {
      overall.breached++;
      byPriority[priority].breached++;
    } else {
      overall.withinSLA++;
      byPriority[priority].withinSLA++;
    }
  }

  // Compute compliance rates
  overall.complianceRate = overall.total > 0
    ? Math.round((overall.withinSLA / overall.total) * 100)
    : 100;

  for (const p of Object.keys(byPriority) as IssuePriority[]) {
    const c = byPriority[p];
    c.complianceRate = c.total > 0
      ? Math.round((c.withinSLA / c.total) * 100)
      : 100;
  }

  // Sort breaches by priority (critical first)
  const priorityOrder: IssuePriority[] = ["critical", "high", "medium", "low"];
  breaches.sort((a, b) => priorityOrder.indexOf(a.priority) - priorityOrder.indexOf(b.priority));

  const report: SLAReport = {
    repo: `${owner}/${repo}`,
    period: { from: since, to: new Date().toISOString() },
    generatedAt: new Date().toISOString(),
    overall,
    byPriority,
    breaches,
  };

  logActivity({
    source: "board",
    summary: `SLA report: ${owner}/${repo} — ${overall.complianceRate}% compliance (${overall.breached} breaches in ${overall.total} issues)`,
  });

  return report;
}

/**
 * Format an SLA report as markdown.
 */
export function formatSLAReport(report: SLAReport): string {
  const lines: string[] = [];
  lines.push(`## SLA Compliance Report: ${report.repo}`);
  lines.push("");
  lines.push(`*Period: ${new Date(report.period.from).toLocaleDateString()} – ${new Date(report.period.to).toLocaleDateString()}*`);
  lines.push("");
  lines.push(`**Overall Compliance: ${report.overall.complianceRate}%** (${report.overall.withinSLA}/${report.overall.total} within SLA)`);
  lines.push("");

  lines.push("### By Priority");
  lines.push("");
  lines.push("| Priority | Total | Within SLA | Breached | Rate |");
  lines.push("|----------|-------|------------|----------|------|");
  for (const p of ["critical", "high", "medium", "low"] as IssuePriority[]) {
    const c = report.byPriority[p];
    lines.push(`| ${p} | ${c.total} | ${c.withinSLA} | ${c.breached} | ${c.complianceRate}% |`);
  }

  if (report.breaches.length > 0) {
    lines.push("");
    lines.push("### SLA Breaches");
    lines.push("");
    lines.push("| Issue | Priority | Type | Target | Actual |");
    lines.push("|-------|----------|------|--------|--------|");
    for (const b of report.breaches.slice(0, 20)) {
      lines.push(`| #${b.issueNumber} ${b.title.slice(0, 40)} | ${b.priority} | ${b.type} | ${b.targetHours}h | ${b.actualHours}h |`);
    }
    if (report.breaches.length > 20) {
      lines.push(`| *... and ${report.breaches.length - 20} more* | | | | |`);
    }
  }

  return lines.join("\n");
}
