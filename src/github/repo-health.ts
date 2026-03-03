/**
 * Repository health monitoring — track metrics and trends for a GitHub repo.
 *
 * Metrics: commit frequency, issue resolution time, PR review time,
 * open/stale counts, active contributors.
 */

import { createLogger } from "../utils/logger.js";
import { logActivity } from "../activity/log.js";
import * as client from "./client.js";
import type {
  RepoHealthReport,
  RepoHealthMetrics,
  RepoHealthTrends,
  HealthGrade,
  GitHubIssue,
  GitHubPullRequest,
  CIHealthMetrics,
  GitHubWorkflowRun,
} from "./types.js";

const log = createLogger("github.repo-health");

const STALE_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ── Metric computation ───────────────────────────────────────────────────────

function daysBetween(a: string, b: string): number {
  return Math.abs(new Date(b).getTime() - new Date(a).getTime()) / MS_PER_DAY;
}

function isStale(updatedAt: string): boolean {
  return daysBetween(updatedAt, new Date().toISOString()) > STALE_DAYS;
}

function computeAvgResolutionDays(issues: GitHubIssue[]): number {
  const closed = issues.filter((i) => i.state === "closed" && i.closed_at);
  if (closed.length === 0) return 0;

  const total = closed.reduce((sum, i) => sum + daysBetween(i.created_at, i.closed_at!), 0);
  return Math.round((total / closed.length) * 10) / 10;
}

function computeAvgPRReviewDays(prs: GitHubPullRequest[]): number {
  const merged = prs.filter((p) => p.merged && p.merged_at);
  if (merged.length === 0) return 0;

  const total = merged.reduce((sum, p) => sum + daysBetween(p.created_at, p.merged_at!), 0);
  return Math.round((total / merged.length) * 10) / 10;
}

function countActiveContributors(
  commits: Array<{ commit: { author: { name: string; email: string; date: string } | null } }>,
): number {
  const authors = new Set<string>();
  for (const c of commits) {
    if (c.commit.author?.email) {
      authors.add(c.commit.author.email);
    }
  }
  return authors.size;
}

function computeBusFactor(
  commits: Array<{ commit: { author: { name: string; email: string; date: string } | null } }>,
): number {
  if (commits.length === 0) return 0;

  // Count commits per author
  const authorCounts = new Map<string, number>();
  for (const c of commits) {
    const email = c.commit.author?.email;
    if (!email) continue;
    authorCounts.set(email, (authorCounts.get(email) ?? 0) + 1);
  }

  if (authorCounts.size === 0) return 0;

  // Sort by commit count descending
  const sorted = [...authorCounts.values()].sort((a, b) => b - a);
  const total = sorted.reduce((sum, n) => sum + n, 0);
  const threshold = total * 0.8;

  // Count how many top contributors account for 80% of commits
  let cumulative = 0;
  let count = 0;
  for (const n of sorted) {
    cumulative += n;
    count++;
    if (cumulative >= threshold) break;
  }

  return count;
}

function computeCIHealth(runs: GitHubWorkflowRun[]): CIHealthMetrics | null {
  if (runs.length === 0) return null;

  const completed = runs.filter((r) => r.status === "completed");
  const successful = completed.filter((r) => r.conclusion === "success");

  // Compute average duration for completed runs that have run_started_at
  let avgDurationSeconds: number | null = null;
  const durations: number[] = [];
  for (const r of completed) {
    if (r.run_started_at) {
      const start = new Date(r.run_started_at).getTime();
      const end = new Date(r.updated_at).getTime();
      if (end > start) durations.push((end - start) / 1000);
    }
  }
  if (durations.length > 0) {
    avgDurationSeconds = Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
  }

  // Count distinct failing workflows
  const failingWorkflowIds = new Set<number>();
  for (const r of completed) {
    if (r.conclusion === "failure") {
      failingWorkflowIds.add(r.workflow_id);
    }
  }

  return {
    totalRuns: runs.length,
    successfulRuns: successful.length,
    successRate: completed.length > 0 ? Math.round((successful.length / completed.length) * 100) : 0,
    avgDurationSeconds,
    failingWorkflows: failingWorkflowIds.size,
  };
}

