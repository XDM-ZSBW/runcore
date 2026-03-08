/**
 * Git signal source — optional tuning layer.
 *
 * Git is a signal source for development tuning and AI engine tuning.
 * It is NOT a runtime dependency. Once an instance is deployed (umbilical
 * detached), git may not exist. All call sites degrade gracefully.
 */

import { execSync } from "node:child_process";

let _gitChecked = false;
let _gitAvailable = false;

/** Check once whether git is on PATH and cwd is a repo. Cached after first call. */
export function gitAvailable(): boolean {
  if (_gitChecked) return _gitAvailable;
  _gitChecked = true;
  try {
    execSync("git rev-parse --is-inside-work-tree", {
      encoding: "utf-8",
      timeout: 3_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    _gitAvailable = true;
  } catch {
    _gitAvailable = false;
  }
  return _gitAvailable;
}

/** Run a git command, return stdout or null on failure. Returns null if git unavailable. */
export function git(cmd: string, cwd?: string): string | null {
  if (!gitAvailable()) return null;
  try {
    return execSync(`git ${cmd}`, {
      cwd: cwd ?? process.cwd(),
      encoding: "utf-8",
      timeout: 15_000,
    }).trim();
  } catch {
    return null;
  }
}
