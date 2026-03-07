/**
 * Canonical path constants for the Core runtime.
 * All brain path references import from here — no file defines its own BRAIN_DIR.
 *
 * Packages are code only, no data ever. The brain lives outside the package,
 * configured via CORE_BRAIN_DIR (or DASH_BRAIN_DIR) environment variable.
 * Default: process.cwd() + "brain" for backward compatibility.
 */

import { resolve, join } from "node:path";
import { resolveEnv } from "../instance.js";

/** Absolute path to the brain data directory. */
export const BRAIN_DIR: string = resolve(
  resolveEnv("BRAIN_DIR") ?? join(process.cwd(), "brain"),
);