// ── Trend detection ──────────────────────────────────────────────────────────

function detectCommitTrend(
  commits: Array<{ commit: { author: { date: string } | null } }>,
): "increasing" | "stable" | "decreasing" {
  if (commits.length < 4) return "stable";

  const now = Date.now();
  const halfwayMs = 15 * MS_PER_DAY;

  let recentCount = 0;
  let olderCount = 0;
  for (const c of commits) {
    const date = c.commit.author?.date;
    if (!date) continue;
    const age = now - new Date(date).getTime();
    if (age < halfwayMs) recentCount++;
    else olderCount++;
  }

  if (recentCount > olderCount * 1.3) return "increasing";
  if (olderCount > recentCount * 1.3) return "decreasing";
  return "stable";
}

function detectIssueTrend(issues: GitHubIssue[]): "improving" | "stable" | "worsening" {
  if (issues.length < 4) return "stable";

  const now = Date.now();
  const halfwayMs = 15 * MS_PER_DAY;

  let recentOpen = 0;
  let olderOpen = 0;
  for (const i of issues) {
    if (i.state !== "open") continue;
    const age = now - new Date(i.created_at).getTime();
    if (age < halfwayMs) recentOpen++;
    else olderOpen++;
  }

  if (recentOpen < olderOpen * 0.7) return "improving";
  if (recentOpen > olderOpen * 1.3) return "worsening";
  return "stable";
}

function detectPRTrend(prs: GitHubPullRequest[]): "improving" | "stable" | "worsening" {
  const openPRs = prs.filter((p) => p.state === "open");
  const stalePRs = openPRs.filter((p) => isStale(p.updated_at));

  if (stalePRs.length === 0 && openPRs.length <= 3) return "improving";
  if (stalePRs.length > openPRs.length / 2) return "worsening";
  return "stable";
}

// ── Grading ──────────────────────────────────────────────────────────────────

