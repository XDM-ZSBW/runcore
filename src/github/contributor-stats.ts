/**
 * Contributor stats — compute activity metrics for repository contributors.
 *
 * Tracks: commits per author, PRs opened/merged, reviews given,
 * lines added/removed.
 */

import { createLogger } from "../utils/logger.js";
import { logActivity } from "../activity/log.js";
import * as client from "./client.js";
import type {
  ContributorStats,
  ContributorProfile,
} from "./types.js";

const log = createLogger("github.contributor-stats");

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Compute contributor stats for a repository over a given period.
 */
export async function getContributorStats(
  owner: string,
  repo: string,
  opts?: { days?: number },
): Promise<ContributorStats | null> {
  const days = opts?.days ?? 30;
  const since = new Date(Date.now() - days * MS_PER_DAY).toISOString();

  log.info(`Computing contributor stats for ${owner}/${repo} (last ${days} days)`);

  // Fetch data in parallel
  const [commits, prs] = await Promise.all([
    client.listCommits(owner, repo, { since, per_page: 100 }),
    client.listPullRequests(owner, repo, { state: "all", per_page: 100 }),
  ]);

  if (!commits) {
    log.warn(`Failed to fetch data for ${owner}/${repo}`);
    return null;
  }

  // Filter PRs to the time period
  const periodPRs = (prs ?? []).filter((pr) => {
    const created = new Date(pr.created_at).getTime();
    return created >= new Date(since).getTime();
  });

  // Build contributor map keyed by login or email
  const profileMap = new Map<string, ContributorProfile>();

  function getOrCreate(key: string): ContributorProfile {
    let p = profileMap.get(key);
    if (!p) {
      p = {
        login: key,
        commits: 0,
        prsOpened: 0,
        prsMerged: 0,
        reviewsGiven: 0,
        linesAdded: 0,
        linesRemoved: 0,
      };
      profileMap.set(key, p);
    }
    return p;
  }

  // Aggregate commits
  for (const c of commits) {
    const authorKey = c.commit.author?.email ?? c.commit.author?.name ?? "unknown";
    const profile = getOrCreate(authorKey);
    profile.commits++;
  }

  // Aggregate PRs
  for (const pr of periodPRs) {
    const login = pr.user.login;
    const profile = getOrCreate(login);
    profile.prsOpened++;
    if (pr.merged) {
      profile.prsMerged++;
      profile.linesAdded += pr.additions;
      profile.linesRemoved += pr.deletions;
    }
  }

  // Fetch review counts for each PR (limited to first 20 PRs to avoid rate limits)
  const prsToCheck = periodPRs.slice(0, 20);
  for (const pr of prsToCheck) {
    const reviews = await client.getPRReviews(owner, repo, pr.number);
    if (!reviews) continue;

    for (const review of reviews) {
      if (review.state === "PENDING") continue;
      const profile = getOrCreate(review.user.login);
      profile.reviewsGiven++;
    }
  }

  const contributors = [...profileMap.values()]
    .sort((a, b) => b.commits - a.commits);

  const result: ContributorStats = {
    repo: `${owner}/${repo}`,
    period: { from: since, to: new Date().toISOString() },
    contributors,
    generatedAt: new Date().toISOString(),
  };

  logActivity({
    source: "board",
    summary: `Contributor stats: ${owner}/${repo} — ${contributors.length} contributors, ${commits.length} commits`,
  });

  return result;
}

/**
 * Format contributor stats as a markdown table.
 */
export function formatContributorStats(stats: ContributorStats): string {
  const lines: string[] = [];
  lines.push(`## Contributor Stats: ${stats.repo}`);
  lines.push("");
  lines.push(`*Period: ${new Date(stats.period.from).toLocaleDateString()} – ${new Date(stats.period.to).toLocaleDateString()}*`);
  lines.push("");

  if (stats.contributors.length === 0) {
    lines.push("No contributor activity in this period.");
    return lines.join("\n");
  }

  lines.push("| Contributor | Commits | PRs Opened | PRs Merged | Reviews | Lines +/- |");
  lines.push("|-------------|---------|------------|------------|---------|-----------|");

  for (const c of stats.contributors) {
    const linesChanged = c.linesAdded + c.linesRemoved > 0
      ? `+${c.linesAdded}/-${c.linesRemoved}`
      : "—";
    lines.push(
      `| ${c.login} | ${c.commits} | ${c.prsOpened} | ${c.prsMerged} | ${c.reviewsGiven} | ${linesChanged} |`,
    );
  }

  return lines.join("\n");
}
