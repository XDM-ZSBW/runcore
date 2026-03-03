/**
 * GitHub integration facade — single entry point for all GitHub functionality.
 *
 * Consolidates: API client, webhook handling, PR review, issue triage,
 * commit analysis, and repo health monitoring into one module.
 *
 * Usage:
 *   import { initGitHub, getGitHubStatus } from "./integrations/github.js";
 *   // At startup:
 *   initGitHub();
 *   // In routes:
 *   const status = await getGitHubStatus();
 */

import { createLogger } from "../utils/logger.js";
import { logActivity } from "../activity/log.js";
import { setProviderConfig } from "../webhooks/config.js";
import * as ghClient from "../github/client.js";
import {
  processWebhook,
  verifyWebhookSignature,
  onGitHubEvent,
} from "../github/webhooks.js";
import type { GitHubEventHandler } from "../github/webhooks.js";
import { reviewPR, reviewAndComment } from "../github/pr-review.js";
import { triageIssue, triageAndLabel, triageOpenIssues, setTriageConfig, getTriageConfig, findDuplicates, titleSimilarity } from "../github/issue-triage.js";
import { analyzeCommit, analyzeRecentCommits, analyzeCommitData, getQualityTrend } from "../github/commit-analysis.js";
import { getRepoHealth, formatHealthReport } from "../github/repo-health.js";
import { checkPRReadiness, formatReadinessReport } from "../github/pr-readiness.js";
import { generateReleaseNotes, generateReleaseNotesFromLatestTag, generateReleaseNotesFromCommits } from "../github/release-notes.js";
import { getContributorStats, formatContributorStats } from "../github/contributor-stats.js";
import { getSLAReport, formatSLAReport, setSLAConfig, getSLAConfig } from "../github/issue-sla.js";
import type {
  GitHubConfig,
  GitHubFeatureFlags,
  GitHubUser,
  PRReviewResult,
  PRReadinessReport,
  IssueTriage,
  TriageConfig,
  CommitAnalysis,
  RepoHealthReport,
  ReleaseNotes,
  ContributorStats,
  SLAReport,
  SLAConfig,
  DuplicateCandidate,
  CommitQualityTrend,
} from "../github/types.js";
import type {
  GitHubIssueWebhookPayload,
  GitHubPRWebhookPayload,
  GitHubPushWebhookPayload,
} from "../github/types.js";
import { triageFromIssue } from "../github/issue-triage.js";

const log = createLogger("github");

// ── State ────────────────────────────────────────────────────────────────────

let initialized = false;
let features: GitHubFeatureFlags = {};
let defaultRepo: { owner: string; repo: string } | null = null;

// ── Lifecycle ────────────────────────────────────────────────────────────────

/**
 * Initialize the GitHub integration.
 * Registers webhook provider configuration and sets up event handlers.
 */
