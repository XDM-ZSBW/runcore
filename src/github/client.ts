/**
 * GitHub REST API client — fetch-based, no SDK dependency.
 * Reads GITHUB_TOKEN from process.env (hydrated by vault).
 *
 * All methods use retry with exponential backoff for transient failures.
 * Auth errors are surfaced immediately. Permanent errors return null.
 */

import { createLogger } from "../utils/logger.js";
import { withRetry, classifyError, GitHubApiError } from "./retry.js";
import type { ErrorKind } from "./retry.js";
import type {
  GitHubUser,
  GitHubRepo,
  GitHubIssue,
  GitHubPullRequest,
  GitHubPRFile,
  GitHubCommit,
  GitHubReview,
  GitHubComment,
  GitHubLabel,
  GitHubWorkflowRunsResponse,
  GitHubCheckRunsResponse,
  GitHubCompareResult,
  GitHubTag,
  GitHubIssueEvent,
} from "./types.js";

const log = createLogger("github");

const DEFAULT_API_BASE = "https://api.github.com";

// ── Lazy singleton ───────────────────────────────────────────────────────────

let cachedToken = "";
let apiBase = DEFAULT_API_BASE;

function getToken(): string | null {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return null;
  if (token !== cachedToken) {
    cachedToken = token;
  }
  return cachedToken;
}

