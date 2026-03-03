/**
 * GitHub webhook event handling.
 * Processes incoming webhook payloads from GitHub for real-time updates.
 *
 * GitHub signs webhooks with HMAC-SHA256 hex with a "sha256=" prefix.
 * Header: X-Hub-Signature-256
 *
 * Webhook setup: Configure in GitHub repo → Settings → Webhooks.
 * URL: https://<your-domain>/api/github/webhooks
 * Content type: application/json
 * Events: Pull requests, Issues, Push, Issue comments, Pull request reviews.
 */

import { createLogger } from "../utils/logger.js";
import { logActivity } from "../activity/log.js";
import { hmacSha256Hex, timingSafeCompare } from "../webhooks/registry.js";
import { createHmacSha256HexProvider, safeHandler } from "../webhooks/handlers.js";
import type { WebhookResult } from "../webhooks/types.js";
import type {
  GitHubWebhookPayload,
  GitHubPRWebhookPayload,
  GitHubIssueWebhookPayload,
  GitHubPushWebhookPayload,
  GitHubIssueCommentWebhookPayload,
  GitHubPRReviewWebhookPayload,
} from "./types.js";

const log = createLogger("github.webhooks");

// ── Event callback registry ──────────────────────────────────────────────────

export type GitHubEventHandler = (payload: GitHubWebhookPayload) => Promise<WebhookResult>;

const eventHandlers: Map<string, GitHubEventHandler[]> = new Map();

/**
 * Register a handler for a specific GitHub webhook event type.
 * Multiple handlers can be registered for the same event.
 */
export function onGitHubEvent(eventType: string, handler: GitHubEventHandler): void {
  const handlers = eventHandlers.get(eventType) ?? [];
  handlers.push(handler);
  eventHandlers.set(eventType, handlers);
}

// ── Signature verification ───────────────────────────────────────────────────

/**
 * Verify GitHub webhook signature.
 * GitHub uses HMAC-SHA256 hex with a "sha256=" prefix in X-Hub-Signature-256.
 */
export function verifyWebhookSignature(
  body: string,
  signature: string,
  secret: string,
): boolean {
  const sig = signature.replace(/^sha256=/, "");
  const expected = hmacSha256Hex(body, secret);
  return timingSafeCompare(sig, expected);
}

// ── Event processing ─────────────────────────────────────────────────────────

async function handlePullRequestEvent(payload: GitHubPRWebhookPayload): Promise<WebhookResult> {
  const { action, pull_request: pr, repository: repo } = payload;
  const prRef = `${repo.full_name}#${pr.number}`;

  log.info(`PR event: ${action} on ${prRef} ("${pr.title}")`);
  logActivity({
    source: "board",
    summary: `GitHub PR ${action}: ${prRef} — ${pr.title}`,
  });

  // Dispatch to registered handlers
  const handlers = eventHandlers.get("pull_request") ?? [];
  for (const handler of handlers) {
    await handler(payload);
  }

  return { handled: true, message: `PR ${action}: ${prRef}` };
}

async function handleIssueEvent(payload: GitHubIssueWebhookPayload): Promise<WebhookResult> {
  const { action, issue, repository: repo } = payload;
  const issueRef = `${repo.full_name}#${issue.number}`;

  log.info(`Issue event: ${action} on ${issueRef} ("${issue.title}")`);
  logActivity({
    source: "board",
    summary: `GitHub issue ${action}: ${issueRef} — ${issue.title}`,
  });

  const handlers = eventHandlers.get("issues") ?? [];
  for (const handler of handlers) {
    await handler(payload);
  }

  return { handled: true, message: `Issue ${action}: ${issueRef}` };
}

async function handlePushEvent(payload: GitHubPushWebhookPayload): Promise<WebhookResult> {
  const { ref, commits, repository: repo } = payload;
  const branch = ref.replace("refs/heads/", "");
  const count = commits.length;

  log.info(`Push: ${count} commit(s) to ${repo.full_name}/${branch}`);
  logActivity({
    source: "board",
    summary: `GitHub push: ${count} commit(s) to ${repo.full_name}/${branch}`,
  });

  const handlers = eventHandlers.get("push") ?? [];
  for (const handler of handlers) {
    await handler(payload);
  }

  return { handled: true, message: `Push: ${count} commits to ${branch}` };
}

async function handleIssueCommentEvent(payload: GitHubIssueCommentWebhookPayload): Promise<WebhookResult> {
  const { action, issue, comment, repository: repo } = payload;
  if (action !== "created") {
    return { handled: true, message: `Ignoring comment ${action}` };
  }

  const ref = `${repo.full_name}#${issue.number}`;
  log.info(`Comment on ${ref} by ${comment.user.login}`);
  logActivity({
    source: "board",
    summary: `GitHub comment on ${ref} by ${comment.user.login}`,
  });

  const handlers = eventHandlers.get("issue_comment") ?? [];
  for (const handler of handlers) {
    await handler(payload);
  }

  return { handled: true, message: `Comment on ${ref}` };
}

async function handlePRReviewEvent(payload: GitHubPRReviewWebhookPayload): Promise<WebhookResult> {
  const { action, pull_request: pr, review, repository: repo } = payload;
  const ref = `${repo.full_name}#${pr.number}`;

  log.info(`PR review ${action} on ${ref}: ${review.state} by ${review.user.login}`);
  logActivity({
    source: "board",
    summary: `GitHub PR review ${review.state} on ${ref} by ${review.user.login}`,
  });

  const handlers = eventHandlers.get("pull_request_review") ?? [];
  for (const handler of handlers) {
    await handler(payload);
  }

  return { handled: true, message: `PR review ${review.state}: ${ref}` };
}

// ── Main processor ───────────────────────────────────────────────────────────

/**
 * Process a GitHub webhook event. Dispatches based on X-GitHub-Event header.
 */
export async function processWebhook(
  eventType: string,
  payload: unknown,
): Promise<WebhookResult> {
  const p = payload as GitHubWebhookPayload;

  switch (eventType) {
    case "pull_request":
      return handlePullRequestEvent(p as GitHubPRWebhookPayload);
    case "issues":
      return handleIssueEvent(p as GitHubIssueWebhookPayload);
    case "push":
      return handlePushEvent(p as GitHubPushWebhookPayload);
    case "issue_comment":
      return handleIssueCommentEvent(p as GitHubIssueCommentWebhookPayload);
    case "pull_request_review":
      return handlePRReviewEvent(p as GitHubPRReviewWebhookPayload);
    case "ping":
      log.info("GitHub webhook ping received");
      return { handled: true, message: "Pong" };
    default:
      log.info(`Unhandled GitHub event type: ${eventType}`);
      return { handled: false, message: `Unhandled event type: ${eventType}` };
  }
}

// ── Registry integration ─────────────────────────────────────────────────────

/**
 * GitHub webhook provider (deferred registration).
 * Uses HMAC-SHA256 hex with sha256= prefix stripping via the standard factory.
 * Import and pass to registerProviders() in server.ts for batch registration.
 */
export const githubProvider = createHmacSha256HexProvider({
  name: "github",
  stripPrefix: true,
  process: safeHandler("github", async (payload, ctx) => {
    const eventType = (ctx?.eventType as string) ?? "unknown";
    return processWebhook(eventType, payload);
  }),
});
