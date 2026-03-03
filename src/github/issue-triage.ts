/**
 * Issue triage — automatically categorize and prioritize GitHub issues.
 *
 * Analyzes issue title, body, and labels to determine:
 * - Category (bug, feature, enhancement, question, docs, maintenance, security)
 * - Priority (critical, high, medium, low)
 * - Suggested labels and assignees
 *
 * Purely heuristic-based — no LLM dependency.
 */

import { createLogger } from "../utils/logger.js";
import { logActivity } from "../activity/log.js";
import * as client from "./client.js";
import type {
  GitHubIssue,
  IssueTriage,
  IssueCategory,
  IssuePriority,
  TriageConfig,
  DuplicateCandidate,
} from "./types.js";

const log = createLogger("github.issue-triage");

// ── Default triage configuration ─────────────────────────────────────────────

const DEFAULT_CONFIG: TriageConfig = {
  labelRules: [
    { keywords: ["bug", "error", "crash", "broken", "fix", "fail", "wrong", "incorrect"], label: "bug" },
    { keywords: ["feature", "request", "proposal", "add", "new", "implement"], label: "enhancement" },
    { keywords: ["question", "how to", "help", "confused", "explain", "?"], label: "question" },
    { keywords: ["docs", "documentation", "readme", "guide", "tutorial", "typo"], label: "documentation" },
    { keywords: ["security", "vulnerability", "cve", "exploit", "xss", "injection", "auth"], label: "security" },
    { keywords: ["refactor", "cleanup", "tech debt", "deprecated", "upgrade", "migration"], label: "maintenance" },
    { keywords: ["performance", "slow", "memory", "leak", "optimize", "speed"], label: "performance" },
  ],
  priorityRules: {
    criticalKeywords: [
      "critical", "urgent", "production down", "data loss", "security vulnerability",
      "crash on startup", "cannot login", "blocker",
    ],
    highKeywords: [
      "high priority", "important", "regression", "broken", "cannot",
      "security", "data corruption", "blocks",
    ],
  },
  assigneeRules: [],
};

let activeConfig: TriageConfig = { ...DEFAULT_CONFIG };

/**
 * Update the triage configuration (merged with defaults).
 */
export function setTriageConfig(config: Partial<TriageConfig>): void {
  activeConfig = {
    ...DEFAULT_CONFIG,
    ...config,
    priorityRules: {
      ...DEFAULT_CONFIG.priorityRules,
      ...config.priorityRules,
    },
  };
}

/** Get current triage configuration. */
export function getTriageConfig(): TriageConfig {
  return activeConfig;
}

// ── Classification ───────────────────────────────────────────────────────────

function classifyCategory(title: string, body: string, existingLabels: string[]): IssueCategory {
  const text = `${title} ${body}`.toLowerCase();

  // If already labeled, respect existing labels
  const labelNames = existingLabels.map((l) => l.toLowerCase());
  if (labelNames.includes("bug")) return "bug";
  if (labelNames.includes("feature") || labelNames.includes("enhancement")) return "feature";
  if (labelNames.includes("question")) return "question";
  if (labelNames.includes("security")) return "security";

  // Keyword-based classification
  const securityWords = ["security", "vulnerability", "cve", "exploit", "xss", "injection"];
  if (securityWords.some((w) => text.includes(w))) return "security";

  const bugWords = ["bug", "error", "crash", "broken", "fail", "not working", "doesn't work", "exception", "stacktrace", "traceback"];
  if (bugWords.some((w) => text.includes(w))) return "bug";

  const featureWords = ["feature request", "proposal", "would be nice", "it would be great", "add support"];
  if (featureWords.some((w) => text.includes(w))) return "feature";

  const questionWords = ["how to", "how do i", "is it possible", "can i", "question", "help needed"];
  if (questionWords.some((w) => text.includes(w))) return "question";

  const docWords = ["documentation", "docs", "readme", "typo in", "guide"];
  if (docWords.some((w) => text.includes(w))) return "documentation";

  const maintenanceWords = ["refactor", "tech debt", "upgrade", "deprecat", "migration"];
  if (maintenanceWords.some((w) => text.includes(w))) return "maintenance";

  return "enhancement";
}

function classifyPriority(title: string, body: string, category: IssueCategory): IssuePriority {
  const text = `${title} ${body}`.toLowerCase();

  // Security issues default to high
  if (category === "security") return "high";

  // Check critical keywords
  if (activeConfig.priorityRules.criticalKeywords.some((kw) => text.includes(kw.toLowerCase()))) {
    return "critical";
  }

  // Check high keywords
  if (activeConfig.priorityRules.highKeywords.some((kw) => text.includes(kw.toLowerCase()))) {
    return "high";
  }

  // Bugs default to medium, everything else to low
  if (category === "bug") return "medium";

  return "low";
}

function suggestLabels(title: string, body: string, existingLabels: string[]): string[] {
  const text = `${title} ${body}`.toLowerCase();
  const existing = new Set(existingLabels.map((l) => l.toLowerCase()));
  const suggestions: string[] = [];

  for (const rule of activeConfig.labelRules) {
    if (existing.has(rule.label.toLowerCase())) continue;
    if (rule.keywords.some((kw) => text.includes(kw.toLowerCase()))) {
      suggestions.push(rule.label);
    }
  }

  return suggestions;
}

function suggestAssignees(labels: string[], _files?: string[]): string[] {
  const assignees: Set<string> = new Set();
  const labelSet = new Set(labels.map((l) => l.toLowerCase()));

  for (const rule of activeConfig.assigneeRules) {
    if (rule.labels?.some((l) => labelSet.has(l.toLowerCase()))) {
      for (const a of rule.assignees) assignees.add(a);
    }
  }

  return [...assignees];
}