export function initGitHub(config?: GitHubConfig): void {
  if (initialized) return;
  initialized = true;

  features = config?.features ?? {};

  // Parse default repo
  if (config?.defaultRepo) {
    const [owner, repo] = config.defaultRepo.split("/");
    if (owner && repo) {
      defaultRepo = { owner, repo };
    }
  }

  // Set API base URL if provided
  if (config?.apiBaseUrl) {
    ghClient.setApiBase(config.apiBaseUrl);
  }

  // Note: webhook provider config is registered in server.ts via setProviderConfigs().
  // Only set it here if initGitHub() is called standalone (e.g., tests).
  // server.ts already handles: registerProviders([githubProvider, ...]) + setProviderConfigs([...])

  // Wire up auto-triage on new issues (if enabled)
  if (features.issueTriage !== false) {
    onGitHubEvent("issues", async (payload) => {
      const p = payload as GitHubIssueWebhookPayload;
      if (p.action !== "opened") return { handled: true, message: "Skipped non-open action" };

      const triage = triageFromIssue(
        p.repository.owner.login,
        p.repository.name,
        p.issue,
      );
      log.info(`Auto-triaged ${p.repository.full_name}#${p.issue.number}: ${triage.category} (${triage.priority})`);
      return { handled: true, message: `Triaged as ${triage.category}` };
    });
  }

  // Wire up auto-review on PR opened/synchronized (if enabled)
  if (features.prReview !== false) {
    onGitHubEvent("pull_request", async (payload) => {
      const p = payload as GitHubPRWebhookPayload;
      if (p.action !== "opened" && p.action !== "synchronize") {
        return { handled: true, message: `Skipped PR action: ${p.action}` };
      }
      // Skip drafts
      if (p.pull_request.draft) {
        return { handled: true, message: "Skipped draft PR" };
      }

      const result = await reviewPR(
        p.repository.owner.login,
        p.repository.name,
        p.pull_request.number,
      );
      if (result) {
        log.info(`Auto-reviewed PR ${p.repository.full_name}#${p.pull_request.number}: ${result.recommendation}`);
      }
      return { handled: true, message: `Auto-reviewed PR #${p.pull_request.number}` };
    });
  }

  // Wire up commit analysis on push (if enabled)
  if (features.commitAnalysis !== false) {
    onGitHubEvent("push", async (payload) => {
      const p = payload as GitHubPushWebhookPayload;
      for (const c of p.commits) {
        analyzeCommitData(
          p.repository.owner.login,
          p.repository.name,
          c.id,
          c.message,
          0,
          0,
        );
      }
      return { handled: true, message: `Analyzed ${p.commits.length} commits` };
    });
  }

  logActivity({ source: "board", summary: "GitHub integration initialized" });
}

/**
 * Shut down the GitHub integration.
 */
export function shutdownGitHub(): void {
  initialized = false;
  features = {};
  defaultRepo = null;
  // Clear auth caches
  cachedUser = null;
  userCachedAt = 0;
  authFailedAt = 0;
  authFailureError = null;
  pendingAuthCheck = null;
  logActivity({ source: "board", summary: "GitHub integration shut down" });
}

// ── Status ───────────────────────────────────────────────────────────────────

export interface GitHubIntegrationStatus {
  available: boolean;
  authenticated: boolean;
  user: { login: string; name: string | null } | null;
  features: GitHubFeatureFlags;
  defaultRepo: string | null;
  error: string | null;
}

let cachedUser: GitHubUser | null = null;
let userCachedAt = 0;
const USER_CACHE_TTL_MS = 30 * 60 * 1000;

// Circuit breaker: cache auth failures to avoid re-trying with a bad token.
// After a failure, wait AUTH_FAILURE_COOLDOWN_MS before retrying.
let authFailedAt = 0;
let authFailureError: string | null = null;
const AUTH_FAILURE_COOLDOWN_MS = 60 * 1000; // 1 minute cooldown after auth failure

// Dedup: prevent multiple simultaneous auth validations.
let pendingAuthCheck: Promise<GitHubUser | null> | null = null;

