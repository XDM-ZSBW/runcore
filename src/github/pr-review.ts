/**
 * PR review automation — analyzes pull requests and provides feedback.
 *
 * Checks for: size, test coverage signals, doc changes, large/binary files,
 * naming conventions, security patterns, and breaking changes.
 * Does NOT use LLM — purely heuristic-based for speed and reliability.
 */

import { createLogger } from "../utils/logger.js";
import { logActivity } from "../activity/log.js";
import * as client from "./client.js";
import type {
  GitHubPullRequest,
  GitHubPRFile,
  PRReviewResult,
  PRFinding,
  PRMetrics,
  PRFindingCategory,
} from "./types.js";

const log = createLogger("github.pr-review");

// ── Size thresholds ──────────────────────────────────────────────────────────

const SIZE_THRESHOLDS = {
  small: 100,
  medium: 300,
  large: 500,
  huge: 1000,
};

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".svg",
  ".woff", ".woff2", ".ttf", ".eot",
  ".zip", ".tar", ".gz", ".exe", ".dll",
  ".mp3", ".mp4", ".wav", ".avi",
  ".pdf", ".doc", ".docx",
]);

const TEST_PATTERNS = [
  /\.test\.[jt]sx?$/,
  /\.spec\.[jt]sx?$/,
  /__tests__\//,
  /test\//,
  /tests\//,
];

const DOC_PATTERNS = [
  /\.md$/i,
  /docs?\//i,
  /readme/i,
  /changelog/i,
];

const SECURITY_PATTERNS = [
  /password/i,
  /secret/i,
  /api[_-]?key/i,
  /token/i,
  /\.env/,
  /credentials/i,
  /auth[_-]?token/i,
  /private[_-]?key/i,
];

const DEPENDENCY_FILES = new Set([
  "package.json",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "requirements.txt",
  "Pipfile.lock",
  "Gemfile.lock",
  "go.sum",
  "Cargo.lock",
  "composer.lock",
]);

const LOCK_FILES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "Pipfile.lock",
  "Gemfile.lock",
  "go.sum",
  "Cargo.lock",
  "composer.lock",
]);

// ── Analysis functions ───────────────────────────────────────────────────────

function getFileExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot).toLowerCase() : "";
}

function computeMetrics(pr: GitHubPullRequest, files: GitHubPRFile[]): PRMetrics {
  const hasTests = files.some((f) => TEST_PATTERNS.some((p) => p.test(f.filename)));
  const hasDocChanges = files.some((f) => DOC_PATTERNS.some((p) => p.test(f.filename)));
  const largeFiles = files
    .filter((f) => f.changes > 300)
    .map((f) => f.filename);
  const binaryFiles = files
    .filter((f) => BINARY_EXTENSIONS.has(getFileExtension(f.filename)))
    .map((f) => f.filename);

  return {
    filesChanged: pr.changed_files,
    additions: pr.additions,
    deletions: pr.deletions,
    hasTests,
    hasDocChanges,
    largeFiles,
    binaryFiles,
  };
}

function analyzeSize(pr: GitHubPullRequest): PRFinding[] {
  const findings: PRFinding[] = [];
  const total = pr.additions + pr.deletions;

  if (total > SIZE_THRESHOLDS.huge) {
    findings.push({
      severity: "error",
      category: "size",
      message: `Very large PR (${total} lines changed). Consider breaking into smaller PRs for easier review.`,
    });
  } else if (total > SIZE_THRESHOLDS.large) {
    findings.push({
      severity: "warning",
      category: "size",
      message: `Large PR (${total} lines changed). Smaller PRs are reviewed faster and more thoroughly.`,
    });
  }

  if (pr.changed_files > 20) {
    findings.push({
      severity: "warning",
      category: "size",
      message: `${pr.changed_files} files changed. Consider scoping this PR more narrowly.`,
    });
  }

  return findings;
}

function analyzeTestCoverage(files: GitHubPRFile[]): PRFinding[] {
  const findings: PRFinding[] = [];
  const srcFiles = files.filter(
    (f) => f.status !== "removed" &&
    !TEST_PATTERNS.some((p) => p.test(f.filename)) &&
    !DOC_PATTERNS.some((p) => p.test(f.filename)) &&
    (f.filename.endsWith(".ts") || f.filename.endsWith(".tsx") || f.filename.endsWith(".js") || f.filename.endsWith(".jsx")),
  );
  const testFiles = files.filter((f) => TEST_PATTERNS.some((p) => p.test(f.filename)));

  if (srcFiles.length > 0 && testFiles.length === 0) {
    findings.push({
      severity: "warning",
      category: "testing",
      message: `${srcFiles.length} source file(s) changed but no test files modified. Consider adding tests.`,
    });
  }

  return findings;
}