function computeGrade(metrics: RepoHealthMetrics, trends: RepoHealthTrends): HealthGrade {
  let score = 0;

  // Commit frequency (0-25 points)
  if (metrics.commitFrequency >= 20) score += 25;
  else if (metrics.commitFrequency >= 10) score += 20;
  else if (metrics.commitFrequency >= 5) score += 15;
  else if (metrics.commitFrequency >= 1) score += 10;

  // Issue resolution (0-25 points)
  if (metrics.avgIssueResolutionDays === 0 && metrics.openIssues === 0) score += 25;
  else if (metrics.avgIssueResolutionDays <= 3) score += 25;
  else if (metrics.avgIssueResolutionDays <= 7) score += 20;
  else if (metrics.avgIssueResolutionDays <= 14) score += 15;
  else if (metrics.avgIssueResolutionDays <= 30) score += 10;

  // PR review time (0-25 points)
  if (metrics.avgPRReviewDays === 0 && metrics.openPRs === 0) score += 25;
  else if (metrics.avgPRReviewDays <= 1) score += 25;
  else if (metrics.avgPRReviewDays <= 3) score += 20;
  else if (metrics.avgPRReviewDays <= 7) score += 15;
  else if (metrics.avgPRReviewDays <= 14) score += 10;

  // Staleness penalty (0-25 points)
  const stalePenalty = Math.min(25, (metrics.staleIssues + metrics.stalePRs) * 3);
  score += 25 - stalePenalty;

  // Trend bonuses/penalties
  if (trends.commitTrend === "increasing") score += 5;
  if (trends.commitTrend === "decreasing") score -= 5;
  if (trends.issueTrend === "improving") score += 5;
  if (trends.issueTrend === "worsening") score -= 5;

  if (score >= 85) return "A";
  if (score >= 70) return "B";
  if (score >= 55) return "C";
  if (score >= 40) return "D";
  return "F";
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Generate a health report for a repository.
 * Fetches recent issues, PRs, and commits to compute metrics.
 */
export async function getRepoHealth(
  owner: string,
  repo: string,
): Promise<RepoHealthReport | null> {
  log.info(`Generating health report for ${owner}/${repo}`);

  const thirtyDaysAgo = new Date(Date.now() - 30 * MS_PER_DAY).toISOString();

  // Fetch data in parallel
  const [issues, prs, commits, workflowRuns] = await Promise.all([
    client.listIssues(owner, repo, { state: "all", per_page: 100, since: thirtyDaysAgo }),
    client.listPullRequests(owner, repo, { state: "all", per_page: 100 }),
    client.listCommits(owner, repo, { since: thirtyDaysAgo, per_page: 100 }),
    client.listWorkflowRuns(owner, repo, { per_page: 100, created: `>=${thirtyDaysAgo.split("T")[0]}` }),
  ]);

  if (!issues || !prs || !commits) {
    log.warn(`Failed to fetch repo data for ${owner}/${repo}`);
    return null;
  }

  // Filter out PRs from issue list (GitHub API returns PRs under /issues)
  const pureIssues = issues.filter((i) => !i.pull_request);

  const openIssues = pureIssues.filter((i) => i.state === "open");
  const openPRs = prs.filter((p) => p.state === "open");

  const metrics: RepoHealthMetrics = {
    commitFrequency: commits.length,
    avgIssueResolutionDays: computeAvgResolutionDays(pureIssues),
    avgPRReviewDays: computeAvgPRReviewDays(prs),
    openIssues: openIssues.length,
    openPRs: openPRs.length,
    staleIssues: openIssues.filter((i) => isStale(i.updated_at)).length,
    stalePRs: openPRs.filter((p) => isStale(p.updated_at)).length,
    activeContributors: countActiveContributors(commits),
    busFactor: computeBusFactor(commits),
    ciHealth: computeCIHealth(workflowRuns?.workflow_runs ?? []),
  };

  const trends: RepoHealthTrends = {
    commitTrend: detectCommitTrend(commits),
    issueTrend: detectIssueTrend(pureIssues),
    prTrend: detectPRTrend(prs),
  };

  const overall = computeGrade(metrics, trends);

  const report: RepoHealthReport = {
    repo: `${owner}/${repo}`,
    generatedAt: new Date().toISOString(),
    overall,
    metrics,
    trends,
  };

  logActivity({
    source: "board",
    summary: `Repo health: ${owner}/${repo} → grade ${overall} (${commits.length} commits, ${openIssues.length} open issues, ${openPRs.length} open PRs)`,
  });

  return report;
}

/**
 * Format a health report as a markdown string (for display or posting).
 */
export function formatHealthReport(report: RepoHealthReport): string {
  const lines: string[] = [];
  lines.push(`## Repository Health Report: ${report.repo}`);
  lines.push("");
  lines.push(`**Overall Grade: ${report.overall}**`);
  lines.push(`*Generated: ${new Date(report.generatedAt).toLocaleDateString()}*`);
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Commits (30d) | ${report.metrics.commitFrequency} |`);
  lines.push(`| Active contributors | ${report.metrics.activeContributors} |`);
  lines.push(`| Open issues | ${report.metrics.openIssues} |`);
  lines.push(`| Open PRs | ${report.metrics.openPRs} |`);
  lines.push(`| Stale issues | ${report.metrics.staleIssues} |`);
  lines.push(`| Stale PRs | ${report.metrics.stalePRs} |`);
  lines.push(`| Avg issue resolution | ${report.metrics.avgIssueResolutionDays}d |`);
  lines.push(`| Avg PR review time | ${report.metrics.avgPRReviewDays}d |`);
  lines.push(`| Bus factor | ${report.metrics.busFactor} |`);
  if (report.metrics.ciHealth) {
    lines.push(`| CI success rate | ${report.metrics.ciHealth.successRate}% |`);
    lines.push(`| CI runs (30d) | ${report.metrics.ciHealth.totalRuns} |`);
    lines.push(`| Failing workflows | ${report.metrics.ciHealth.failingWorkflows} |`);
  }
  lines.push("");
  lines.push(`### Trends`);
  lines.push(`- Commits: ${report.trends.commitTrend}`);
  lines.push(`- Issues: ${report.trends.issueTrend}`);
  lines.push(`- PRs: ${report.trends.prTrend}`);

  return lines.join("\n");
}
