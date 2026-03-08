/**
 * Dictionary Protocol — Semantic versioning utilities.
 */

const SEMVER_RE = /^\d+\.\d+\.\d+$/;

export interface SemverParts {
  major: number;
  minor: number;
  patch: number;
}

export function parseSemver(version: string): SemverParts {
  if (!SEMVER_RE.test(version)) {
    throw new Error(`Invalid semver: "${version}"`);
  }
  const [major, minor, patch] = version.split(".").map(Number);
  return { major, minor, patch };
}

export function formatSemver(parts: SemverParts): string {
  return `${parts.major}.${parts.minor}.${parts.patch}`;
}

export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  return pa.patch - pb.patch;
}

export function isValidSemver(version: string): boolean {
  return SEMVER_RE.test(version);
}

export function getBumpType(
  from: string,
  to: string,
): "major" | "minor" | "patch" | "none" | "downgrade" {
  const diff = compareSemver(to, from);
  if (diff === 0) return "none";
  if (diff < 0) return "downgrade";

  const f = parseSemver(from);
  const t = parseSemver(to);
  if (t.major > f.major) return "major";
  if (t.minor > f.minor) return "minor";
  return "patch";
}

export function bumpVersion(
  version: string,
  type: "major" | "minor" | "patch",
): string {
  const parts = parseSemver(version);
  switch (type) {
    case "major":
      return formatSemver({ major: parts.major + 1, minor: 0, patch: 0 });
    case "minor":
      return formatSemver({ major: parts.major, minor: parts.minor + 1, patch: 0 });
    case "patch":
      return formatSemver({ major: parts.major, minor: parts.minor, patch: parts.patch + 1 });
  }
}
