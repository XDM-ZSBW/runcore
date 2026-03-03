/**
 * PR merge readiness — checks whether a pull request is ready to merge.
 *
 * Evaluates: CI check status, review approvals, merge conflicts,
 * branch freshness, and draft status.
 * Produces a readiness report with pass/fail checks and blockers.
 */

import { createLogger } from "../utils/logger.js";
import { logActivity } from "../activity/log.js";
import * as client from "./client.js";
import type {
  PRReadinessReport,
  PRReadinessCheck,
} from "./types.js";

const log = createLogger("github.pr-readiness");

// ── Check functions ──────────────────────────────────────────────────────────

interface ReadinessContext {
  owner: string;
  repo: string;
  prNumber: number;
}

async function checkDraftStatus(ctx: ReadinessContext): Promise<PRReadinessCheck> {
  const pr = await client.getPullRequest(ctx.owner, ctx.repo, ctx.prNumber);
  if (!pr) {
    return { name: "Draft status", passed: false, details: "Could not fetch PR data." };
  }
  if (pr.draft) {
    return { name: "Draft status", passed: false, details: "PR is still marked as draft." };
  }
  return { name: "Draft status", passed: true, details: "PR is not a draft." };
}

async function checkCIStatus(ctx: ReadinessContext): Promise<PRReadinessCheck> {
  const pr = await client.getPullRequest(ctx.owner, ctx.repo, ctx.prNumber);
  if (!pr) {
    return { name: "CI checks", passed: false, details: "Could not fetch PR data." };
  }

  const checkRuns = await client.listCheckRuns(ctx.owner, ctx.repo, pr.head.sha);
  if (!checkRuns) {
    return { name: "CI checks", passed: true, details: "No check runs found (or unable to fetch)." };
  }

  if (checkRuns.total_count === 0) {
    return { name: "CI checks", passed: true, details: "No CI checks configured." };
  }

  const completed = checkRuns.check_runs.filter((r) => r.status === "completed");
  const pending = checkRuns.check_runs.filter((r) => r.status !== "completed");
  const failed = completed.filter((r) => r.conclusion !== "success" && r.conclusion !== "neutral" && r.conclusion !== "skipped");

  if (pending.length > 0) {
    return {
      name: "CI checks",
      passed: false,
      details: `${pending.length} check(s) still running: ${pending.map((r) => r.name).join(", ")}.`,
    };
  }

  if (failed.length > 0) {
    return {
      name: "CI checks",
      passed: false,
      details: `${failed.length} check(s) failed: ${failed.map((r) => r.name).join(", ")}.`,
    };
  }

  return {
    name: "CI checks",
    passed: true,
    details: `All ${completed.length} check(s) passed.`,
  };
}

async function checkReviewApprovals(ctx: ReadinessContext): Promise<PRReadinessCheck> {
  const reviews = await client.getPRReviews(ctx.owner, ctx.repo, ctx.prNumber);
  if (!reviews) {
    return { name: "Review approvals", passed: false, details: "Could not fetch reviews." };
  }

  if (reviews.length === 0) {
    return { name: "Review approvals", passed: false, details: "No reviews yet." };
  }

  // Get the latest review per reviewer (a reviewer can leave multiple reviews)
  const latestByReviewer = new Map<string, string>();
  for (const review of reviews) {
    if (review.state === "PENDING") continue;
    latestByReviewer.set(review.user.login, review.state);
  }

  const approvals = [...latestByReviewer.values()].filter((s) => s === "APPROVED").length;
  const changesRequested = [...latestByReviewer.values()].filter((s) => s === "CHANGES_REQUESTED").length;

  if (changesRequested > 0) {
    return {
      name: "Review approvals",
      passed: false,
      details: `${changesRequested} reviewer(s) requested changes.`,
    };
  }

  if (approvals === 0) {
    return {
      name: "Review approvals",
      passed: false,
      details: "No approvals yet.",
    };
  }

  return {
    name: "Review approvals",
    passed: true,
    details: `${approvals} approval(s) received.`,
  };
}

