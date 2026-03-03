/**
 * TypeScript interfaces for the GitHub integration.
 *
 * Covers: API client types, webhook payloads, PR review, issue triage,
 * commit analysis, and repo health monitoring.
 */

// ── API Client Types ─────────────────────────────────────────────────────────

export interface GitHubConfig {
  /** GitHub personal access token (or app token). Env: GITHUB_TOKEN. */
  token?: string;
  /** GitHub webhook secret for signature verification. Env: GITHUB_WEBHOOK_SECRET. */
  webhookSecret?: string;
  /** Base URL for GitHub API (defaults to https://api.github.com). */
  apiBaseUrl?: string;
  /** Default owner/repo (e.g., "user/repo"). */
  defaultRepo?: string;
  /** Feature toggles. */
  features?: GitHubFeatureFlags;
}

export interface GitHubFeatureFlags {
  /** Enable PR review automation. Default: true. */
  prReview?: boolean;
  /** Enable issue triage. Default: true. */
  issueTriage?: boolean;
  /** Enable commit analysis. Default: true. */
  commitAnalysis?: boolean;
  /** Enable repo health monitoring. Default: true. */
  repoHealth?: boolean;
  /** Enable webhook processing. Default: true. */
  webhooks?: boolean;
  /** Enable PR merge readiness checks. Default: true. */
  prReadiness?: boolean;
  /** Enable release notes generation. Default: true. */
  releaseNotes?: boolean;
  /** Enable contributor stats. Default: true. */
  contributorStats?: boolean;
  /** Enable issue SLA tracking. Default: true. */
  issueSLA?: boolean;
}

// ── GitHub API Response Types ────────────────────────────────────────────────

export interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string;
  html_url: string;
}

export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  owner: GitHubUser;
  html_url: string;
  description: string | null;
  default_branch: string;
  open_issues_count: number;
  stargazers_count: number;
  forks_count: number;
  created_at: string;
  updated_at: string;
  pushed_at: string;
}

export interface GitHubLabel {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface GitHubMilestone {
  id: number;
  number: number;
  title: string;
  state: "open" | "closed";
  due_on: string | null;
}

export interface GitHubIssue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  labels: GitHubLabel[];
  assignees: GitHubUser[];
  milestone: GitHubMilestone | null;
  user: GitHubUser;
  html_url: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  pull_request?: { url: string };
}

export interface GitHubPullRequest {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  merged_at: string | null;
  labels: GitHubLabel[];
  user: GitHubUser;
  assignees: GitHubUser[];
  requested_reviewers: GitHubUser[];
  html_url: string;
  diff_url: string;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  additions: number;
  deletions: number;
  changed_files: number;
  created_at: string;
  updated_at: string;
  mergeable: boolean | null;
  mergeable_state: string;
}