export function setApiBase(url: string): void {
  apiBase = url.replace(/\/+$/, "");
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

async function ghFetch<T>(
  path: string,
  opts?: { method?: string; body?: unknown; token?: string },
): Promise<T> {
  const token = opts?.token ?? getToken();
  if (!token) {
    throw new GitHubApiError("GITHUB_TOKEN not set", "auth");
  }

  const url = path.startsWith("http") ? path : `${apiBase}${path}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };

  if (opts?.body) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(url, {
    method: opts?.method ?? "GET",
    headers,
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const msg = `GitHub API ${response.status}: ${text.slice(0, 200)}`;

    if (response.status === 401 || response.status === 403) {
      throw new GitHubApiError(msg, "auth", response.status);
    }
    if (response.status === 429 || response.status >= 500) {
      throw new GitHubApiError(msg, "transient", response.status);
    }
    throw new GitHubApiError(msg, "permanent", response.status);
  }

  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Last error tracking for health reporting. */
let lastErrorKind: ErrorKind | null = null;
let lastErrorMessage: string | null = null;

function clearError(): void {
  lastErrorKind = null;
  lastErrorMessage = null;
}

function recordError(err: unknown): void {
  lastErrorKind = classifyError(err);
  lastErrorMessage = err instanceof Error ? err.message : String(err);
}

// ── Availability ─────────────────────────────────────────────────────────────

export function isAvailable(): boolean {
  return !!process.env.GITHUB_TOKEN;
}

/** Validate the token by calling /user. */
export async function validateAuth(): Promise<{ valid: boolean; error?: string }> {
  if (!getToken()) return { valid: false, error: "GITHUB_TOKEN not set" };

  try {
    await withRetry(() => ghFetch<GitHubUser>("/user"), { label: "validateAuth", maxAttempts: 2 });
    clearError();
    return { valid: true };
  } catch (err) {
    recordError(err);
    return { valid: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── User ─────────────────────────────────────────────────────────────────────

export async function getAuthenticatedUser(): Promise<GitHubUser | null> {
  try {
    // Use reduced retries and shorter timeout for user lookup.
    // Auth errors already fail immediately (no retry); this limits network-timeout exposure
    // from the default 3×15s = 45s down to 2×10s = 20s worst case.
    const user = await withRetry(() => ghFetch<GitHubUser>("/user"), {
      label: "getUser",
      maxAttempts: 2,
      timeoutMs: 10_000,
    });
    clearError();
    return user;
  } catch (err) {
    recordError(err);
    log.error(`getAuthenticatedUser failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ── Repos ────────────────────────────────────────────────────────────────────

export async function getRepo(owner: string, repo: string): Promise<GitHubRepo | null> {
  try {
    const data = await withRetry(
      () => ghFetch<GitHubRepo>(`/repos/${owner}/${repo}`),
      { label: "getRepo" },
    );
    clearError();
    return data;
  } catch (err) {
    recordError(err);
    return null;
  }
}

// ── Issues ───────────────────────────────────────────────────────────────────

export async function listIssues(
  owner: string,
  repo: string,
  opts?: { state?: "open" | "closed" | "all"; labels?: string; per_page?: number; since?: string },
): Promise<GitHubIssue[] | null> {
  try {
    const params = new URLSearchParams();
    if (opts?.state) params.set("state", opts.state);
    if (opts?.labels) params.set("labels", opts.labels);
    if (opts?.since) params.set("since", opts.since);
    params.set("per_page", String(opts?.per_page ?? 30));

    const qs = params.toString();
    const data = await withRetry(
      () => ghFetch<GitHubIssue[]>(`/repos/${owner}/${repo}/issues?${qs}`),
      { label: "listIssues" },
    );
    clearError();
    return data;
  } catch (err) {
    recordError(err);
    return null;
  }
}

export async function getIssue(owner: string, repo: string, number: number): Promise<GitHubIssue | null> {
  try {
    const data = await withRetry(
      () => ghFetch<GitHubIssue>(`/repos/${owner}/${repo}/issues/${number}`),
      { label: "getIssue" },
    );
    clearError();
    return data;
  } catch (err) {
    recordError(err);
    return null;
  }
}

export async function addIssueLabels(
  owner: string,
  repo: string,
  number: number,
  labels: string[],
): Promise<GitHubLabel[] | null> {
  try {
    const data = await withRetry(
      () => ghFetch<GitHubLabel[]>(`/repos/${owner}/${repo}/issues/${number}/labels`, {
        method: "POST",
        body: { labels },
      }),
      { label: "addIssueLabels" },
    );
    clearError();
    return data;
  } catch (err) {
    recordError(err);
    return null;
  }
}

export async function addIssueComment(
  owner: string,
  repo: string,
  number: number,
  body: string,
): Promise<GitHubComment | null> {
  try {
    const data = await withRetry(
      () => ghFetch<GitHubComment>(`/repos/${owner}/${repo}/issues/${number}/comments`, {
        method: "POST",
        body: { body },
      }),
      { label: "addIssueComment" },
    );
    clearError();
    return data;
  } catch (err) {
    recordError(err);
    return null;
  }
}

export async function addIssueAssignees(
  owner: string,
  repo: string,
  number: number,
  assignees: string[],
): Promise<GitHubIssue | null> {
  try {
    const data = await withRetry(
      () => ghFetch<GitHubIssue>(`/repos/${owner}/${repo}/issues/${number}/assignees`, {
        method: "POST",
        body: { assignees },
      }),
      { label: "addIssueAssignees" },
    );
    clearError();
    return data;
  } catch (err) {
    recordError(err);
    return null;
  }
}

// ── Pull Requests ────────────────────────────────────────────────────────────

export async function listPullRequests(
  owner: string,
  repo: string,
  opts?: { state?: "open" | "closed" | "all"; per_page?: number },
): Promise<GitHubPullRequest[] | null> {
  try {
    const params = new URLSearchParams();
    if (opts?.state) params.set("state", opts.state);
    params.set("per_page", String(opts?.per_page ?? 30));

    const data = await withRetry(
      () => ghFetch<GitHubPullRequest[]>(`/repos/${owner}/${repo}/pulls?${params}`),
      { label: "listPullRequests" },
    );
    clearError();
    return data;
  } catch (err) {
    recordError(err);
    return null;
  }
}

export async function getPullRequest(
  owner: string,
  repo: string,
  number: number,
): Promise<GitHubPullRequest | null> {
  try {
    const data = await withRetry(
      () => ghFetch<GitHubPullRequest>(`/repos/${owner}/${repo}/pulls/${number}`),
      { label: "getPullRequest" },
    );
    clearError();
    return data;
  } catch (err) {
    recordError(err);
    return null;
  }
}

export async function getPRFiles(
  owner: string,
  repo: string,
  number: number,
): Promise<GitHubPRFile[] | null> {
  try {
    const data = await withRetry(
      () => ghFetch<GitHubPRFile[]>(`/repos/${owner}/${repo}/pulls/${number}/files?per_page=100`),
      { label: "getPRFiles" },
    );
    clearError();
    return data;
  } catch (err) {
    recordError(err);
    return null;
  }
}

export async function getPRReviews(
  owner: string,
  repo: string,
  number: number,
): Promise<GitHubReview[] | null> {
  try {
    const data = await withRetry(
      () => ghFetch<GitHubReview[]>(`/repos/${owner}/${repo}/pulls/${number}/reviews`),
      { label: "getPRReviews" },
    );
    clearError();
    return data;
  } catch (err) {
    recordError(err);
    return null;
  }
}

export async function createPRReview(
  owner: string,
  repo: string,
  number: number,
  opts: { body: string; event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT" },
): Promise<GitHubReview | null> {
  try {
    const data = await withRetry(
      () => ghFetch<GitHubReview>(`/repos/${owner}/${repo}/pulls/${number}/reviews`, {
        method: "POST",
        body: { body: opts.body, event: opts.event },
      }),
      { label: "createPRReview" },
    );
    clearError();
    return data;
  } catch (err) {
    recordError(err);
    return null;
  }
}

// ── Commits ──────────────────────────────────────────────────────────────────

export async function listCommits(
  owner: string,
  repo: string,
  opts?: { sha?: string; since?: string; until?: string; per_page?: number },
): Promise<Array<{ sha: string; commit: { message: string; author: { name: string; email: string; date: string } | null }; html_url: string }> | null> {
  try {
    const params = new URLSearchParams();
    if (opts?.sha) params.set("sha", opts.sha);
    if (opts?.since) params.set("since", opts.since);
    if (opts?.until) params.set("until", opts.until);
    params.set("per_page", String(opts?.per_page ?? 30));

    const data = await withRetry(
      () => ghFetch<Array<{ sha: string; commit: { message: string; author: { name: string; email: string; date: string } | null }; html_url: string }>>(
        `/repos/${owner}/${repo}/commits?${params}`,
      ),
      { label: "listCommits" },
    );
    clearError();
    return data;
  } catch (err) {
    recordError(err);
    return null;
  }
}

export async function getCommit(
  owner: string,
  repo: string,
  sha: string,
): Promise<GitHubCommit | null> {
  try {
    const data = await withRetry(
      () => ghFetch<GitHubCommit>(`/repos/${owner}/${repo}/commits/${sha}`),
      { label: "getCommit" },
    );
    clearError();
    return data;
  } catch (err) {
    recordError(err);
    return null;
  }
}

// ── Labels ───────────────────────────────────────────────────────────────────

export async function listLabels(
  owner: string,
  repo: string,
): Promise<GitHubLabel[] | null> {
  try {
    const data = await withRetry(
      () => ghFetch<GitHubLabel[]>(`/repos/${owner}/${repo}/labels?per_page=100`),
      { label: "listLabels" },
    );
    clearError();
    return data;
  } catch (err) {
    recordError(err);
    return null;
  }
}

export async function createLabel(
  owner: string,
  repo: string,
  opts: { name: string; color: string; description?: string },
): Promise<GitHubLabel | null> {
  try {
    const data = await withRetry(
      () => ghFetch<GitHubLabel>(`/repos/${owner}/${repo}/labels`, {
        method: "POST",
        body: opts,
      }),
      { label: "createLabel" },
    );
    clearError();
    return data;
  } catch (err) {
    recordError(err);
    return null;
  }
}

// ── Workflow Runs (GitHub Actions) ────────────────────────────────────────────

export async function listWorkflowRuns(
  owner: string,
  repo: string,
  opts?: { status?: "completed" | "in_progress" | "queued"; per_page?: number; created?: string },
): Promise<GitHubWorkflowRunsResponse | null> {
  try {
    const params = new URLSearchParams();
    if (opts?.status) params.set("status", opts.status);
    if (opts?.created) params.set("created", opts.created);
    params.set("per_page", String(opts?.per_page ?? 30));

    const data = await withRetry(
      () => ghFetch<GitHubWorkflowRunsResponse>(`/repos/${owner}/${repo}/actions/runs?${params}`),
      { label: "listWorkflowRuns" },
    );
    clearError();
    return data;
  } catch (err) {
    recordError(err);
    return null;
  }
}

// ── Check Runs (CI Status) ────────────────────────────────────────────────

export async function listCheckRuns(
  owner: string,
  repo: string,
  ref: string,
): Promise<GitHubCheckRunsResponse | null> {
  try {
    const data = await withRetry(
      () => ghFetch<GitHubCheckRunsResponse>(`/repos/${owner}/${repo}/commits/${ref}/check-runs`),
      { label: "listCheckRuns" },
    );
    clearError();
    return data;
  } catch (err) {
    recordError(err);
    return null;
  }
}

// ── Branch Comparison ─────────────────────────────────────────────────────

export async function compareBranches(
  owner: string,
  repo: string,
  base: string,
  head: string,
): Promise<GitHubCompareResult | null> {
  try {
    const data = await withRetry(
      () => ghFetch<GitHubCompareResult>(`/repos/${owner}/${repo}/compare/${base}...${head}`),
      { label: "compareBranches" },
    );
    clearError();
    return data;
  } catch (err) {
    recordError(err);
    return null;
  }
}

// ── Tags ──────────────────────────────────────────────────────────────────

export async function listTags(
  owner: string,
  repo: string,
  opts?: { per_page?: number },
): Promise<GitHubTag[] | null> {
  try {
    const params = new URLSearchParams();
    params.set("per_page", String(opts?.per_page ?? 30));

    const data = await withRetry(
      () => ghFetch<GitHubTag[]>(`/repos/${owner}/${repo}/tags?${params}`),
      { label: "listTags" },
    );
    clearError();
    return data;
  } catch (err) {
    recordError(err);
    return null;
  }
}

// ── Issue Events (for SLA tracking) ───────────────────────────────────────

export async function listIssueEvents(
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<GitHubIssueEvent[] | null> {
  try {
    const data = await withRetry(
      () => ghFetch<GitHubIssueEvent[]>(`/repos/${owner}/${repo}/issues/${issueNumber}/events`),
      { label: "listIssueEvents" },
    );
    clearError();
    return data;
  } catch (err) {
    recordError(err);
    return null;
  }
}

// ── Issue Comments (for SLA first response) ───────────────────────────────

export async function listIssueComments(
  owner: string,
  repo: string,
  issueNumber: number,
  opts?: { per_page?: number },
): Promise<GitHubComment[] | null> {
  try {
    const params = new URLSearchParams();
    params.set("per_page", String(opts?.per_page ?? 30));

    const data = await withRetry(
      () => ghFetch<GitHubComment[]>(`/repos/${owner}/${repo}/issues/${issueNumber}/comments?${params}`),
      { label: "listIssueComments" },
    );
    clearError();
    return data;
  } catch (err) {
    recordError(err);
    return null;
  }
}

// ── Health reporting ─────────────────────────────────────────────────────────

export function getHealth(): { available: boolean; lastError: ErrorKind | null; lastErrorMessage: string | null } {
  return {
    available: isAvailable(),
    lastError: lastErrorKind,
    lastErrorMessage,
  };
}
