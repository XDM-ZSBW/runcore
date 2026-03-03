/**
 * Commit analysis — scan commits for patterns, quality metrics, and issues.
 *
 * Checks: conventional commit format, message quality, commit size,
 * co-authors, breaking changes, and common anti-patterns.
 */

import { createLogger } from "../utils/logger.js";
import { logActivity } from "../activity/log.js";
import * as client from "./client.js";
import type {
  CommitAnalysis,
  CommitQuality,
  CommitPattern,
  CommitIssue,
  CommitQualityTrend,
  AuthorQualitySummary,
} from "./types.js";

const log = createLogger("github.commit-analysis");

// ── Conventional commit parsing ──────────────────────────────────────────────

const CONVENTIONAL_PATTERN = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\(.+?\))?(!)?:\s/;

const PATTERN_MAP: Record<string, CommitPattern> = {
  feat: "feature",
  fix: "bugfix",
  docs: "docs",
  style: "style",
  refactor: "refactor",
  perf: "perf",
  test: "test",
  build: "chore",
  ci: "ci",
  chore: "chore",
  revert: "revert",
};

// ── Analysis helpers ─────────────────────────────────────────────────────────

function detectPatterns(message: string): CommitPattern[] {
  const lower = message.toLowerCase();
  const firstLine = message.split("\n")[0];
  const patterns: CommitPattern[] = [];

  // Check conventional commit format first
  const match = firstLine.match(CONVENTIONAL_PATTERN);
  if (match) {
    const mapped = PATTERN_MAP[match[1]];
    if (mapped) patterns.push(mapped);
    return patterns;
  }

  // Merge commit
  if (lower.startsWith("merge ")) {
    patterns.push("merge");
    return patterns;
  }

  // Heuristic detection
  if (/\bwip\b/i.test(firstLine)) patterns.push("wip");
  if (/\b(fix|bug|patch|hotfix)\b/i.test(firstLine)) patterns.push("bugfix");
  if (/\b(add|feat|feature|implement|new)\b/i.test(firstLine)) patterns.push("feature");
  if (/\b(refactor|restructure|reorganize|clean\s?up)\b/i.test(firstLine)) patterns.push("refactor");
  if (/\b(test|spec|coverage)\b/i.test(firstLine)) patterns.push("test");
  if (/\b(doc|readme|changelog)\b/i.test(firstLine)) patterns.push("docs");
  if (/\b(ci|pipeline|workflow|github.actions)\b/i.test(firstLine)) patterns.push("ci");
  if (/\b(perf|optimize|speed|fast)\b/i.test(firstLine)) patterns.push("perf");
  if (/\brevert\b/i.test(firstLine)) patterns.push("revert");

  if (patterns.length === 0) patterns.push("chore");
  return patterns;
}

function assessMessageQuality(message: string): "good" | "fair" | "poor" {
  const firstLine = message.split("\n")[0].trim();

  // Poor: very short, no context
  if (firstLine.length < 10) return "poor";
  // Poor: generic messages
  if (/^(fix|update|change|wip|stuff|test|asdf|tmp)$/i.test(firstLine)) return "poor";

  // Fair: decent length but no conventional format or structure
  if (firstLine.length < 30 && !CONVENTIONAL_PATTERN.test(firstLine)) return "fair";

  // Good: conventional format or descriptive
  if (CONVENTIONAL_PATTERN.test(firstLine)) return "good";
  if (firstLine.length >= 30) return "good";

  return "fair";
}

function categorizeSizeFromStats(
  additions: number,
  deletions: number,
): "tiny" | "small" | "medium" | "large" | "huge" {
  const total = additions + deletions;
  if (total <= 10) return "tiny";
  if (total <= 50) return "small";
  if (total <= 200) return "medium";
  if (total <= 500) return "large";
  return "huge";
}