async function checkMergeConflicts(ctx: ReadinessContext): Promise<PRReadinessCheck> {
  const pr = await client.getPullRequest(ctx.owner, ctx.repo, ctx.prNumber);
  if (!pr) {
    return { name: "Merge conflicts", passed: false, details: "Could not fetch PR data." };
  }

  // mergeable can be null when GitHub hasn't computed it yet
  if (pr.mergeable === false) {
    return { name: "Merge conflicts", passed: false, details: "PR has merge conflicts that must be resolved." };
  }

  if (pr.mergeable === null) {
    return { name: "Merge conflicts", passed: true, details: "Merge status is still being computed by GitHub." };
  }

  return { name: "Merge conflicts", passed: true, details: "No merge conflicts." };
}

async function checkBranchFreshness(ctx: ReadinessContext): Promise<PRReadinessCheck> {
  const pr = await client.getPullRequest(ctx.owner, ctx.repo, ctx.prNumber);
  if (!pr) {
    return { name: "Branch freshness", passed: false, details: "Could not fetch PR data." };
  }

  const comparison = await client.compareBranches(ctx.owner, ctx.repo, pr.head.sha, pr.base.ref);
  if (!comparison) {
    return { name: "Branch freshness", passed: true, details: "Could not compare branches." };
  }

  if (comparison.behind_by > 0) {
    return {
      name: "Branch freshness",
      passed: false,
      details: `Branch is ${comparison.behind_by} commit(s) behind ${pr.base.ref}. Consider rebasing or merging base.`,
    };
  }

  return { name: "Branch freshness", passed: true, details: `Branch is up to date with ${pr.base.ref}.` };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Check if a PR is ready to merge.
 * Runs all readiness checks and returns a report with blockers.
 */
export async function checkPRReadiness(
  owner: string,
  repo: string,
  prNumber: number,
): Promise<PRReadinessReport | null> {
  log.info(`Checking merge readiness for ${owner}/${repo}#${prNumber}`);

  const pr = await client.getPullRequest(owner, repo, prNumber);
  if (!pr) {
    log.warn(`Failed to fetch PR ${owner}/${repo}#${prNumber}`);
    return null;
  }

  if (pr.state !== "open") {
    return {
      prNumber,
      repo: `${owner}/${repo}`,
      ready: false,
      checks: [{ name: "PR state", passed: false, details: `PR is ${pr.state}, not open.` }],
      blockers: [`PR is ${pr.state}.`],
      checkedAt: new Date().toISOString(),
    };
  }

  const ctx: ReadinessContext = { owner, repo, prNumber };

  const checks = await Promise.all([
    checkDraftStatus(ctx),
    checkCIStatus(ctx),
    checkReviewApprovals(ctx),
    checkMergeConflicts(ctx),
    checkBranchFreshness(ctx),
  ]);

  const blockers = checks.filter((c) => !c.passed).map((c) => c.details);
  const ready = blockers.length === 0;

  const report: PRReadinessReport = {
    prNumber,
    repo: `${owner}/${repo}`,
    ready,
    checks,
    blockers,
    checkedAt: new Date().toISOString(),
  };

  logActivity({
    source: "board",
    summary: `PR readiness: ${owner}/${repo}#${prNumber} — ${ready ? "ready" : `${blockers.length} blocker(s)`}`,
  });

  return report;
}

/**
 * Format a readiness report as markdown.
 */
export function formatReadinessReport(report: PRReadinessReport): string {
  const lines: string[] = [];
  const statusIcon = report.ready ? "✅" : "⛔";
  lines.push(`## PR Merge Readiness: #${report.prNumber}`);
  lines.push("");
  lines.push(`**Status:** ${statusIcon} ${report.ready ? "Ready to merge" : "Not ready"}`);
  lines.push("");

  lines.push("| Check | Status | Details |");
  lines.push("|-------|--------|---------|");
  for (const check of report.checks) {
    const icon = check.passed ? "✅" : "❌";
    lines.push(`| ${check.name} | ${icon} | ${check.details} |`);
  }

  if (report.blockers.length > 0) {
    lines.push("");
    lines.push("### Blockers");
    for (const b of report.blockers) {
      lines.push(`- ${b}`);
    }
  }

  return lines.join("\n");
}
