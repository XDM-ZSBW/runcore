/**
 * Minimal glob matcher for brain-relative paths.
 *
 * Supports:
 *   - `**`  — match any number of path segments (including zero)
 *   - `*`   — match a single path segment (no slashes)
 *   - exact — literal string match
 *
 * No external dependencies. Used by vault policy + access manifests.
 */

/**
 * Convert a glob pattern to a RegExp.
 * Patterns are matched against forward-slash-normalized brain-relative paths.
 */
function globToRegex(pattern: string): RegExp {
  // Normalize
  const p = pattern.replace(/\\/g, "/").replace(/\/+$/, "");

  let regex = "^";
  let i = 0;
  while (i < p.length) {
    if (p[i] === "*" && p[i + 1] === "*") {
      // ** — match any depth (including zero segments)
      // Consume trailing slash if present
      i += 2;
      if (p[i] === "/") i++;
      regex += "(?:.+/)?";
    } else if (p[i] === "*") {
      // * — match single segment (no slashes)
      regex += "[^/]+";
      i++;
    } else if (".+?^${}()|[]\\".includes(p[i])) {
      // Escape regex special chars
      regex += "\\" + p[i];
      i++;
    } else {
      regex += p[i];
      i++;
    }
  }
  regex += "$";

  return new RegExp(regex);
}

/**
 * Test whether a brain-relative path matches a glob pattern.
 *
 * @param pattern - Glob pattern (e.g. "memory/**", "identity/*.md", "ops/audit.jsonl")
 * @param path    - Brain-relative path with forward slashes (e.g. "memory/semantic.jsonl")
 */
export function matchGlob(pattern: string, path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  const re = globToRegex(pattern);
  return re.test(normalized);
}

/**
 * Test whether a path matches ANY of the given glob patterns.
 */
export function matchAnyGlob(patterns: string[], path: string): boolean {
  return patterns.some((p) => matchGlob(p, path));
}
