/**
 * Shared test helpers: temp directories, cleanup, and mock factories.
 */

import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

/** Create a temporary directory that auto-cleans up. */
export async function createTempDir(prefix = "dash-test-"): Promise<{
  dir: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return {
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

/** Set up a brain directory structure in a temp dir. */
export async function createTestBrainDir(): Promise<{
  brainDir: string;
  memoryDir: string;
  identityDir: string;
  vaultDir: string;
  sessionsDir: string;
  operationsDir: string;
  agentsDir: string;
  cleanup: () => Promise<void>;
}> {
  const { dir, cleanup } = await createTempDir("dash-brain-");
  const brainDir = join(dir, "brain");
  const memoryDir = join(brainDir, "memory");
  const identityDir = join(brainDir, "identity");
  const vaultDir = join(brainDir, "vault");
  const sessionsDir = join(brainDir, "sessions");
  const operationsDir = join(brainDir, "operations");
  const agentsDir = join(brainDir, "agents", "tasks");

  await Promise.all([
    mkdir(memoryDir, { recursive: true }),
    mkdir(identityDir, { recursive: true }),
    mkdir(vaultDir, { recursive: true }),
    mkdir(sessionsDir, { recursive: true }),
    mkdir(operationsDir, { recursive: true }),
    mkdir(agentsDir, { recursive: true }),
  ]);

  return {
    brainDir,
    memoryDir,
    identityDir,
    vaultDir,
    sessionsDir,
    operationsDir,
    agentsDir,
    cleanup,
  };
}

/** Generate a random AES-256 key buffer for testing. */
export function randomKey(): Buffer {
  return randomBytes(32);
}

/** Wait for a specified number of ms. */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Generate a unique test identifier. */
export function uniqueId(prefix = "test"): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/** Write a JSONL file with schema header + entries. */
export async function writeJsonlFile(
  path: string,
  schema: string,
  entries: Record<string, unknown>[],
): Promise<void> {
  const lines = [
    JSON.stringify({ _schema: schema, _version: "1.0" }),
    ...entries.map((e) => JSON.stringify(e)),
  ];
  await writeFile(path, lines.join("\n") + "\n", "utf-8");
}

/** Read and parse a JSON file. */
export async function readJsonFile<T = unknown>(path: string): Promise<T> {
  const raw = await readFile(path, "utf-8");
  return JSON.parse(raw) as T;
}