function analyzeSecurityPatterns(files: GitHubPRFile[]): PRFinding[] {
  const findings: PRFinding[] = [];

  for (const file of files) {
    if (!file.patch) continue;

    // Only check added lines (lines starting with +)
    const addedLines = file.patch.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));

    for (const line of addedLines) {
      for (const pattern of SECURITY_PATTERNS) {
        if (pattern.test(line)) {
          // Skip if it's clearly a test or mock
          if (/mock|test|fake|dummy|example|placeholder/i.test(line)) continue;
          findings.push({
            severity: "warning",
            category: "security",
            message: `Potential sensitive value in ${file.filename} — review for hardcoded credentials.`,
            file: file.filename,
          });
          break; // One finding per file per pattern check
        }
      }
    }
  }

  // Deduplicate by file
  const seen = new Set<string>();
  return findings.filter((f) => {
    if (f.file && seen.has(f.file)) return false;
    if (f.file) seen.add(f.file);
    return true;
  });
}

function analyzeDependencyChanges(files: GitHubPRFile[]): PRFinding[] {
  const findings: PRFinding[] = [];
  const depFiles = files.filter((f) => {
    const basename = f.filename.split("/").pop() ?? "";
    return DEPENDENCY_FILES.has(basename);
  });

  if (depFiles.length === 0) return findings;

  const manifestFiles = depFiles.filter((f) => {
    const basename = f.filename.split("/").pop() ?? "";
    return !LOCK_FILES.has(basename);
  });
  const lockFiles = depFiles.filter((f) => {
    const basename = f.filename.split("/").pop() ?? "";
    return LOCK_FILES.has(basename);
  });

  // Manifest changed but no lock file — might be missing install
  if (manifestFiles.length > 0 && lockFiles.length === 0) {
    findings.push({
      severity: "warning",
      category: "convention",
      message: `Dependency manifest changed (${manifestFiles.map((f) => f.filename).join(", ")}) but no lock file updated. Run install to update the lock file.`,
    });
  }

  // Lock file changed — flag for review
  if (lockFiles.length > 0) {
    findings.push({
      severity: "info",
      category: "security",
      message: `Lock file(s) changed: ${lockFiles.map((f) => f.filename).join(", ")}. Verify dependency updates are intentional.`,
    });
  }

  // Check for new dependency additions in patch
  for (const f of manifestFiles) {
    if (!f.patch) continue;
    const addedLines = f.patch.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
    if (addedLines.length > 10) {
      findings.push({
        severity: "info",
        category: "security",
        message: `Significant dependency changes in ${f.filename} (${addedLines.length} additions). Review new dependencies for supply chain risk.`,
        file: f.filename,
      });
    }
  }

  return findings;
}

function analyzeBreakingChanges(files: GitHubPRFile[]): PRFinding[] {
  const findings: PRFinding[] = [];

  const deletedFiles = files.filter((f) => f.status === "removed");
  const renamedFiles = files.filter((f) => f.status === "renamed");

  // Exported source files being deleted
  const deletedSrcFiles = deletedFiles.filter(
    (f) => /\.(ts|js|tsx|jsx)$/.test(f.filename) &&
    !TEST_PATTERNS.some((p) => p.test(f.filename)),
  );
  if (deletedSrcFiles.length > 0) {
    findings.push({
      severity: "warning",
      category: "breaking_change",
      message: `${deletedSrcFiles.length} source file(s) deleted: ${deletedSrcFiles.slice(0, 3).map((f) => f.filename).join(", ")}${deletedSrcFiles.length > 3 ? "..." : ""}. Verify no external consumers depend on these.`,
    });
  }

  // Renamed files may break imports
  if (renamedFiles.length > 0) {
    findings.push({
      severity: "info",
      category: "breaking_change",
      message: `${renamedFiles.length} file(s) renamed. Verify all import paths have been updated.`,
    });
  }

  // Check patches for removed exports
  for (const f of files) {
    if (!f.patch || f.status === "removed") continue;
    if (!/\.(ts|js|tsx|jsx)$/.test(f.filename)) continue;

    const removedLines = f.patch.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---"));
    const removedExports = removedLines.filter((l) => /^\-\s*export\s/.test(l));
    if (removedExports.length > 0) {
      findings.push({
        severity: "warning",
        category: "breaking_change",
        message: `${removedExports.length} export(s) removed in ${f.filename}. This may break downstream consumers.`,
        file: f.filename,
      });
    }
  }

  return findings;
}

function analyzeReviewStaleness(pr: GitHubPullRequest): PRFinding[] {
  const findings: PRFinding[] = [];
  const createdMs = new Date(pr.created_at).getTime();
  const nowMs = Date.now();
  const ageDays = (nowMs - createdMs) / (24 * 60 * 60 * 1000);

  if (ageDays > 14) {
    findings.push({
      severity: "warning",
      category: "convention",
      message: `PR has been open for ${Math.round(ageDays)} days. Consider merging, closing, or rebasing.`,
    });
  } else if (ageDays > 7) {
    findings.push({
      severity: "info",
      category: "convention",
      message: `PR has been open for ${Math.round(ageDays)} days. A prompt review keeps momentum.`,
    });
  }

  return findings;
}