export async function getGitHubStatus(): Promise<GitHubIntegrationStatus> {
  const repoStr = defaultRepo ? `${defaultRepo.owner}/${defaultRepo.repo}` : null;

  const available = ghClient.isAvailable();
  if (!available) {
    return {
      available: false,
      authenticated: false,
      user: null,
      features,
      defaultRepo: repoStr,
      error: "GITHUB_TOKEN not set",
    };
  }

  const now = Date.now();

  // Return cached user if still fresh
  if (cachedUser && now - userCachedAt < USER_CACHE_TTL_MS) {
    return {
      available: true,
      authenticated: true,
      user: { login: cachedUser.login, name: cachedUser.name },
      features,
      defaultRepo: repoStr,
      error: null,
    };
  }

  // Circuit breaker: if auth failed recently, return cached failure without retrying
  if (authFailedAt && now - authFailedAt < AUTH_FAILURE_COOLDOWN_MS) {
    return {
      available: true,
      authenticated: false,
      user: null,
      features,
      defaultRepo: repoStr,
      error: authFailureError ?? "Authentication failed (cooldown)",
    };
  }

  // Dedup concurrent auth checks — if one is already in flight, join it
  if (!pendingAuthCheck) {
    pendingAuthCheck = ghClient.getAuthenticatedUser().finally(() => {
      pendingAuthCheck = null;
    });
  }
  const user = await pendingAuthCheck;

  if (user) {
    cachedUser = user;
    userCachedAt = now;
    authFailedAt = 0;
    authFailureError = null;
  } else {
    authFailedAt = now;
    authFailureError = "Authentication failed — check GITHUB_TOKEN";
    log.warn(`GitHub auth validation failed, cooldown for ${AUTH_FAILURE_COOLDOWN_MS / 1000}s`);
  }

  return {
    available: true,
    authenticated: !!user,
    user: user ? { login: user.login, name: user.name } : null,
    features,
    defaultRepo: repoStr,
    error: user ? null : authFailureError,
  };
}

export function isGitHubAvailable(): boolean {
  return ghClient.isAvailable();
}

// ── Helper: resolve owner/repo ───────────────────────────────────────────────

function resolveRepo(repoStr?: string): { owner: string; repo: string } | null {
  if (repoStr) {
    const [owner, repo] = repoStr.split("/");
    if (owner && repo) return { owner, repo };
  }
  return defaultRepo;
}

// ── PR Review ────────────────────────────────────────────────────────────────

export async function reviewPullRequest(
  prNumber: number,
  repoStr?: string,
): Promise<PRReviewResult | null> {
  if (features.prReview === false) return null;
  const r = resolveRepo(repoStr);
  if (!r) { log.warn("No repo specified and no default repo configured"); return null; }
  return reviewPR(r.owner, r.repo, prNumber);
}

export async function reviewAndCommentPR(
  prNumber: number,
  repoStr?: string,
): Promise<PRReviewResult | null> {
  if (features.prReview === false) return null;
  const r = resolveRepo(repoStr);
  if (!r) return null;
  return reviewAndComment(r.owner, r.repo, prNumber);
}

// ── Issue Triage ─────────────────────────────────────────────────────────────

export async function triageGitHubIssue(
  issueNumber: number,
  repoStr?: string,
): Promise<IssueTriage | null> {
  if (features.issueTriage === false) return null;
  const r = resolveRepo(repoStr);
  if (!r) return null;
  return triageIssue(r.owner, r.repo, issueNumber);
}

export async function triageAndLabelIssue(
  issueNumber: number,
  repoStr?: string,
): Promise<IssueTriage | null> {
  if (features.issueTriage === false) return null;
  const r = resolveRepo(repoStr);
  if (!r) return null;
  return triageAndLabel(r.owner, r.repo, issueNumber);
}

export async function batchTriageIssues(
  repoStr?: string,
  opts?: { apply?: boolean },
): Promise<IssueTriage[]> {
  if (features.issueTriage === false) return [];
  const r = resolveRepo(repoStr);
  if (!r) return [];
  return triageOpenIssues(r.owner, r.repo, opts);
}

// ── Duplicate Detection ──────────────────────────────────────────────────────

export async function findDuplicateIssues(
  issueNumber: number,
  repoStr?: string,
  opts?: { threshold?: number; maxResults?: number },
): Promise<DuplicateCandidate[]> {
  if (features.issueTriage === false) return [];
  const r = resolveRepo(repoStr);
  if (!r) return [];
  return findDuplicates(r.owner, r.repo, issueNumber, opts);
}

// ── Commit Analysis ──────────────────────────────────────────────────────────

export async function analyzeGitHubCommit(
  sha: string,
  repoStr?: string,
): Promise<CommitAnalysis | null> {
  if (features.commitAnalysis === false) return null;
  const r = resolveRepo(repoStr);
  if (!r) return null;
  return analyzeCommit(r.owner, r.repo, sha);
}