function detectIssues(message: string, additions: number, deletions: number): CommitIssue[] {
  const issues: CommitIssue[] = [];
  const firstLine = message.split("\n")[0].trim();

  // Message quality issues
  if (firstLine.length < 5) {
    issues.push({ severity: "warning", message: "Commit message is too short to be meaningful." });
  }

  if (firstLine.length > 72) {
    issues.push({ severity: "info", message: "First line exceeds 72 characters (conventional limit)." });
  }

  if (/^[a-z]/.test(firstLine) && !CONVENTIONAL_PATTERN.test(firstLine)) {
    issues.push({ severity: "info", message: "First line starts with lowercase (not conventional format)." });
  }

  if (firstLine.endsWith(".")) {
    issues.push({ severity: "info", message: "Subject line ends with a period (convention says don't)." });
  }

  // Size issues
  const total = additions + deletions;
  if (total > 1000) {
    issues.push({ severity: "warning", message: `Very large commit (${total} lines). Consider smaller, atomic commits.` });
  }

  // WIP detection
  if (/\bwip\b/i.test(firstLine)) {
    issues.push({ severity: "warning", message: "Commit marked as WIP — should be squashed before merge." });
  }

  // Fixup detection
  if (/^(fixup|squash)!\s/.test(firstLine)) {
    issues.push({ severity: "info", message: "Fixup/squash commit detected — ensure it gets rebased." });
  }

  return issues;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Analyze a single commit by SHA.
 */
export async function analyzeCommit(
  owner: string,
  repo: string,
  sha: string,
): Promise<CommitAnalysis | null> {
  log.info(`Analyzing commit ${owner}/${repo}@${sha.slice(0, 8)}`);

  const commit = await client.getCommit(owner, repo, sha);
  if (!commit) {
    log.warn(`Failed to fetch commit ${sha}`);
    return null;
  }

  return analyzeCommitData(owner, repo, commit.sha, commit.message, commit.stats?.additions ?? 0, commit.stats?.deletions ?? 0);
}

/**
 * Analyze a commit from raw data (avoids API call when data is already available).
 */
export function analyzeCommitData(
  owner: string,
  repo: string,
  sha: string,
  message: string,
  additions: number,
  deletions: number,
): CommitAnalysis {
  const patterns = detectPatterns(message);
  const messageQuality = assessMessageQuality(message);
  const sizeCategory = categorizeSizeFromStats(additions, deletions);
  const isConventional = CONVENTIONAL_PATTERN.test(message.split("\n")[0]);
  const hasCoAuthors = /co-authored-by:/i.test(message);
  const hasBreakingChange = /BREAKING.CHANGE/i.test(message) || /^.+!:/.test(message.split("\n")[0]);

  const quality: CommitQuality = {
    score: computeQualityScore(messageQuality, isConventional, sizeCategory),
    messageQuality,
    hasCoAuthors,
    hasBreakingChange,
    isConventional,
    sizeCategory,
  };

  const issues = detectIssues(message, additions, deletions);

  return {
    sha,
    repo: `${owner}/${repo}`,
    quality,
    patterns,
    issues,
    analyzedAt: new Date().toISOString(),
  };
}

/**
 * Analyze recent commits in a repository.
 */
export async function analyzeRecentCommits(
  owner: string,
  repo: string,
  opts?: { count?: number; since?: string },
): Promise<CommitAnalysis[]> {
  log.info(`Analyzing recent commits for ${owner}/${repo}`);

  const commits = await client.listCommits(owner, repo, {
    per_page: opts?.count ?? 20,
    since: opts?.since,
  });
  if (!commits) return [];

  const results: CommitAnalysis[] = [];
  for (const c of commits) {
    results.push(analyzeCommitData(
      owner,
      repo,
      c.sha,
      c.commit.message,
      0, // List endpoint doesn't include stats
      0,
    ));
  }

  const avgScore = results.length > 0
    ? Math.round(results.reduce((sum, r) => sum + r.quality.score, 0) / results.length)
    : 0;

  logActivity({
    source: "board",
    summary: `Commit analysis: ${results.length} commits in ${owner}/${repo}, avg quality ${avgScore}/100`,
  });

  return results;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Compute quality trend by comparing recent commits against older commits.
 * Fetches commits from the last 30 days and splits them into two halves.
 */
export async function getQualityTrend(
  owner: string,
  repo: string,
  opts?: { days?: number },
): Promise<CommitQualityTrend | null> {
  const days = opts?.days ?? 30;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const commits = await client.listCommits(owner, repo, { since, per_page: 100 });
  if (!commits || commits.length === 0) return null;

  const analyses = commits.map((c) =>
    analyzeCommitData(owner, repo, c.sha, c.commit.message, 0, 0),
  );

  const midpoint = Math.floor(analyses.length / 2);
  const recent = analyses.slice(0, midpoint);
  const older = analyses.slice(midpoint);

  const avgScore = (items: CommitAnalysis[]) =>
    items.length === 0 ? 0 : Math.round(items.reduce((s, a) => s + a.quality.score, 0) / items.length);

  const recentAvg = avgScore(recent);
  const olderAvg = avgScore(older);

  const conventionalCount = analyses.filter((a) => a.quality.isConventional).length;
  const conventionalRate = Math.round((conventionalCount / analyses.length) * 100) / 100;

  // Author breakdown
  const authorMap = new Map<string, { scores: number[]; conventional: number }>();
  for (let i = 0; i < commits.length; i++) {
    const authorName = commits[i].commit.author?.name ?? "unknown";
    const entry = authorMap.get(authorName) ?? { scores: [], conventional: 0 };
    entry.scores.push(analyses[i].quality.score);
    if (analyses[i].quality.isConventional) entry.conventional++;
    authorMap.set(authorName, entry);
  }

  const authorBreakdown: AuthorQualitySummary[] = [...authorMap.entries()]
    .map(([author, data]) => ({
      author,
      commitCount: data.scores.length,
      avgScore: Math.round(data.scores.reduce((s, v) => s + v, 0) / data.scores.length),
      conventionalRate: Math.round((data.conventional / data.scores.length) * 100) / 100,
    }))
    .sort((a, b) => b.commitCount - a.commitCount);

  let direction: "improving" | "stable" | "declining" = "stable";
  if (recentAvg > olderAvg + 5) direction = "improving";
  else if (recentAvg < olderAvg - 5) direction = "declining";

  const trend: CommitQualityTrend = {
    repo: `${owner}/${repo}`,
    period: { from: since, to: new Date().toISOString() },
    recentAvgScore: recentAvg,
    olderAvgScore: olderAvg,
    direction,
    totalAnalyzed: analyses.length,
    conventionalCommitRate: conventionalRate,
    authorBreakdown,
  };

  logActivity({
    source: "board",
    summary: `Commit quality trend: ${owner}/${repo} → ${direction} (recent: ${recentAvg}, older: ${olderAvg})`,
  });

  return trend;
}

function computeQualityScore(
  messageQuality: "good" | "fair" | "poor",
  isConventional: boolean,
  sizeCategory: string,
): number {
  let score = 50;

  // Message quality: +20 good, +10 fair, -10 poor
  if (messageQuality === "good") score += 20;
  else if (messageQuality === "fair") score += 10;
  else score -= 10;

  // Conventional format: +15
  if (isConventional) score += 15;

  // Size: +15 tiny/small, +5 medium, -5 large, -15 huge
  if (sizeCategory === "tiny" || sizeCategory === "small") score += 15;
  else if (sizeCategory === "medium") score += 5;
  else if (sizeCategory === "large") score -= 5;
  else score -= 15;

  return Math.max(0, Math.min(100, score));
}