function analyzeConventions(pr: GitHubPullRequest, files: GitHubPRFile[]): PRFinding[] {
  const findings: PRFinding[] = [];

  // Check PR title
  if (pr.title.length < 10) {
    findings.push({
      severity: "info",
      category: "convention",
      message: "PR title is very short. A descriptive title helps reviewers and shows in git history.",
    });
  }

  // Check for WIP / draft signals
  if (/\bwip\b/i.test(pr.title) && !pr.draft) {
    findings.push({
      severity: "info",
      category: "convention",
      message: "PR title contains 'WIP' but is not marked as draft.",
    });
  }

  // Check for empty body
  if (!pr.body || pr.body.trim().length < 20) {
    findings.push({
      severity: "info",
      category: "documentation",
      message: "PR description is empty or very short. Consider explaining the what and why of this change.",
    });
  }

  return findings;
}

function determineRecommendation(findings: PRFinding[]): "approve" | "request_changes" | "comment" {
  const hasErrors = findings.some((f) => f.severity === "error");
  if (hasErrors) return "request_changes";

  const warningCount = findings.filter((f) => f.severity === "warning").length;
  if (warningCount >= 3) return "request_changes";
  if (warningCount > 0) return "comment";

  return "approve";
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Analyze a pull request and produce a review with findings and metrics.
 */
export async function reviewPR(
  owner: string,
  repo: string,
  prNumber: number,
): Promise<PRReviewResult | null> {
  log.info(`Reviewing PR ${owner}/${repo}#${prNumber}`);

  const [pr, files] = await Promise.all([
    client.getPullRequest(owner, repo, prNumber),
    client.getPRFiles(owner, repo, prNumber),
  ]);

  if (!pr || !files) {
    log.warn(`Failed to fetch PR data for ${owner}/${repo}#${prNumber}`);
    return null;
  }

  const metrics = computeMetrics(pr, files);
  const findings: PRFinding[] = [
    ...analyzeSize(pr),
    ...analyzeTestCoverage(files),
    ...analyzeSecurityPatterns(files),
    ...analyzeDependencyChanges(files),
    ...analyzeBreakingChanges(files),
    ...analyzeReviewStaleness(pr),
    ...analyzeConventions(pr, files),
  ];

  // Binary file warnings
  if (metrics.binaryFiles.length > 0) {
    findings.push({
      severity: "info",
      category: "size",
      message: `${metrics.binaryFiles.length} binary file(s) included: ${metrics.binaryFiles.slice(0, 3).join(", ")}${metrics.binaryFiles.length > 3 ? "..." : ""}`,
    });
  }

  const recommendation = determineRecommendation(findings);
  const summary = buildSummary(pr, metrics, findings, recommendation);

  const result: PRReviewResult = {
    prNumber,
    repo: `${owner}/${repo}`,
    summary,
    findings,
    metrics,
    recommendation,
    reviewedAt: new Date().toISOString(),
  };

  logActivity({
    source: "board",
    summary: `PR review: ${owner}/${repo}#${prNumber} — ${recommendation} (${findings.length} findings)`,
  });

  return result;
}

/**
 * Review a PR and post the review as a GitHub comment.
 */
export async function reviewAndComment(
  owner: string,
  repo: string,
  prNumber: number,
): Promise<PRReviewResult | null> {
  const result = await reviewPR(owner, repo, prNumber);
  if (!result) return null;

  // Post as PR comment (not a formal review, to avoid blocking)
  await client.addIssueComment(owner, repo, prNumber, result.summary);
  return result;
}

// ── Summary formatting ───────────────────────────────────────────────────────

function buildSummary(
  pr: GitHubPullRequest,
  metrics: PRMetrics,
  findings: PRFinding[],
  recommendation: string,
): string {
  const lines: string[] = [];
  lines.push(`## Automated PR Review`);
  lines.push("");
  lines.push(`**${pr.title}** (#${pr.number})`);
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Files changed | ${metrics.filesChanged} |`);
  lines.push(`| Additions | +${metrics.additions} |`);
  lines.push(`| Deletions | -${metrics.deletions} |`);
  lines.push(`| Tests included | ${metrics.hasTests ? "Yes" : "No"} |`);
  lines.push(`| Docs updated | ${metrics.hasDocChanges ? "Yes" : "No"} |`);
  lines.push("");

  if (findings.length > 0) {
    lines.push(`### Findings (${findings.length})`);
    lines.push("");
    for (const f of findings) {
      const icon = f.severity === "error" ? "🔴" : f.severity === "warning" ? "🟡" : "🔵";
      const loc = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : "";
      lines.push(`- ${icon} **${f.category}**${loc}: ${f.message}`);
    }
    lines.push("");
  }

  lines.push(`**Recommendation:** ${recommendation.replace("_", " ")}`);
  return lines.join("\n");
}
