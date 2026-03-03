/**
 * Release notes generator — produces structured release notes from commits.
 *
 * Groups commits by type (features, fixes, etc.) using conventional commit
 * parsing. Detects breaking changes and lists contributors.
 * Outputs structured data + formatted markdown.
 */

import { createLogger } from "../utils/logger.js";
import { logActivity } from "../activity/log.js";
import * as client from "./client.js";
import type {
  ReleaseNotes,
  ReleaseNotesSection,
  ReleaseNoteEntry,
} from "./types.js";

const log = createLogger("github.release-notes");

// ── Conventional commit parsing ──────────────────────────────────────────────

const CONVENTIONAL_RE = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(?:\((.+?)\))?(!)?:\s(.+)/;

interface ParsedCommit {
  type: string;
  scope?: string;
  breaking: boolean;
  description: string;
  sha: string;
  author: string;
  raw: string;
}

function parseCommitMessage(sha: string, message: string, author: string): ParsedCommit {
  const firstLine = message.split("\n")[0].trim();
  const match = firstLine.match(CONVENTIONAL_RE);

  if (match) {
    return {
      type: match[1],
      scope: match[2] || undefined,
      breaking: match[3] === "!" || /BREAKING.CHANGE/i.test(message),
      description: match[4],
      sha,
      author,
      raw: firstLine,
    };
  }

  // Non-conventional: try to categorize by keywords
  const lower = firstLine.toLowerCase();
  let type = "other";
  if (/^merge\s/i.test(lower)) type = "merge";
  else if (/\b(fix|bug|patch|hotfix)\b/.test(lower)) type = "fix";
  else if (/\b(add|feat|feature|implement|new)\b/.test(lower)) type = "feat";
  else if (/\b(doc|readme)\b/.test(lower)) type = "docs";
  else if (/\b(refactor|restructure|cleanup)\b/.test(lower)) type = "refactor";
  else if (/\b(test|spec)\b/.test(lower)) type = "test";
  else if (/\b(ci|pipeline|workflow)\b/.test(lower)) type = "ci";
  else if (/\b(perf|optimize|speed)\b/.test(lower)) type = "perf";

  return {
    type,
    breaking: /BREAKING.CHANGE/i.test(message),
    description: firstLine,
    sha,
    author,
    raw: firstLine,
  };
}

// ── Section configuration ────────────────────────────────────────────────────

interface SectionDef {
  title: string;
  icon: string;
  types: string[];
}

const SECTION_ORDER: SectionDef[] = [
  { title: "Breaking Changes", icon: "💥", types: [] }, // Special: populated from breaking flag
  { title: "Features", icon: "✨", types: ["feat"] },
  { title: "Bug Fixes", icon: "🐛", types: ["fix"] },
  { title: "Performance", icon: "⚡", types: ["perf"] },
  { title: "Documentation", icon: "📝", types: ["docs"] },
  { title: "Refactoring", icon: "♻️", types: ["refactor"] },
  { title: "Tests", icon: "🧪", types: ["test"] },
  { title: "CI/CD", icon: "🔧", types: ["ci", "build"] },
  { title: "Chores", icon: "🧹", types: ["chore"] },
  { title: "Other", icon: "📦", types: ["other", "revert", "style"] },
];

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Generate release notes from commits between two refs (tags, SHAs, or branches).
 */