export interface GitHubPRFile {
  filename: string;
  status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

export interface GitHubCommit {
  sha: string;
  message: string;
  author: { name: string; email: string; date: string } | null;
  committer: { name: string; email: string; date: string } | null;
  html_url: string;
  stats?: { additions: number; deletions: number; total: number };
  files?: GitHubPRFile[];
}

export interface GitHubReview {
  id: number;
  user: GitHubUser;
  body: string | null;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
  submitted_at: string;
  html_url: string;
}

export interface GitHubComment {
  id: number;
  body: string;
  user: GitHubUser;
  created_at: string;
  updated_at: string;
  html_url: string;
}

// ── Webhook Payload Types ────────────────────────────────────────────────────

export interface GitHubWebhookPayload {
  action: string;
  sender: GitHubUser;
  repository: GitHubRepo;
  organization?: { login: string; id: number };
  installation?: { id: number };
}

export interface GitHubPRWebhookPayload extends GitHubWebhookPayload {
  action: "opened" | "closed" | "reopened" | "synchronize" | "edited" | "ready_for_review" | "review_requested";
  number: number;
  pull_request: GitHubPullRequest;
}

export interface GitHubIssueWebhookPayload extends GitHubWebhookPayload {
  action: "opened" | "closed" | "reopened" | "edited" | "labeled" | "unlabeled" | "assigned" | "unassigned";
  issue: GitHubIssue;
}

export interface GitHubPushWebhookPayload extends GitHubWebhookPayload {
  ref: string;
  before: string;
  after: string;
  commits: Array<{
    id: string;
    message: string;
    timestamp: string;
    author: { name: string; email: string; username?: string };
    added: string[];
    removed: string[];
    modified: string[];
  }>;
  head_commit: {
    id: string;
    message: string;
    timestamp: string;
    author: { name: string; email: string; username?: string };
  } | null;
  forced: boolean;
}

export interface GitHubIssueCommentWebhookPayload extends GitHubWebhookPayload {
  action: "created" | "edited" | "deleted";
  issue: GitHubIssue;
  comment: GitHubComment;
}

export interface GitHubPRReviewWebhookPayload extends GitHubWebhookPayload {
  action: "submitted" | "edited" | "dismissed";
  pull_request: GitHubPullRequest;
  review: GitHubReview;
}

// ── PR Review Types ──────────────────────────────────────────────────────────

export interface PRReviewResult {
  prNumber: number;
  repo: string;
  summary: string;
  findings: PRFinding[];
  metrics: PRMetrics;
  recommendation: "approve" | "request_changes" | "comment";
  reviewedAt: string;
}

export interface PRFinding {
  severity: "info" | "warning" | "error";
  category: PRFindingCategory;
  message: string;
  file?: string;
  line?: number;
}

export type PRFindingCategory =
  | "size"
  | "complexity"
  | "testing"
  | "documentation"
  | "security"
  | "convention"
  | "breaking_change";

export interface PRMetrics {
  filesChanged: number;
  additions: number;
  deletions: number;
  hasTests: boolean;
  hasDocChanges: boolean;
  largeFiles: string[];
  binaryFiles: string[];
}

// ── Issue Triage Types ───────────────────────────────────────────────────────

export interface IssueTriage {
  issueNumber: number;
  repo: string;
  category: IssueCategory;
  priority: IssuePriority;
  suggestedLabels: string[];
  suggestedAssignees: string[];
  summary: string;
  triagedAt: string;
}

export type IssueCategory = "bug" | "feature" | "enhancement" | "question" | "documentation" | "maintenance" | "security";

export type IssuePriority = "critical" | "high" | "medium" | "low";

export interface TriageConfig {
  /** Label mappings: keyword → label name. */
  labelRules: Array<{ keywords: string[]; label: string }>;
  /** Priority rules based on content signals. */
  priorityRules: {
    criticalKeywords: string[];
    highKeywords: string[];
  };
  /** Auto-assign by label or path pattern. */
  assigneeRules: Array<{ labels?: string[]; paths?: string[]; assignees: string[] }>;
}

// ── Commit Analysis Types ────────────────────────────────────────────────────

export interface CommitAnalysis {
  sha: string;
  repo: string;
  quality: CommitQuality;
  patterns: CommitPattern[];
  issues: CommitIssue[];
  analyzedAt: string;
}

export interface CommitQuality {
  score: number;
  messageQuality: "good" | "fair" | "poor";
  hasCoAuthors: boolean;
  hasBreakingChange: boolean;
  isConventional: boolean;
  sizeCategory: "tiny" | "small" | "medium" | "large" | "huge";
}

export type CommitPattern =
  | "feature"
  | "bugfix"
  | "refactor"
  | "test"
  | "docs"
  | "chore"
  | "ci"
  | "style"
  | "perf"
  | "revert"
  | "merge"
  | "wip";

export interface CommitIssue {
  severity: "info" | "warning" | "error";
  message: string;
}

// ── Repo Health Types ────────────────────────────────────────────────────────

export interface RepoHealthReport {
  repo: string;
  generatedAt: string;
  overall: HealthGrade;
  metrics: RepoHealthMetrics;
  trends: RepoHealthTrends;
}

export type HealthGrade = "A" | "B" | "C" | "D" | "F";

export interface RepoHealthMetrics {
  /** Commits in the last 30 days. */
  commitFrequency: number;
  /** Average days to close an issue. */
  avgIssueResolutionDays: number;
  /** Average days from PR open to merge. */
  avgPRReviewDays: number;
  /** Number of open issues. */
  openIssues: number;
  /** Number of open PRs. */
  openPRs: number;
  /** Number of stale issues (no activity in 30+ days). */
  staleIssues: number;
  /** Number of stale PRs. */
  stalePRs: number;
  /** Contributors in the last 30 days. */
  activeContributors: number;
  /** Bus factor — number of contributors responsible for 80% of commits. Lower = riskier. */
  busFactor: number;
  /** CI/CD health from GitHub Actions. Null if no workflow runs found. */
  ciHealth: CIHealthMetrics | null;
}

export interface CIHealthMetrics {
  /** Total workflow runs in the period. */
  totalRuns: number;
  /** Number of successful runs. */
  successfulRuns: number;
  /** Success rate as a percentage (0-100). */
  successRate: number;
  /** Average run duration in seconds. Null if no completed runs. */
  avgDurationSeconds: number | null;
  /** Number of distinct failing workflows. */
  failingWorkflows: number;
}

export interface RepoHealthTrends {
  commitTrend: "increasing" | "stable" | "decreasing";
  issueTrend: "improving" | "stable" | "worsening";
  prTrend: "improving" | "stable" | "worsening";
}

// ── GitHub Actions Types ─────────────────────────────────────────────────────

export interface GitHubWorkflowRun {
  id: number;
  name: string | null;
  head_branch: string | null;
  head_sha: string;
  status: "queued" | "in_progress" | "completed" | "waiting" | "requested" | "pending";
  conclusion: "success" | "failure" | "cancelled" | "skipped" | "timed_out" | "action_required" | "neutral" | "stale" | null;
  workflow_id: number;
  html_url: string;
  created_at: string;
  updated_at: string;
  run_started_at: string | null;
  run_attempt: number;
}

export interface GitHubWorkflowRunsResponse {
  total_count: number;
  workflow_runs: GitHubWorkflowRun[];
}

// ── Duplicate Detection Types ────────────────────────────────────────────────

export interface DuplicateCandidate {
  issueNumber: number;
  title: string;
  similarity: number;
  url: string;
}

// ── Commit Quality Trend Types ───────────────────────────────────────────────

export interface CommitQualityTrend {
  repo: string;
  period: { from: string; to: string };
  recentAvgScore: number;
  olderAvgScore: number;
  direction: "improving" | "stable" | "declining";
  totalAnalyzed: number;
  conventionalCommitRate: number;
  authorBreakdown: AuthorQualitySummary[];
}

export interface AuthorQualitySummary {
  author: string;
  commitCount: number;
  avgScore: number;
  conventionalRate: number;
}

// ── PR Merge Readiness Types ─────────────────────────────────────────────────

export interface PRReadinessReport {
  prNumber: number;
  repo: string;
  ready: boolean;
  checks: PRReadinessCheck[];
  blockers: string[];
  checkedAt: string;
}

export interface PRReadinessCheck {
  name: string;
  passed: boolean;
  details: string;
}

// ── Release Notes Types ──────────────────────────────────────────────────────

export interface ReleaseNotes {
  repo: string;
  version: string;
  from: string;
  to: string;
  generatedAt: string;
  sections: ReleaseNotesSection[];
  breakingChanges: string[];
  contributors: string[];
  markdown: string;
}

export interface ReleaseNotesSection {
  title: string;
  icon: string;
  commits: ReleaseNoteEntry[];
}

export interface ReleaseNoteEntry {
  sha: string;
  message: string;
  author: string;
  scope?: string;
}

// ── Contributor Stats Types ──────────────────────────────────────────────────

export interface ContributorStats {
  repo: string;
  period: { from: string; to: string };
  contributors: ContributorProfile[];
  generatedAt: string;
}

export interface ContributorProfile {
  login: string;
  commits: number;
  prsOpened: number;
  prsMerged: number;
  reviewsGiven: number;
  linesAdded: number;
  linesRemoved: number;
}

// ── Issue SLA Types ──────────────────────────────────────────────────────────

export interface SLAConfig {
  targets: Record<IssuePriority, SLATarget>;
}

export interface SLATarget {
  /** Maximum hours for first response. */
  responseHours: number;
  /** Maximum hours for resolution. */
  resolutionHours: number;
}

export interface SLAReport {
  repo: string;
  period: { from: string; to: string };
  generatedAt: string;
  overall: SLACompliance;
  byPriority: Record<IssuePriority, SLACompliance>;
  breaches: SLABreach[];
}

export interface SLACompliance {
  total: number;
  withinSLA: number;
  breached: number;
  complianceRate: number;
}

export interface SLABreach {
  issueNumber: number;
  title: string;
  priority: IssuePriority;
  type: "response" | "resolution";
  targetHours: number;
  actualHours: number;
  url: string;
}

// ── GitHub Check Runs Types ──────────────────────────────────────────────────

export interface GitHubCheckRun {
  id: number;
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: "success" | "failure" | "neutral" | "cancelled" | "skipped" | "timed_out" | "action_required" | null;
  html_url: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface GitHubCheckRunsResponse {
  total_count: number;
  check_runs: GitHubCheckRun[];
}

// ── Branch Comparison Types ──────────────────────────────────────────────────

export interface GitHubCompareResult {
  status: "ahead" | "behind" | "diverged" | "identical";
  ahead_by: number;
  behind_by: number;
  total_commits: number;
  commits: Array<{
    sha: string;
    commit: {
      message: string;
      author: { name: string; email: string; date: string } | null;
    };
    html_url: string;
  }>;
}

// ── Tag Types ────────────────────────────────────────────────────────────────

export interface GitHubTag {
  name: string;
  commit: { sha: string; url: string };
}

// ── Issue Timeline Types ─────────────────────────────────────────────────────

export interface GitHubIssueEvent {
  id: number;
  event: string;
  created_at: string;
  actor: GitHubUser | null;
}