function buildSummary(issue: GitHubIssue, category: IssueCategory, priority: IssuePriority): string {
  const bodyPreview = issue.body
    ? issue.body.slice(0, 200).replace(/\n/g, " ").trim()
    : "(no description)";
  return `[${priority.toUpperCase()}] ${category} — ${issue.title}. ${bodyPreview}`;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Triage a single issue: classify, prioritize, and suggest labels/assignees.
 */
export async function triageIssue(
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<IssueTriage | null> {
  log.info(`Triaging issue ${owner}/${repo}#${issueNumber}`);

  const issue = await client.getIssue(owner, repo, issueNumber);
  if (!issue) {
    log.warn(`Failed to fetch issue ${owner}/${repo}#${issueNumber}`);
    return null;
  }

  // Skip pull requests (GitHub API returns PRs under /issues too)
  if (issue.pull_request) {
    return null;
  }

  return triageFromIssue(owner, repo, issue);
}

/**
 * Triage from an already-fetched issue object (avoids extra API call from webhooks).
 */
export function triageFromIssue(
  owner: string,
  repo: string,
  issue: GitHubIssue,
): IssueTriage {
  const existingLabels = issue.labels.map((l) => l.name);
  const body = issue.body ?? "";

  const category = classifyCategory(issue.title, body, existingLabels);
  const priority = classifyPriority(issue.title, body, category);
  const suggestedLabels = suggestLabels(issue.title, body, existingLabels);
  const suggestedAssignees = suggestAssignees([...existingLabels, ...suggestedLabels]);
  const summary = buildSummary(issue, category, priority);

  const result: IssueTriage = {
    issueNumber: issue.number,
    repo: `${owner}/${repo}`,
    category,
    priority,
    suggestedLabels,
    suggestedAssignees,
    summary,
    triagedAt: new Date().toISOString(),
  };

  logActivity({
    source: "board",
    summary: `Issue triage: ${owner}/${repo}#${issue.number} → ${category} (${priority})`,
  });

  return result;
}

/**
 * Triage an issue and apply the suggested labels automatically.
 */
export async function triageAndLabel(
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<IssueTriage | null> {
  const triage = await triageIssue(owner, repo, issueNumber);
  if (!triage) return null;

  if (triage.suggestedLabels.length > 0) {
    await client.addIssueLabels(owner, repo, issueNumber, triage.suggestedLabels);
  }

  if (triage.suggestedAssignees.length > 0) {
    await client.addIssueAssignees(owner, repo, issueNumber, triage.suggestedAssignees);
  }

  return triage;
}

/**
 * Batch triage all open issues in a repository.
 */
export async function triageOpenIssues(
  owner: string,
  repo: string,
  opts?: { apply?: boolean },
): Promise<IssueTriage[]> {
  log.info(`Batch triaging open issues for ${owner}/${repo}`);

  const issues = await client.listIssues(owner, repo, { state: "open", per_page: 100 });
  if (!issues) return [];

  const results: IssueTriage[] = [];
  for (const issue of issues) {
    if (issue.pull_request) continue; // Skip PRs

    const triage = triageFromIssue(owner, repo, issue);
    results.push(triage);

    if (opts?.apply) {
      if (triage.suggestedLabels.length > 0) {
        await client.addIssueLabels(owner, repo, issue.number, triage.suggestedLabels);
      }
      if (triage.suggestedAssignees.length > 0) {
        await client.addIssueAssignees(owner, repo, issue.number, triage.suggestedAssignees);
      }
    }
  }

  logActivity({
    source: "board",
    summary: `Batch triage: ${results.length} issues in ${owner}/${repo}`,
  });

  return results;
}

// ── Duplicate Detection ───────────────────────────────────────────────────────

/**
 * Tokenize a title into lowercase words, stripping punctuation.
 */
function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2), // skip very short words
  );
}

/**
 * Jaccard similarity between two token sets.
 * Returns a value between 0 (no overlap) and 1 (identical).
 */
export function titleSimilarity(a: string, b: string): number {
  const tokensA = tokenize(a);
  const tokensB = tokenize(b);
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let intersection = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) intersection++;
  }

  const union = tokensA.size + tokensB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Find potential duplicate issues for a given issue by comparing titles.
 * Returns issues with similarity above the threshold (default 0.5).
 */
export async function findDuplicates(
  owner: string,
  repo: string,
  issueNumber: number,
  opts?: { threshold?: number; maxResults?: number },
): Promise<DuplicateCandidate[]> {
  const threshold = opts?.threshold ?? 0.5;
  const maxResults = opts?.maxResults ?? 5;

  const issue = await client.getIssue(owner, repo, issueNumber);
  if (!issue) return [];

  const openIssues = await client.listIssues(owner, repo, { state: "open", per_page: 100 });
  if (!openIssues) return [];

  const candidates: DuplicateCandidate[] = [];
  for (const other of openIssues) {
    if (other.number === issueNumber) continue;
    if (other.pull_request) continue;

    const similarity = titleSimilarity(issue.title, other.title);
    if (similarity >= threshold) {
      candidates.push({
        issueNumber: other.number,
        title: other.title,
        similarity: Math.round(similarity * 100) / 100,
        url: other.html_url,
      });
    }
  }

  candidates.sort((a, b) => b.similarity - a.similarity);
  return candidates.slice(0, maxResults);
}