export async function generateReleaseNotes(
  owner: string,
  repo: string,
  opts: { from: string; to?: string; version?: string },
): Promise<ReleaseNotes | null> {
  const to = opts.to ?? "HEAD";
  log.info(`Generating release notes for ${owner}/${repo}: ${opts.from}..${to}`);

  const comparison = await client.compareBranches(owner, repo, opts.from, to);
  if (!comparison) {
    log.warn(`Failed to compare ${opts.from}..${to}`);
    return null;
  }

  if (comparison.commits.length === 0) {
    log.info("No commits found between the two refs.");
    return {
      repo: `${owner}/${repo}`,
      version: opts.version ?? to,
      from: opts.from,
      to,
      generatedAt: new Date().toISOString(),
      sections: [],
      breakingChanges: [],
      contributors: [],
      markdown: `## ${opts.version ?? to}\n\nNo changes.`,
    };
  }

  // Parse all commits
  const parsed: ParsedCommit[] = comparison.commits
    .filter((c) => !c.commit.message.startsWith("Merge ")) // Skip merge commits
    .map((c) => parseCommitMessage(
      c.sha,
      c.commit.message,
      c.commit.author?.name ?? "Unknown",
    ));

  // Collect breaking changes
  const breakingChanges = parsed
    .filter((c) => c.breaking)
    .map((c) => c.scope ? `**${c.scope}:** ${c.description}` : c.description);

  // Collect unique contributors
  const contributors = [...new Set(parsed.map((c) => c.author))].sort();

  // Build sections
  const sections: ReleaseNotesSection[] = [];
  for (const def of SECTION_ORDER) {
    // Skip the "Breaking Changes" section (handled separately in markdown)
    if (def.types.length === 0) continue;

    const entries: ReleaseNoteEntry[] = parsed
      .filter((c) => def.types.includes(c.type))
      .map((c) => ({
        sha: c.sha.slice(0, 7),
        message: c.description,
        author: c.author,
        scope: c.scope,
      }));

    if (entries.length > 0) {
      sections.push({ title: def.title, icon: def.icon, commits: entries });
    }
  }

  const version = opts.version ?? to;
  const markdown = formatReleaseNotes(version, sections, breakingChanges, contributors);

  const result: ReleaseNotes = {
    repo: `${owner}/${repo}`,
    version,
    from: opts.from,
    to,
    generatedAt: new Date().toISOString(),
    sections,
    breakingChanges,
    contributors,
    markdown,
  };

  logActivity({
    source: "board",
    summary: `Release notes: ${owner}/${repo} ${version} — ${parsed.length} commits, ${contributors.length} contributors`,
  });

  return result;
}

/**
 * Generate release notes from the latest tag to HEAD.
 */
export async function generateReleaseNotesFromLatestTag(
  owner: string,
  repo: string,
  opts?: { version?: string },
): Promise<ReleaseNotes | null> {
  const tags = await client.listTags(owner, repo, { per_page: 1 });
  if (!tags || tags.length === 0) {
    log.warn(`No tags found for ${owner}/${repo}`);
    return null;
  }

  return generateReleaseNotes(owner, repo, {
    from: tags[0].name,
    to: "HEAD",
    version: opts?.version,
  });
}

// ── Formatting ───────────────────────────────────────────────────────────────

function formatReleaseNotes(
  version: string,
  sections: ReleaseNotesSection[],
  breakingChanges: string[],
  contributors: string[],
): string {
  const lines: string[] = [];
  lines.push(`## ${version}`);
  lines.push("");

  if (breakingChanges.length > 0) {
    lines.push("### 💥 Breaking Changes");
    lines.push("");
    for (const bc of breakingChanges) {
      lines.push(`- ${bc}`);
    }
    lines.push("");
  }

  for (const section of sections) {
    lines.push(`### ${section.icon} ${section.title}`);
    lines.push("");
    for (const entry of section.commits) {
      const scope = entry.scope ? `**${entry.scope}:** ` : "";
      lines.push(`- ${scope}${entry.message} (${entry.sha})`);
    }
    lines.push("");
  }

  if (contributors.length > 0) {
    lines.push("### Contributors");
    lines.push("");
    lines.push(contributors.map((c) => `@${c}`).join(", "));
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

/**
 * Generate release notes purely from commit data (no API calls).
 * Useful for testing or when commit data is already available.
 */
export function generateReleaseNotesFromCommits(
  repo: string,
  version: string,
  commits: Array<{ sha: string; message: string; author: string }>,
): ReleaseNotes {
  const parsed = commits
    .filter((c) => !c.message.startsWith("Merge "))
    .map((c) => parseCommitMessage(c.sha, c.message, c.author));

  const breakingChanges = parsed
    .filter((c) => c.breaking)
    .map((c) => c.scope ? `**${c.scope}:** ${c.description}` : c.description);

  const contributors = [...new Set(parsed.map((c) => c.author))].sort();

  const sections: ReleaseNotesSection[] = [];
  for (const def of SECTION_ORDER) {
    if (def.types.length === 0) continue;

    const entries: ReleaseNoteEntry[] = parsed
      .filter((c) => def.types.includes(c.type))
      .map((c) => ({
        sha: c.sha.slice(0, 7),
        message: c.description,
        author: c.author,
        scope: c.scope,
      }));

    if (entries.length > 0) {
      sections.push({ title: def.title, icon: def.icon, commits: entries });
    }
  }

  const markdown = formatReleaseNotes(version, sections, breakingChanges, contributors);

  return {
    repo,
    version,
    from: "",
    to: "",
    generatedAt: new Date().toISOString(),
    sections,
    breakingChanges,
    contributors,
    markdown,
  };
}
