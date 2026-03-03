/**
 * Auto-commit agent work in logical batches.
 * After a batch of agents completes, commit all uncommitted changes
 * with a meaningful message summarizing what the agents did.
 *
 * Never throws — returns { ok, message }.
 */

import { execSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { logActivity } from "../activity/log.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("agent-commit");

const CWD = process.cwd();

/** Run a git command, return stdout or null on failure. */
function git(cmd: string): string | null {
  try {
    return execSync(`git ${cmd}`, { cwd: CWD, encoding: "utf-8", timeout: 15_000 }).trim();
  } catch {
    return null;
  }
}

/** Check if there are uncommitted changes (staged or unstaged, including untracked). */
export function hasUncommittedChanges(): boolean {
  const status = git("status --porcelain");
  return !!status && status.length > 0;
}

/** Get a short summary of what changed (for commit message). */
function getChangeSummary(): { files: string[]; summary: string } {
  const status = git("status --porcelain") ?? "";
  const lines = status.split("\n").filter((l) => l.trim().length > 0);

  const files = lines.map((l) => l.slice(3).trim());

  // Group by directory
  const dirs = new Map<string, number>();
  for (const f of files) {
    const dir = f.includes("/") ? f.split("/").slice(0, 2).join("/") : f;
    dirs.set(dir, (dirs.get(dir) ?? 0) + 1);
  }

  const parts: string[] = [];
  for (const [dir, count] of [...dirs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
    parts.push(`${dir} (${count})`);
  }

  return {
    files,
    summary: parts.join(", "),
  };
}

/**
 * Commit all agent work as a logical batch.
 * @param agentResults - What the agents did (for commit message)
 * @param round - Which continuation round this is
 */
export async function commitAgentBatch(
  agentResults: Array<{ label: string; status: string }>,
  round: number,
): Promise<{ ok: boolean; message: string }> {
  log.info(`Committing agent batch`, { round, agentCount: agentResults.length });
  if (!hasUncommittedChanges()) {
    log.debug("No uncommitted changes to commit");
    return { ok: true, message: "No changes to commit" };
  }

  const { files, summary } = getChangeSummary();

  // Build commit message from agent results
  const completed = agentResults.filter((r) => r.status === "completed");
  const failed = agentResults.filter((r) => r.status === "failed");

  const title = completed.length === 1
    ? completed[0].label
    : `Agent batch: ${completed.map((r) => r.label).join(", ")}`;

  // Truncate title to 72 chars for git convention
  const shortTitle = title.length > 72 ? title.slice(0, 69) + "..." : title;

  const body: string[] = [];
  if (completed.length > 0) {
    body.push(`Completed (${completed.length}):`);
    for (const r of completed) {
      body.push(`  - ${r.label}`);
    }
  }
  if (failed.length > 0) {
    body.push(`Failed (${failed.length}):`);
    for (const r of failed) {
      body.push(`  - ${r.label}`);
    }
  }
  body.push("");
  body.push(`Files: ${files.length} changed (${summary})`);
  body.push(`Round: ${round}`);

  const commitMsg = `${shortTitle}\n\n${body.join("\n")}`;

  try {
    // Stage all changes (including untracked files in src/, brain/, public/, docs/)
    git("add src/ brain/ public/ docs/ test/ vitest.config.ts package.json package-lock.json tsconfig.json");

    // Also add any other modified tracked files
    git("add -u");

    // Check if anything is actually staged
    const staged = git("diff --cached --name-only");
    if (!staged || staged.length === 0) {
      return { ok: true, message: "No staged changes to commit" };
    }

    // Commit using a temp file for the message (avoids shell escaping issues)
    const msgPath = join(CWD, ".git", "AGENT_COMMIT_MSG");
    writeFileSync(msgPath, commitMsg, "utf-8");
    const result = git(`commit -F "${msgPath}"`);
    try { unlinkSync(msgPath); } catch { /* cleanup best-effort */ }
    if (result === null) {
      return { ok: false, message: "Git commit failed" };
    }

    const stagedFiles = staged.split("\n").filter((l) => l.trim().length > 0);
    logActivity({
      source: "system",
      summary: `Auto-committed: ${shortTitle} (${stagedFiles.length} files)`,
    });

    return { ok: true, message: `Committed ${stagedFiles.length} files: ${shortTitle}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logActivity({ source: "system", summary: `Auto-commit failed: ${msg}` });
    return { ok: false, message: `Commit failed: ${msg}` };
  }
}
