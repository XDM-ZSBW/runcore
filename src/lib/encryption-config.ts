/**
 * Encryption configuration for brain files at rest.
 * Only episodic/personal memory files are encrypted. Structural files
 * (goals, queue, open-loops, settings, skills, templates) stay plaintext
 * for git-diffability and debugging.
 */

import { basename } from "node:path";

/** Brain files that contain personal data and must be encrypted. */
const ENCRYPTED_FILES = new Set([
  // Episodic memory
  "experiences.jsonl",
  "decisions.jsonl",
  "failures.jsonl",
  "triads.jsonl",
  "personal.enc.jsonl",
  // Knowledge & reasoning (contain encrypted entries)
  "semantic.jsonl",
  "embeddings.jsonl",
  "open-loops.jsonl",
  "resonances.jsonl",
  // Contacts (personal relationship data)
  "entities.jsonl",
  "edges.jsonl",
  // Credentials (secrets at rest)
  "credentials.enc.jsonl",
]);

/**
 * Check if a specific brain file should be encrypted.
 * Only files in the ENCRYPTED_FILES allowlist are encrypted.
 */
export function shouldEncryptFile(fileName: string): boolean {
  return ENCRYPTED_FILES.has(basename(fileName));
}

/** Get the basenames of files that are encrypted. */
export function getEncryptedFiles(): string[] {
  return Array.from(ENCRYPTED_FILES);
}

/** Alias for getEncryptedFiles (used by tests). */
export const getEncryptedFileList = getEncryptedFiles;