export async function analyzeRecentGitHubCommits(
  repoStr?: string,
  opts?: { count?: number; since?: string },
): Promise<CommitAnalysis[]> {
  if (features.commitAnalysis === false) return [];
  const r = resolveRepo(repoStr);
  if (!r) return [];
  return analyzeRecentCommits(r.owner, r.repo, opts);
}

// ── Commit Quality Trends ────────────────────────────────────────────────────

export async function getCommitQualityTrend(
  repoStr?: string,
  opts?: { days?: number },
): Promise<CommitQualityTrend | null> {
  if (features.commitAnalysis === false) return null;
  const r = resolveRepo(repoStr);
  if (!r) return null;
  return getQualityTrend(r.owner, r.repo, opts);
}

// ── Repo Health ──────────────────────────────────────────────────────────────

export async function getGitHubRepoHealth(
  repoStr?: string,
): Promise<RepoHealthReport | null> {
  if (features.repoHealth === false) return null;
  const r = resolveRepo(repoStr);
  if (!r) return null;
  return getRepoHealth(r.owner, r.repo);
}

// ── PR Merge Readiness ────────────────────────────────────────────────────────

export async function checkPRMergeReadiness(
  prNumber: number,
  repoStr?: string,
): Promise<PRReadinessReport | null> {
  if (features.prReadiness === false) return null;
  const r = resolveRepo(repoStr);
  if (!r) return null;
  return checkPRReadiness(r.owner, r.repo, prNumber);
}

// ── Release Notes ─────────────────────────────────────────────────────────────

export async function generateGitHubReleaseNotes(
  opts: { from: string; to?: string; version?: string },
  repoStr?: string,
): Promise<ReleaseNotes | null> {
  if (features.releaseNotes === false) return null;
  const r = resolveRepo(repoStr);
  if (!r) return null;
  return generateReleaseNotes(r.owner, r.repo, opts);
}

export async function generateReleaseNotesFromTag(
  repoStr?: string,
  opts?: { version?: string },
): Promise<ReleaseNotes | null> {
  if (features.releaseNotes === false) return null;
  const r = resolveRepo(repoStr);
  if (!r) return null;
  return generateReleaseNotesFromLatestTag(r.owner, r.repo, opts);
}

// ── Contributor Stats ─────────────────────────────────────────────────────────

export async function getGitHubContributorStats(
  repoStr?: string,
  opts?: { days?: number },
): Promise<ContributorStats | null> {
  if (features.contributorStats === false) return null;
  const r = resolveRepo(repoStr);
  if (!r) return null;
  return getContributorStats(r.owner, r.repo, opts);
}

// ── Issue SLA ─────────────────────────────────────────────────────────────────

export async function getGitHubSLAReport(
  repoStr?: string,
  opts?: { days?: number },
): Promise<SLAReport | null> {
  if (features.issueSLA === false) return null;
  const r = resolveRepo(repoStr);
  if (!r) return null;
  return getSLAReport(r.owner, r.repo, opts);
}

// ── Re-exports ───────────────────────────────────────────────────────────────

export {
  verifyWebhookSignature,
  processWebhook,
  onGitHubEvent,
  setTriageConfig,
  getTriageConfig,
  formatHealthReport,
  formatReadinessReport,
  formatContributorStats,
  formatSLAReport,
  generateReleaseNotesFromCommits,
  analyzeCommitData,
  titleSimilarity,
  setSLAConfig,
  getSLAConfig,
};

export type {
  GitHubConfig,
  GitHubFeatureFlags,
  GitHubEventHandler,
  PRReviewResult,
  PRReadinessReport,
  IssueTriage,
  TriageConfig,
  CommitAnalysis,
  RepoHealthReport,
  ReleaseNotes,
  ContributorStats,
  SLAReport,
  SLAConfig,
  DuplicateCandidate,
  CommitQualityTrend,
};
