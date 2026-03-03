/**
 * Tests for the GitHub integration modules.
 *
 * Covers: commit analysis, issue triage, PR review, repo health, webhooks,
 * PR readiness, release notes, contributor stats, and issue SLA.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Stub dependencies before importing modules ──────────────────────────────

vi.mock("../src/utils/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("../src/activity/log.js", () => ({
  logActivity: vi.fn(),
}));

vi.mock("../src/github/client.js", () => ({
  getPullRequest: vi.fn(),
  getPRFiles: vi.fn(),
  getPRReviews: vi.fn(),
  getIssue: vi.fn(),
  listIssues: vi.fn(),
  listPullRequests: vi.fn(),
  listCommits: vi.fn(),
  getCommit: vi.fn(),
  addIssueLabels: vi.fn(),
  addIssueAssignees: vi.fn(),
  addIssueComment: vi.fn(),
  listWorkflowRuns: vi.fn(),
  listCheckRuns: vi.fn(),
  compareBranches: vi.fn(),
  listTags: vi.fn(),
  listIssueEvents: vi.fn(),
  listIssueComments: vi.fn(),
}));

// ── Imports ──────────────────────────────────────────────────────────────────

import { analyzeCommitData } from "../src/github/commit-analysis.js";
import { triageFromIssue, setTriageConfig, getTriageConfig, titleSimilarity } from "../src/github/issue-triage.js";
import { reviewPR } from "../src/github/pr-review.js";
import { formatHealthReport } from "../src/github/repo-health.js";
import { verifyWebhookSignature, processWebhook } from "../src/github/webhooks.js";
import { checkPRReadiness, formatReadinessReport } from "../src/github/pr-readiness.js";
import { generateReleaseNotesFromCommits } from "../src/github/release-notes.js";
import { formatContributorStats } from "../src/github/contributor-stats.js";
import { setSLAConfig, getSLAConfig, formatSLAReport } from "../src/github/issue-sla.js";
import { hmacSha256Hex } from "../src/webhooks/registry.js";
import * as client from "../src/github/client.js";
import type {
  GitHubIssue,
  GitHubPullRequest,
  GitHubPRFile,
  RepoHealthReport,
  PRReadinessReport,
  ContributorStats,
  SLAReport,
  IssuePriority,
} from "../src/github/types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeIssue(overrides: Partial<GitHubIssue> = {}): GitHubIssue {
  return {
    id: 1,
    number: 42,
    title: "Something broke",
    body: "The app crashes on startup",
    state: "open",
    labels: [],
    assignees: [],
    milestone: null,
    user: { id: 1, login: "user", name: "User", avatar_url: "", html_url: "" },
    html_url: "https://github.com/owner/repo/issues/42",
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-01T00:00:00Z",
    closed_at: null,
    ...overrides,
  };
}

function makePR(overrides: Partial<GitHubPullRequest> = {}): GitHubPullRequest {
  return {
    id: 1,
    number: 10,
    title: "Add user authentication module",
    body: "This PR adds JWT-based auth with login/logout endpoints and session management.",
    state: "open",
    draft: false,
    merged: false,
    merged_at: null,
    labels: [],
    user: { id: 1, login: "dev", name: "Dev", avatar_url: "", html_url: "" },
    assignees: [],
    requested_reviewers: [],
    html_url: "https://github.com/owner/repo/pull/10",
    diff_url: "https://github.com/owner/repo/pull/10.diff",
    head: { ref: "feature/auth", sha: "abc123" },
    base: { ref: "main", sha: "def456" },
    additions: 150,
    deletions: 20,
    changed_files: 5,
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-02T00:00:00Z",
    mergeable: true,
    mergeable_state: "clean",
    ...overrides,
  };
}

function makePRFile(overrides: Partial<GitHubPRFile> = {}): GitHubPRFile {
  return {
    filename: "src/auth.ts",
    status: "added",
    additions: 50,
    deletions: 0,
    changes: 50,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Commit Analysis
// ═══════════════════════════════════════════════════════════════════════════════

describe("commit-analysis", () => {
  describe("analyzeCommitData", () => {
    it("detects conventional commit format", () => {
      const result = analyzeCommitData("o", "r", "abc", "feat(auth): add login endpoint", 30, 5);
      expect(result.quality.isConventional).toBe(true);
      expect(result.patterns).toContain("feature");
    });

    it("detects non-conventional commit", () => {
      const result = analyzeCommitData("o", "r", "abc", "Added login endpoint", 30, 5);
      expect(result.quality.isConventional).toBe(false);
    });

    it("detects bugfix pattern from heuristics", () => {
      const result = analyzeCommitData("o", "r", "abc", "Fix crash on login page", 10, 5);
      expect(result.patterns).toContain("bugfix");
    });

    it("detects merge commits", () => {
      const result = analyzeCommitData("o", "r", "abc", "Merge branch 'develop' into main", 0, 0);
      expect(result.patterns).toContain("merge");
    });

    it("detects WIP commits", () => {
      const result = analyzeCommitData("o", "r", "abc", "WIP: half-done feature", 20, 0);
      expect(result.patterns).toContain("wip");
      expect(result.issues.some((i) => i.message.includes("WIP"))).toBe(true);
    });

    it("rates good message quality for conventional commits", () => {
      const result = analyzeCommitData("o", "r", "abc", "fix(api): resolve timeout on large requests", 10, 5);
      expect(result.quality.messageQuality).toBe("good");
    });

    it("rates poor message quality for very short messages", () => {
      const result = analyzeCommitData("o", "r", "abc", "fix", 10, 5);
      expect(result.quality.messageQuality).toBe("poor");
    });

    it("rates fair message quality for medium-length non-conventional", () => {
      const result = analyzeCommitData("o", "r", "abc", "Updated the config", 10, 5);
      expect(result.quality.messageQuality).toBe("fair");
    });

    it("computes correct size categories", () => {
      expect(analyzeCommitData("o", "r", "a", "feat: x", 3, 2).quality.sizeCategory).toBe("tiny");
      expect(analyzeCommitData("o", "r", "a", "feat: x", 30, 10).quality.sizeCategory).toBe("small");
      expect(analyzeCommitData("o", "r", "a", "feat: x", 100, 50).quality.sizeCategory).toBe("medium");
      expect(analyzeCommitData("o", "r", "a", "feat: x", 300, 100).quality.sizeCategory).toBe("large");
      expect(analyzeCommitData("o", "r", "a", "feat: x", 400, 200).quality.sizeCategory).toBe("huge");
    });

    it("detects co-authors", () => {
      const msg = "feat: add feature\n\nCo-Authored-By: Alice <alice@example.com>";
      const result = analyzeCommitData("o", "r", "abc", msg, 10, 5);
      expect(result.quality.hasCoAuthors).toBe(true);
    });

    it("detects breaking changes", () => {
      const msg = "feat!: remove deprecated API";
      const result = analyzeCommitData("o", "r", "abc", msg, 10, 5);
      expect(result.quality.hasBreakingChange).toBe(true);
    });

    it("detects breaking change in body", () => {
      const msg = "refactor: change auth flow\n\nBREAKING CHANGE: removed password-based auth";
      const result = analyzeCommitData("o", "r", "abc", msg, 10, 5);
      expect(result.quality.hasBreakingChange).toBe(true);
    });

    it("flags subject line ending with period", () => {
      const result = analyzeCommitData("o", "r", "abc", "Added new feature.", 10, 5);
      expect(result.issues.some((i) => i.message.includes("period"))).toBe(true);
    });

    it("flags very large commits", () => {
      const result = analyzeCommitData("o", "r", "abc", "feat: big change", 800, 300);
      expect(result.issues.some((i) => i.message.includes("Very large commit"))).toBe(true);
    });

    it("assigns higher quality scores for conventional + small commits", () => {
      const good = analyzeCommitData("o", "r", "a", "feat(auth): add login", 10, 5);
      const bad = analyzeCommitData("o", "r", "a", "fix", 400, 200);
      expect(good.quality.score).toBeGreaterThan(bad.quality.score);
    });

    it("sets repo field correctly", () => {
      const result = analyzeCommitData("owner", "repo", "abc", "feat: test", 0, 0);
      expect(result.repo).toBe("owner/repo");
    });

    it("includes analyzedAt timestamp", () => {
      const result = analyzeCommitData("o", "r", "abc", "feat: test", 0, 0);
      expect(result.analyzedAt).toBeTruthy();
      expect(() => new Date(result.analyzedAt)).not.toThrow();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Issue Triage
// ═══════════════════════════════════════════════════════════════════════════════

describe("issue-triage", () => {
  beforeEach(() => {
    // Reset to default config before each test
    setTriageConfig({});
  });

  describe("triageFromIssue", () => {
    it("classifies bug issues", () => {
      const issue = makeIssue({ title: "Bug: app crashes on login", body: "Error thrown when clicking login" });
      const result = triageFromIssue("o", "r", issue);
      expect(result.category).toBe("bug");
    });

    it("classifies security issues as high priority", () => {
      const issue = makeIssue({ title: "Security vulnerability in auth", body: "XSS injection possible" });
      const result = triageFromIssue("o", "r", issue);
      expect(result.category).toBe("security");
      expect(result.priority).toBe("high");
    });

    it("classifies feature requests", () => {
      const issue = makeIssue({ title: "Feature request: dark mode", body: "Would be nice to have dark mode support" });
      const result = triageFromIssue("o", "r", issue);
      expect(result.category).toBe("feature");
    });

    it("classifies questions", () => {
      const issue = makeIssue({ title: "How to configure auth?", body: "How do I set up OAuth?" });
      const result = triageFromIssue("o", "r", issue);
      expect(result.category).toBe("question");
    });

    it("classifies documentation issues", () => {
      const issue = makeIssue({ title: "Typo in documentation", body: "The docs page has a typo" });
      const result = triageFromIssue("o", "r", issue);
      expect(result.category).toBe("documentation");
    });

    it("classifies maintenance issues", () => {
      const issue = makeIssue({ title: "Refactor auth module", body: "Tech debt cleanup needed" });
      const result = triageFromIssue("o", "r", issue);
      expect(result.category).toBe("maintenance");
    });

    it("defaults to enhancement for unrecognized content", () => {
      const issue = makeIssue({ title: "Improve the dashboard layout", body: "Make it look nicer" });
      const result = triageFromIssue("o", "r", issue);
      expect(result.category).toBe("enhancement");
    });

    it("respects existing bug labels", () => {
      const issue = makeIssue({
        title: "Something happened",
        body: "Details here",
        labels: [{ id: 1, name: "bug", color: "red", description: null }],
      });
      const result = triageFromIssue("o", "r", issue);
      expect(result.category).toBe("bug");
    });

    it("sets critical priority for critical keywords", () => {
      const issue = makeIssue({ title: "Critical: production down", body: "Server not responding" });
      const result = triageFromIssue("o", "r", issue);
      expect(result.priority).toBe("critical");
    });

    it("sets high priority for high keywords", () => {
      const issue = makeIssue({ title: "Bug: regression in login", body: "Login broken after last deploy" });
      const result = triageFromIssue("o", "r", issue);
      expect(result.priority).toBe("high");
    });

    it("sets medium priority for regular bugs", () => {
      const issue = makeIssue({ title: "Minor display issue", body: "The app shows wrong color" });
      // No critical/high keywords, not security, but is a bug (via "issue" keyword? No...)
      // Actually this won't be classified as bug, let me use a proper bug keyword
      const bugIssue = makeIssue({ title: "Error in sidebar", body: "Component throws exception" });
      const result = triageFromIssue("o", "r", bugIssue);
      expect(result.priority).toBe("medium");
    });

    it("sets low priority for enhancements", () => {
      const issue = makeIssue({ title: "Make the logo bigger", body: "I think it would look better" });
      const result = triageFromIssue("o", "r", issue);
      expect(result.priority).toBe("low");
    });

    it("suggests labels based on content", () => {
      const issue = makeIssue({ title: "Performance is slow on mobile", body: "Pages take 5 seconds to load" });
      const result = triageFromIssue("o", "r", issue);
      expect(result.suggestedLabels).toContain("performance");
    });

    it("does not suggest labels that already exist", () => {
      const issue = makeIssue({
        title: "Bug in auth",
        body: "Login fails",
        labels: [{ id: 1, name: "bug", color: "red", description: null }],
      });
      const result = triageFromIssue("o", "r", issue);
      expect(result.suggestedLabels).not.toContain("bug");
    });

    it("handles null body gracefully", () => {
      const issue = makeIssue({ title: "Bug found", body: null });
      const result = triageFromIssue("o", "r", issue);
      expect(result.category).toBe("bug");
    });

    it("includes issue number and repo in result", () => {
      const issue = makeIssue({ number: 99 });
      const result = triageFromIssue("owner", "repo", issue);
      expect(result.issueNumber).toBe(99);
      expect(result.repo).toBe("owner/repo");
    });

    it("includes triagedAt timestamp", () => {
      const issue = makeIssue();
      const result = triageFromIssue("o", "r", issue);
      expect(result.triagedAt).toBeTruthy();
    });
  });

  describe("config", () => {
    it("getTriageConfig returns current config", () => {
      const config = getTriageConfig();
      expect(config.labelRules).toBeDefined();
      expect(config.priorityRules).toBeDefined();
      expect(config.assigneeRules).toBeDefined();
    });

    it("setTriageConfig merges with defaults", () => {
      setTriageConfig({
        assigneeRules: [{ labels: ["bug"], assignees: ["alice"] }],
      });
      const config = getTriageConfig();
      expect(config.assigneeRules).toHaveLength(1);
      expect(config.labelRules.length).toBeGreaterThan(0); // Preserved from defaults
    });

    it("assignee rules are applied when labels match", () => {
      setTriageConfig({
        assigneeRules: [{ labels: ["security"], assignees: ["sec-team"] }],
      });
      const issue = makeIssue({ title: "Security vulnerability found", body: "XSS attack possible" });
      const result = triageFromIssue("o", "r", issue);
      expect(result.suggestedAssignees).toContain("sec-team");
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PR Review (with mocked client)
// ═══════════════════════════════════════════════════════════════════════════════

describe("pr-review", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns null when PR fetch fails", async () => {
    vi.mocked(client.getPullRequest).mockResolvedValue(null);
    vi.mocked(client.getPRFiles).mockResolvedValue(null);

    const result = await reviewPR("owner", "repo", 1);
    expect(result).toBeNull();
  });

  it("produces a review result for a normal PR", async () => {
    const pr = makePR({ additions: 80, deletions: 10, changed_files: 2 });
    const files: GitHubPRFile[] = [
      makePRFile({ filename: "src/auth.ts", additions: 60, deletions: 5, changes: 65 }),
      makePRFile({ filename: "test/auth.test.ts", additions: 20, deletions: 5, changes: 25 }),
    ];

    vi.mocked(client.getPullRequest).mockResolvedValue(pr);
    vi.mocked(client.getPRFiles).mockResolvedValue(files);

    const result = await reviewPR("owner", "repo", 10);
    expect(result).not.toBeNull();
    expect(result!.prNumber).toBe(10);
    expect(result!.repo).toBe("owner/repo");
    expect(result!.metrics.hasTests).toBe(true);
    expect(result!.metrics.filesChanged).toBe(2);
    expect(result!.reviewedAt).toBeTruthy();
  });

  it("warns on large PRs", async () => {
    const pr = makePR({ additions: 800, deletions: 300, changed_files: 25 });
    const files: GitHubPRFile[] = [
      makePRFile({ filename: "src/big.ts", additions: 800, deletions: 300, changes: 1100 }),
    ];

    vi.mocked(client.getPullRequest).mockResolvedValue(pr);
    vi.mocked(client.getPRFiles).mockResolvedValue(files);

    const result = await reviewPR("owner", "repo", 10);
    expect(result).not.toBeNull();
    expect(result!.findings.some((f) => f.category === "size")).toBe(true);
    expect(result!.recommendation).not.toBe("approve");
  });

  it("warns when source files changed but no tests", async () => {
    const pr = makePR({ additions: 50, deletions: 10, changed_files: 2 });
    const files: GitHubPRFile[] = [
      makePRFile({ filename: "src/auth.ts", additions: 50, deletions: 10, changes: 60 }),
    ];

    vi.mocked(client.getPullRequest).mockResolvedValue(pr);
    vi.mocked(client.getPRFiles).mockResolvedValue(files);

    const result = await reviewPR("owner", "repo", 10);
    expect(result).not.toBeNull();
    expect(result!.findings.some((f) => f.category === "testing")).toBe(true);
    expect(result!.metrics.hasTests).toBe(false);
  });

  it("detects security patterns in diffs", async () => {
    const pr = makePR({ additions: 10, deletions: 0, changed_files: 1 });
    const files: GitHubPRFile[] = [
      makePRFile({
        filename: "src/config.ts",
        additions: 10,
        deletions: 0,
        changes: 10,
        patch: `@@ -1,3 +1,5 @@\n+const API_KEY = "sk-1234567890";\n+const password = "hunter2";`,
      }),
    ];

    vi.mocked(client.getPullRequest).mockResolvedValue(pr);
    vi.mocked(client.getPRFiles).mockResolvedValue(files);

    const result = await reviewPR("owner", "repo", 10);
    expect(result).not.toBeNull();
    expect(result!.findings.some((f) => f.category === "security")).toBe(true);
  });

  it("flags short PR title", async () => {
    const pr = makePR({ title: "Fix", additions: 5, deletions: 2, changed_files: 1 });
    const files: GitHubPRFile[] = [
      makePRFile({ filename: "src/fix.ts", additions: 5, deletions: 2, changes: 7 }),
    ];

    vi.mocked(client.getPullRequest).mockResolvedValue(pr);
    vi.mocked(client.getPRFiles).mockResolvedValue(files);

    const result = await reviewPR("owner", "repo", 10);
    expect(result).not.toBeNull();
    expect(result!.findings.some((f) => f.category === "convention")).toBe(true);
  });

  it("flags WIP in title when not draft", async () => {
    const pr = makePR({ title: "WIP: work in progress feature", draft: false, additions: 20, deletions: 5, changed_files: 2 });
    const files: GitHubPRFile[] = [
      makePRFile({ filename: "src/wip.ts", additions: 20, deletions: 5, changes: 25 }),
    ];

    vi.mocked(client.getPullRequest).mockResolvedValue(pr);
    vi.mocked(client.getPRFiles).mockResolvedValue(files);

    const result = await reviewPR("owner", "repo", 10);
    expect(result).not.toBeNull();
    expect(result!.findings.some((f) => f.message.includes("WIP") && f.message.includes("draft"))).toBe(true);
  });

  it("detects dependency manifest changes without lock file", async () => {
    const pr = makePR({ additions: 5, deletions: 2, changed_files: 1 });
    const files: GitHubPRFile[] = [
      makePRFile({ filename: "package.json", status: "modified", additions: 5, deletions: 2, changes: 7, patch: "+\"new-dep\": \"^1.0.0\"" }),
    ];

    vi.mocked(client.getPullRequest).mockResolvedValue(pr);
    vi.mocked(client.getPRFiles).mockResolvedValue(files);

    const result = await reviewPR("owner", "repo", 10);
    expect(result).not.toBeNull();
    expect(result!.findings.some((f) => f.message.includes("Dependency manifest") || f.message.includes("lock file"))).toBe(true);
  });

  it("detects lock file changes", async () => {
    const pr = makePR({ additions: 102, deletions: 52, changed_files: 2 });
    const files: GitHubPRFile[] = [
      makePRFile({ filename: "package.json", status: "modified", additions: 2, deletions: 1, changes: 3 }),
      makePRFile({ filename: "package-lock.json", status: "modified", additions: 100, deletions: 50, changes: 150 }),
    ];

    vi.mocked(client.getPullRequest).mockResolvedValue(pr);
    vi.mocked(client.getPRFiles).mockResolvedValue(files);

    const result = await reviewPR("owner", "repo", 10);
    expect(result).not.toBeNull();
    expect(result!.findings.some((f) => f.message.includes("Lock file"))).toBe(true);
  });

  it("detects breaking changes from deleted source files", async () => {
    const pr = makePR({ additions: 0, deletions: 50, changed_files: 1 });
    const files: GitHubPRFile[] = [
      makePRFile({ filename: "src/old-api.ts", status: "removed", additions: 0, deletions: 50, changes: 50 }),
    ];

    vi.mocked(client.getPullRequest).mockResolvedValue(pr);
    vi.mocked(client.getPRFiles).mockResolvedValue(files);

    const result = await reviewPR("owner", "repo", 10);
    expect(result).not.toBeNull();
    expect(result!.findings.some((f) => f.category === "breaking_change")).toBe(true);
  });

  it("detects breaking changes from removed exports", async () => {
    const pr = makePR({ additions: 5, deletions: 15, changed_files: 1 });
    const files: GitHubPRFile[] = [
      makePRFile({
        filename: "src/api.ts",
        status: "modified",
        additions: 5,
        deletions: 15,
        changes: 20,
        patch: "- export function oldEndpoint() {}\n- export const config = {};\n+ // cleaned up",
      }),
    ];

    vi.mocked(client.getPullRequest).mockResolvedValue(pr);
    vi.mocked(client.getPRFiles).mockResolvedValue(files);

    const result = await reviewPR("owner", "repo", 10);
    expect(result).not.toBeNull();
    expect(result!.findings.some((f) => f.category === "breaking_change" && f.message.includes("export"))).toBe(true);
  });

  it("detects renamed files as potential breaking changes", async () => {
    const pr = makePR({ additions: 0, deletions: 0, changed_files: 1 });
    const files: GitHubPRFile[] = [
      makePRFile({ filename: "src/new-name.ts", status: "renamed", additions: 0, deletions: 0, changes: 0 }),
    ];

    vi.mocked(client.getPullRequest).mockResolvedValue(pr);
    vi.mocked(client.getPRFiles).mockResolvedValue(files);

    const result = await reviewPR("owner", "repo", 10);
    expect(result).not.toBeNull();
    expect(result!.findings.some((f) => f.category === "breaking_change" && f.message.includes("renamed"))).toBe(true);
  });

  it("flags stale PRs open for more than 14 days", async () => {
    const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
    const pr = makePR({ created_at: fifteenDaysAgo, additions: 10, deletions: 5, changed_files: 1 });
    const files: GitHubPRFile[] = [
      makePRFile({ filename: "src/feature.ts", additions: 10, deletions: 5, changes: 15 }),
    ];

    vi.mocked(client.getPullRequest).mockResolvedValue(pr);
    vi.mocked(client.getPRFiles).mockResolvedValue(files);

    const result = await reviewPR("owner", "repo", 10);
    expect(result).not.toBeNull();
    expect(result!.findings.some((f) => f.message.includes("open for"))).toBe(true);
  });

  it("flags empty PR body", async () => {
    const pr = makePR({ body: "", additions: 10, deletions: 0, changed_files: 1 });
    const files: GitHubPRFile[] = [
      makePRFile({ filename: "src/feature.ts", additions: 10, deletions: 0, changes: 10 }),
    ];

    vi.mocked(client.getPullRequest).mockResolvedValue(pr);
    vi.mocked(client.getPRFiles).mockResolvedValue(files);

    const result = await reviewPR("owner", "repo", 10);
    expect(result).not.toBeNull();
    expect(result!.findings.some((f) => f.category === "documentation")).toBe(true);
  });

  it("detects binary files", async () => {
    const pr = makePR({ additions: 10, deletions: 0, changed_files: 2 });
    const files: GitHubPRFile[] = [
      makePRFile({ filename: "src/code.ts", additions: 10, deletions: 0, changes: 10 }),
      makePRFile({ filename: "assets/logo.png", status: "added", additions: 0, deletions: 0, changes: 0 }),
    ];

    vi.mocked(client.getPullRequest).mockResolvedValue(pr);
    vi.mocked(client.getPRFiles).mockResolvedValue(files);

    const result = await reviewPR("owner", "repo", 10);
    expect(result).not.toBeNull();
    expect(result!.metrics.binaryFiles).toContain("assets/logo.png");
    expect(result!.findings.some((f) => f.message.includes("binary"))).toBe(true);
  });

  it("includes summary in markdown format", async () => {
    const pr = makePR();
    const files: GitHubPRFile[] = [makePRFile()];

    vi.mocked(client.getPullRequest).mockResolvedValue(pr);
    vi.mocked(client.getPRFiles).mockResolvedValue(files);

    const result = await reviewPR("owner", "repo", 10);
    expect(result).not.toBeNull();
    expect(result!.summary).toContain("## Automated PR Review");
    expect(result!.summary).toContain("Recommendation");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Duplicate Detection (titleSimilarity)
// ═══════════════════════════════════════════════════════════════════════════════

describe("duplicate-detection", () => {
  describe("titleSimilarity", () => {
    it("returns 1 for identical titles", () => {
      expect(titleSimilarity("Fix login bug", "Fix login bug")).toBe(1);
    });

    it("returns high similarity for similar titles", () => {
      const sim = titleSimilarity(
        "Fix login page crash on submit",
        "Fix login page error on submit",
      );
      expect(sim).toBeGreaterThan(0.5);
    });

    it("returns low similarity for unrelated titles", () => {
      const sim = titleSimilarity(
        "Add dark mode theme support",
        "Fix database connection timeout errors",
      );
      expect(sim).toBeLessThan(0.3);
    });

    it("returns 0 for empty strings", () => {
      expect(titleSimilarity("", "something")).toBe(0);
      expect(titleSimilarity("something", "")).toBe(0);
      expect(titleSimilarity("", "")).toBe(0);
    });

    it("is case insensitive", () => {
      expect(titleSimilarity("Fix Bug Report", "fix bug report")).toBe(1);
    });

    it("ignores punctuation", () => {
      const sim = titleSimilarity("Bug: login crashes!", "Bug login crashes");
      expect(sim).toBe(1);
    });

    it("ignores very short words", () => {
      // "a", "to", "in" are all <=2 chars, stripped
      const sim = titleSimilarity("fix a bug in login", "fix the bug with login");
      expect(sim).toBeGreaterThan(0.5);
    });

    it("handles single significant word", () => {
      const sim = titleSimilarity("authentication", "authentication");
      expect(sim).toBe(1);
    });

    it("returns 0 when only short words remain", () => {
      // "a" and "it" are <=2 chars, both become empty
      expect(titleSimilarity("a", "it")).toBe(0);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Repo Health (formatHealthReport)
// ═══════════════════════════════════════════════════════════════════════════════

describe("repo-health", () => {
  describe("formatHealthReport", () => {
    it("produces valid markdown report", () => {
      const report: RepoHealthReport = {
        repo: "owner/repo",
        generatedAt: "2025-06-01T00:00:00Z",
        overall: "B",
        metrics: {
          commitFrequency: 15,
          avgIssueResolutionDays: 5.2,
          avgPRReviewDays: 2.1,
          openIssues: 8,
          openPRs: 3,
          staleIssues: 2,
          stalePRs: 0,
          activeContributors: 4,
          busFactor: 2,
          ciHealth: { totalRuns: 50, successfulRuns: 45, successRate: 90, avgDurationSeconds: 120, failingWorkflows: 1 },
        },
        trends: {
          commitTrend: "stable",
          issueTrend: "improving",
          prTrend: "improving",
        },
      };

      const md = formatHealthReport(report);
      expect(md).toContain("## Repository Health Report: owner/repo");
      expect(md).toContain("Overall Grade: B");
      expect(md).toContain("Commits (30d) | 15");
      expect(md).toContain("Active contributors | 4");
      expect(md).toContain("Open issues | 8");
      expect(md).toContain("Open PRs | 3");
      expect(md).toContain("Stale issues | 2");
      expect(md).toContain("Avg issue resolution | 5.2d");
      expect(md).toContain("Avg PR review time | 2.1d");
      expect(md).toContain("Bus factor | 2");
      expect(md).toContain("CI success rate | 90%");
      expect(md).toContain("CI runs (30d) | 50");
      expect(md).toContain("Failing workflows | 1");
      expect(md).toContain("Commits: stable");
      expect(md).toContain("Issues: improving");
      expect(md).toContain("PRs: improving");
    });

    it("includes all grade levels in output", () => {
      const makeReport = (grade: string): RepoHealthReport => ({
        repo: "o/r",
        generatedAt: new Date().toISOString(),
        overall: grade as RepoHealthReport["overall"],
        metrics: {
          commitFrequency: 0,
          avgIssueResolutionDays: 0,
          avgPRReviewDays: 0,
          openIssues: 0,
          openPRs: 0,
          staleIssues: 0,
          stalePRs: 0,
          activeContributors: 0,
          busFactor: 0,
          ciHealth: null,
        },
        trends: { commitTrend: "stable", issueTrend: "stable", prTrend: "stable" },
      });

      for (const grade of ["A", "B", "C", "D", "F"]) {
        const md = formatHealthReport(makeReport(grade));
        expect(md).toContain(`Overall Grade: ${grade}`);
      }
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Webhooks
// ═══════════════════════════════════════════════════════════════════════════════

describe("github-webhooks", () => {
  describe("verifyWebhookSignature", () => {
    it("verifies a valid GitHub signature", () => {
      const body = '{"action":"opened"}';
      const secret = "webhook-secret";
      const sig = `sha256=${hmacSha256Hex(body, secret)}`;
      expect(verifyWebhookSignature(body, sig, secret)).toBe(true);
    });

    it("rejects an invalid signature", () => {
      expect(verifyWebhookSignature("body", "sha256=wrong", "secret")).toBe(false);
    });

    it("handles signatures without sha256= prefix", () => {
      const body = '{"test":true}';
      const secret = "s";
      const sig = hmacSha256Hex(body, secret);
      expect(verifyWebhookSignature(body, sig, secret)).toBe(true);
    });
  });

  describe("processWebhook", () => {
    const mockRepo = {
      id: 1, name: "repo", full_name: "owner/repo",
      owner: { id: 1, login: "owner", name: "Owner", avatar_url: "", html_url: "" },
      html_url: "", description: null, default_branch: "main",
      open_issues_count: 0, stargazers_count: 0, forks_count: 0,
      created_at: "", updated_at: "", pushed_at: "",
    };
    const mockSender = { id: 1, login: "user", name: "User", avatar_url: "", html_url: "" };

    it("handles ping event", async () => {
      const result = await processWebhook("ping", { action: "ping", sender: mockSender, repository: mockRepo });
      expect(result.handled).toBe(true);
      expect(result.message).toBe("Pong");
    });

    it("handles pull_request event", async () => {
      const payload = {
        action: "opened",
        number: 5,
        pull_request: makePR({ number: 5 }),
        sender: mockSender,
        repository: mockRepo,
      };
      const result = await processWebhook("pull_request", payload);
      expect(result.handled).toBe(true);
      expect(result.message).toContain("PR opened");
    });

    it("handles issues event", async () => {
      const payload = {
        action: "opened",
        issue: makeIssue({ number: 7 }),
        sender: mockSender,
        repository: mockRepo,
      };
      const result = await processWebhook("issues", payload);
      expect(result.handled).toBe(true);
      expect(result.message).toContain("Issue opened");
    });

    it("handles push event", async () => {
      const payload = {
        action: "push",
        ref: "refs/heads/main",
        before: "aaa",
        after: "bbb",
        commits: [
          { id: "c1", message: "feat: add thing", timestamp: "", author: { name: "Dev", email: "dev@x.com" }, added: [], removed: [], modified: [] },
        ],
        head_commit: { id: "c1", message: "feat: add thing", timestamp: "", author: { name: "Dev", email: "dev@x.com" } },
        forced: false,
        sender: mockSender,
        repository: mockRepo,
      };
      const result = await processWebhook("push", payload);
      expect(result.handled).toBe(true);
      expect(result.message).toContain("1 commits to main");
    });

    it("returns unhandled for unknown event types", async () => {
      const result = await processWebhook("deployment", { action: "created", sender: mockSender, repository: mockRepo });
      expect(result.handled).toBe(false);
      expect(result.message).toContain("Unhandled");
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PR Merge Readiness
// ═══════════════════════════════════════════════════════════════════════════════

describe("pr-readiness", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns null when PR fetch fails", async () => {
    vi.mocked(client.getPullRequest).mockResolvedValue(null);
    const result = await checkPRReadiness("owner", "repo", 1);
    expect(result).toBeNull();
  });

  it("reports not ready for closed PRs", async () => {
    const pr = makePR({ state: "closed" });
    vi.mocked(client.getPullRequest).mockResolvedValue(pr);

    const result = await checkPRReadiness("owner", "repo", 10);
    expect(result).not.toBeNull();
    expect(result!.ready).toBe(false);
    expect(result!.blockers[0]).toContain("closed");
  });

  it("reports not ready for draft PRs", async () => {
    const pr = makePR({ draft: true });
    vi.mocked(client.getPullRequest).mockResolvedValue(pr);
    vi.mocked(client.listCheckRuns).mockResolvedValue({ total_count: 0, check_runs: [] });
    vi.mocked(client.getPRReviews).mockResolvedValue([]);
    vi.mocked(client.compareBranches).mockResolvedValue(null);

    const result = await checkPRReadiness("owner", "repo", 10);
    expect(result).not.toBeNull();
    expect(result!.ready).toBe(false);
    expect(result!.checks.some((c) => c.name === "Draft status" && !c.passed)).toBe(true);
  });

  it("reports not ready when CI checks are failing", async () => {
    const pr = makePR();
    vi.mocked(client.getPullRequest).mockResolvedValue(pr);
    vi.mocked(client.listCheckRuns).mockResolvedValue({
      total_count: 2,
      check_runs: [
        { id: 1, name: "build", status: "completed", conclusion: "success", html_url: "", started_at: null, completed_at: null },
        { id: 2, name: "test", status: "completed", conclusion: "failure", html_url: "", started_at: null, completed_at: null },
      ],
    });
    vi.mocked(client.getPRReviews).mockResolvedValue([]);
    vi.mocked(client.compareBranches).mockResolvedValue(null);

    const result = await checkPRReadiness("owner", "repo", 10);
    expect(result).not.toBeNull();
    expect(result!.ready).toBe(false);
    expect(result!.checks.some((c) => c.name === "CI checks" && !c.passed)).toBe(true);
    expect(result!.checks.find((c) => c.name === "CI checks")!.details).toContain("test");
  });

  it("reports not ready when CI checks are still running", async () => {
    const pr = makePR();
    vi.mocked(client.getPullRequest).mockResolvedValue(pr);
    vi.mocked(client.listCheckRuns).mockResolvedValue({
      total_count: 1,
      check_runs: [
        { id: 1, name: "build", status: "in_progress", conclusion: null, html_url: "", started_at: null, completed_at: null },
      ],
    });
    vi.mocked(client.getPRReviews).mockResolvedValue([]);
    vi.mocked(client.compareBranches).mockResolvedValue(null);

    const result = await checkPRReadiness("owner", "repo", 10);
    expect(result).not.toBeNull();
    expect(result!.checks.some((c) => c.name === "CI checks" && !c.passed)).toBe(true);
    expect(result!.checks.find((c) => c.name === "CI checks")!.details).toContain("still running");
  });

  it("reports not ready when no review approvals", async () => {
    const pr = makePR();
    vi.mocked(client.getPullRequest).mockResolvedValue(pr);
    vi.mocked(client.listCheckRuns).mockResolvedValue({ total_count: 0, check_runs: [] });
    vi.mocked(client.getPRReviews).mockResolvedValue([]);
    vi.mocked(client.compareBranches).mockResolvedValue(null);

    const result = await checkPRReadiness("owner", "repo", 10);
    expect(result).not.toBeNull();
    expect(result!.checks.some((c) => c.name === "Review approvals" && !c.passed)).toBe(true);
  });

  it("reports not ready when changes are requested", async () => {
    const pr = makePR();
    vi.mocked(client.getPullRequest).mockResolvedValue(pr);
    vi.mocked(client.listCheckRuns).mockResolvedValue({ total_count: 0, check_runs: [] });
    vi.mocked(client.getPRReviews).mockResolvedValue([
      { id: 1, user: { id: 2, login: "reviewer", name: "Reviewer", avatar_url: "", html_url: "" }, body: "needs work", state: "CHANGES_REQUESTED", submitted_at: "", html_url: "" },
    ]);
    vi.mocked(client.compareBranches).mockResolvedValue(null);

    const result = await checkPRReadiness("owner", "repo", 10);
    expect(result).not.toBeNull();
    expect(result!.checks.some((c) => c.name === "Review approvals" && !c.passed)).toBe(true);
    expect(result!.checks.find((c) => c.name === "Review approvals")!.details).toContain("requested changes");
  });

  it("reports ready when all checks pass", async () => {
    const pr = makePR({ mergeable: true });
    vi.mocked(client.getPullRequest).mockResolvedValue(pr);
    vi.mocked(client.listCheckRuns).mockResolvedValue({
      total_count: 1,
      check_runs: [
        { id: 1, name: "build", status: "completed", conclusion: "success", html_url: "", started_at: null, completed_at: null },
      ],
    });
    vi.mocked(client.getPRReviews).mockResolvedValue([
      { id: 1, user: { id: 2, login: "reviewer", name: "Reviewer", avatar_url: "", html_url: "" }, body: "LGTM", state: "APPROVED", submitted_at: "", html_url: "" },
    ]);
    vi.mocked(client.compareBranches).mockResolvedValue({
      status: "identical",
      ahead_by: 0,
      behind_by: 0,
      total_commits: 0,
      commits: [],
    });

    const result = await checkPRReadiness("owner", "repo", 10);
    expect(result).not.toBeNull();
    expect(result!.ready).toBe(true);
    expect(result!.blockers).toHaveLength(0);
  });

  it("detects merge conflicts", async () => {
    const pr = makePR({ mergeable: false });
    vi.mocked(client.getPullRequest).mockResolvedValue(pr);
    vi.mocked(client.listCheckRuns).mockResolvedValue({ total_count: 0, check_runs: [] });
    vi.mocked(client.getPRReviews).mockResolvedValue([]);
    vi.mocked(client.compareBranches).mockResolvedValue(null);

    const result = await checkPRReadiness("owner", "repo", 10);
    expect(result).not.toBeNull();
    expect(result!.checks.some((c) => c.name === "Merge conflicts" && !c.passed)).toBe(true);
  });

  it("detects outdated branch", async () => {
    const pr = makePR();
    vi.mocked(client.getPullRequest).mockResolvedValue(pr);
    vi.mocked(client.listCheckRuns).mockResolvedValue({ total_count: 0, check_runs: [] });
    vi.mocked(client.getPRReviews).mockResolvedValue([]);
    vi.mocked(client.compareBranches).mockResolvedValue({
      status: "behind",
      ahead_by: 0,
      behind_by: 5,
      total_commits: 5,
      commits: [],
    });

    const result = await checkPRReadiness("owner", "repo", 10);
    expect(result).not.toBeNull();
    expect(result!.checks.some((c) => c.name === "Branch freshness" && !c.passed)).toBe(true);
    expect(result!.checks.find((c) => c.name === "Branch freshness")!.details).toContain("5 commit(s) behind");
  });

  describe("formatReadinessReport", () => {
    it("formats a ready report", () => {
      const report: PRReadinessReport = {
        prNumber: 10,
        repo: "owner/repo",
        ready: true,
        checks: [
          { name: "Draft status", passed: true, details: "PR is not a draft." },
          { name: "CI checks", passed: true, details: "All 2 check(s) passed." },
        ],
        blockers: [],
        checkedAt: new Date().toISOString(),
      };
      const md = formatReadinessReport(report);
      expect(md).toContain("Ready to merge");
      expect(md).toContain("Draft status");
      expect(md).toContain("CI checks");
    });

    it("formats a not-ready report with blockers", () => {
      const report: PRReadinessReport = {
        prNumber: 10,
        repo: "owner/repo",
        ready: false,
        checks: [
          { name: "CI checks", passed: false, details: "1 check(s) failed: test." },
        ],
        blockers: ["1 check(s) failed: test."],
        checkedAt: new Date().toISOString(),
      };
      const md = formatReadinessReport(report);
      expect(md).toContain("Not ready");
      expect(md).toContain("Blockers");
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Release Notes
// ═══════════════════════════════════════════════════════════════════════════════

describe("release-notes", () => {
  describe("generateReleaseNotesFromCommits", () => {
    it("groups conventional commits into sections", () => {
      const commits = [
        { sha: "aaa1111", message: "feat(auth): add login endpoint", author: "Alice" },
        { sha: "bbb2222", message: "fix(api): resolve timeout on requests", author: "Bob" },
        { sha: "ccc3333", message: "docs: update README", author: "Alice" },
        { sha: "ddd4444", message: "chore: bump dependencies", author: "Charlie" },
      ];

      const notes = generateReleaseNotesFromCommits("owner/repo", "v1.0.0", commits);

      expect(notes.version).toBe("v1.0.0");
      expect(notes.repo).toBe("owner/repo");
      expect(notes.sections.length).toBeGreaterThanOrEqual(3);

      const featureSection = notes.sections.find((s) => s.title === "Features");
      expect(featureSection).toBeDefined();
      expect(featureSection!.commits).toHaveLength(1);
      expect(featureSection!.commits[0].scope).toBe("auth");

      const fixSection = notes.sections.find((s) => s.title === "Bug Fixes");
      expect(fixSection).toBeDefined();
      expect(fixSection!.commits).toHaveLength(1);

      const docSection = notes.sections.find((s) => s.title === "Documentation");
      expect(docSection).toBeDefined();
    });

    it("detects breaking changes", () => {
      const commits = [
        { sha: "aaa1111", message: "feat!: remove deprecated API", author: "Alice" },
        { sha: "bbb2222", message: "refactor: change auth flow\n\nBREAKING CHANGE: removed password auth", author: "Bob" },
      ];

      const notes = generateReleaseNotesFromCommits("owner/repo", "v2.0.0", commits);
      expect(notes.breakingChanges.length).toBeGreaterThanOrEqual(1);
      expect(notes.markdown).toContain("Breaking Changes");
    });

    it("collects unique contributors", () => {
      const commits = [
        { sha: "aaa1111", message: "feat: add feature A", author: "Alice" },
        { sha: "bbb2222", message: "feat: add feature B", author: "Bob" },
        { sha: "ccc3333", message: "fix: fix feature A", author: "Alice" },
      ];

      const notes = generateReleaseNotesFromCommits("owner/repo", "v1.0.0", commits);
      expect(notes.contributors).toHaveLength(2);
      expect(notes.contributors).toContain("Alice");
      expect(notes.contributors).toContain("Bob");
    });

    it("skips merge commits", () => {
      const commits = [
        { sha: "aaa1111", message: "Merge branch 'develop' into main", author: "CI" },
        { sha: "bbb2222", message: "feat: add feature", author: "Alice" },
      ];

      const notes = generateReleaseNotesFromCommits("owner/repo", "v1.0.0", commits);
      expect(notes.contributors).not.toContain("CI");
      expect(notes.sections.length).toBe(1);
    });

    it("categorizes non-conventional commits by keywords", () => {
      const commits = [
        { sha: "aaa1111", message: "Fix the login bug", author: "Alice" },
        { sha: "bbb2222", message: "Add new dashboard", author: "Bob" },
      ];

      const notes = generateReleaseNotesFromCommits("owner/repo", "v1.0.0", commits);
      const fixSection = notes.sections.find((s) => s.title === "Bug Fixes");
      const featureSection = notes.sections.find((s) => s.title === "Features");
      expect(fixSection).toBeDefined();
      expect(featureSection).toBeDefined();
    });

    it("handles empty commit list", () => {
      const notes = generateReleaseNotesFromCommits("owner/repo", "v1.0.0", []);
      expect(notes.sections).toHaveLength(0);
      expect(notes.contributors).toHaveLength(0);
      expect(notes.breakingChanges).toHaveLength(0);
    });

    it("produces valid markdown", () => {
      const commits = [
        { sha: "aaa1111", message: "feat(ui): add dark mode", author: "Alice" },
        { sha: "bbb2222", message: "fix: resolve crash", author: "Bob" },
      ];

      const notes = generateReleaseNotesFromCommits("owner/repo", "v1.2.0", commits);
      expect(notes.markdown).toContain("## v1.2.0");
      expect(notes.markdown).toContain("Features");
      expect(notes.markdown).toContain("Bug Fixes");
      expect(notes.markdown).toContain("Contributors");
      expect(notes.markdown).toContain("@Alice");
    });

    it("includes scope in formatted output", () => {
      const commits = [
        { sha: "aaa1111", message: "feat(auth): add login", author: "Alice" },
      ];

      const notes = generateReleaseNotesFromCommits("owner/repo", "v1.0.0", commits);
      expect(notes.markdown).toContain("**auth:**");
    });

    it("includes short SHA in entries", () => {
      const commits = [
        { sha: "abcdef1234567890", message: "feat: add feature", author: "Alice" },
      ];

      const notes = generateReleaseNotesFromCommits("owner/repo", "v1.0.0", commits);
      expect(notes.sections[0].commits[0].sha).toBe("abcdef1");
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Contributor Stats
// ═══════════════════════════════════════════════════════════════════════════════

describe("contributor-stats", () => {
  describe("formatContributorStats", () => {
    it("formats stats as a markdown table", () => {
      const stats: ContributorStats = {
        repo: "owner/repo",
        period: { from: "2025-01-01T00:00:00Z", to: "2025-01-31T00:00:00Z" },
        contributors: [
          { login: "alice", commits: 20, prsOpened: 5, prsMerged: 4, reviewsGiven: 8, linesAdded: 500, linesRemoved: 100 },
          { login: "bob", commits: 10, prsOpened: 3, prsMerged: 2, reviewsGiven: 5, linesAdded: 200, linesRemoved: 50 },
        ],
        generatedAt: "2025-01-31T00:00:00Z",
      };

      const md = formatContributorStats(stats);
      expect(md).toContain("## Contributor Stats: owner/repo");
      expect(md).toContain("alice");
      expect(md).toContain("bob");
      expect(md).toContain("20");
      expect(md).toContain("+500/-100");
    });

    it("handles empty contributors", () => {
      const stats: ContributorStats = {
        repo: "owner/repo",
        period: { from: "2025-01-01T00:00:00Z", to: "2025-01-31T00:00:00Z" },
        contributors: [],
        generatedAt: "2025-01-31T00:00:00Z",
      };

      const md = formatContributorStats(stats);
      expect(md).toContain("No contributor activity");
    });

    it("shows dash for contributors with no merged PRs", () => {
      const stats: ContributorStats = {
        repo: "owner/repo",
        period: { from: "2025-01-01T00:00:00Z", to: "2025-01-31T00:00:00Z" },
        contributors: [
          { login: "alice", commits: 5, prsOpened: 0, prsMerged: 0, reviewsGiven: 0, linesAdded: 0, linesRemoved: 0 },
        ],
        generatedAt: "2025-01-31T00:00:00Z",
      };

      const md = formatContributorStats(stats);
      expect(md).toContain("—"); // em dash for no lines
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Issue SLA
// ═══════════════════════════════════════════════════════════════════════════════

describe("issue-sla", () => {
  beforeEach(() => {
    setSLAConfig({});
  });

  describe("config", () => {
    it("returns default SLA config", () => {
      const config = getSLAConfig();
      expect(config.targets.critical.responseHours).toBe(4);
      expect(config.targets.high.responseHours).toBe(8);
      expect(config.targets.medium.responseHours).toBe(24);
      expect(config.targets.low.responseHours).toBe(72);
    });

    it("allows custom SLA targets", () => {
      setSLAConfig({
        targets: {
          critical: { responseHours: 1, resolutionHours: 8 },
          high: { responseHours: 4, resolutionHours: 24 },
          medium: { responseHours: 12, resolutionHours: 72 },
          low: { responseHours: 48, resolutionHours: 336 },
        },
      });

      const config = getSLAConfig();
      expect(config.targets.critical.responseHours).toBe(1);
      expect(config.targets.critical.resolutionHours).toBe(8);
    });
  });

  describe("formatSLAReport", () => {
    it("formats a compliance report", () => {
      const report: SLAReport = {
        repo: "owner/repo",
        period: { from: "2025-01-01T00:00:00Z", to: "2025-01-31T00:00:00Z" },
        generatedAt: "2025-01-31T00:00:00Z",
        overall: { total: 10, withinSLA: 8, breached: 2, complianceRate: 80 },
        byPriority: {
          critical: { total: 1, withinSLA: 1, breached: 0, complianceRate: 100 },
          high: { total: 2, withinSLA: 1, breached: 1, complianceRate: 50 },
          medium: { total: 4, withinSLA: 3, breached: 1, complianceRate: 75 },
          low: { total: 3, withinSLA: 3, breached: 0, complianceRate: 100 },
        },
        breaches: [
          { issueNumber: 5, title: "Fix auth", priority: "high", type: "response", targetHours: 8, actualHours: 12, url: "https://github.com/owner/repo/issues/5" },
          { issueNumber: 8, title: "Update docs", priority: "medium", type: "resolution", targetHours: 168, actualHours: 200, url: "https://github.com/owner/repo/issues/8" },
        ],
      };

      const md = formatSLAReport(report);
      expect(md).toContain("## SLA Compliance Report: owner/repo");
      expect(md).toContain("80%");
      expect(md).toContain("By Priority");
      expect(md).toContain("critical");
      expect(md).toContain("high");
      expect(md).toContain("SLA Breaches");
      expect(md).toContain("#5");
      expect(md).toContain("#8");
    });

    it("omits breaches section when there are none", () => {
      const report: SLAReport = {
        repo: "owner/repo",
        period: { from: "2025-01-01T00:00:00Z", to: "2025-01-31T00:00:00Z" },
        generatedAt: "2025-01-31T00:00:00Z",
        overall: { total: 5, withinSLA: 5, breached: 0, complianceRate: 100 },
        byPriority: {
          critical: { total: 0, withinSLA: 0, breached: 0, complianceRate: 100 },
          high: { total: 1, withinSLA: 1, breached: 0, complianceRate: 100 },
          medium: { total: 2, withinSLA: 2, breached: 0, complianceRate: 100 },
          low: { total: 2, withinSLA: 2, breached: 0, complianceRate: 100 },
        },
        breaches: [],
      };

      const md = formatSLAReport(report);
      expect(md).toContain("100%");
      expect(md).not.toContain("SLA Breaches");
    });
  });
});
