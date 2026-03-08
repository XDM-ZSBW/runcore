/**
 * Tests for governance scope ceiling (src/agents/governance.ts).
 *
 * Validates that agents cannot widen their parent's scope — cwd must
 * fall within the inherited scope ceiling.
 */

import { describe, it, expect, vi } from "vitest";

// Mock dependencies to isolate scope ceiling logic
vi.mock("../../src/voucher.js", () => ({
  issueVoucher: vi.fn().mockResolvedValue("test-voucher"),
  checkVoucher: vi.fn(),
  revokeVoucher: vi.fn(),
}));

vi.mock("../../src/lib/locked.js", () => ({
  loadLockedPaths: vi.fn().mockResolvedValue([]),
  getLockedPaths: vi.fn().mockReturnValue([]),
}));

vi.mock("../../src/agents/spawn-policy.js", () => ({
  loadSpawnPolicy: vi.fn(),
  checkSpawnPolicy: vi.fn(),
}));

vi.mock("../../src/activity/log.js", () => ({
  logActivity: vi.fn(),
  generateTraceId: vi.fn().mockReturnValue("test-trace"),
}));

vi.mock("../../src/lib/paths.js", () => ({
  BRAIN_DIR: "/test/brain",
}));

vi.mock("../../src/instance.js", () => ({
  resolveEnv: () => "/test/brain",
}));

// Stub readFile for principles loading
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn().mockRejectedValue(new Error("not found")),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  unlink: vi.fn(),
}));

import { narrowScopeCeiling, governanceGate } from "../../src/agents/governance.js";
import { InMemoryLongTermMemory } from "../../src/memory/long-term.js";

// ---------------------------------------------------------------------------
// narrowScopeCeiling
// ---------------------------------------------------------------------------

describe("narrowScopeCeiling", () => {
  it("returns cwd when no parent ceiling exists", () => {
    const result = narrowScopeCeiling(undefined, "/projects/core");
    // Should resolve to absolute
    expect(result).toContain("projects");
    expect(result).toContain("core");
  });

  it("returns cwd when it's inside the ceiling (narrows)", () => {
    const result = narrowScopeCeiling("/projects", "/projects/core");
    expect(result.toLowerCase()).toContain("core");
  });

  it("returns ceiling when cwd equals ceiling", () => {
    const result = narrowScopeCeiling("/projects/core", "/projects/core");
    expect(result.toLowerCase()).toContain("core");
  });

  it("returns ceiling when cwd is outside (fallback)", () => {
    const result = narrowScopeCeiling("/projects/core", "/other/place");
    expect(result.toLowerCase()).toContain("core");
  });

  it("uses process.cwd() when cwd is undefined", () => {
    const result = narrowScopeCeiling(undefined, undefined);
    // Should be a valid absolute path
    expect(result).toBeTruthy();
    expect(typeof result).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Scope ceiling validation in governanceGate
// ---------------------------------------------------------------------------

describe("governanceGate scope ceiling", () => {
  const ltm = new InMemoryLongTermMemory();

  it("allows spawn when cwd is inside ceiling", async () => {
    const result = await governanceGate({
      taskId: "test-1",
      label: "test task",
      prompt: "do something",
      origin: "user",
      ltm,
      skipVoucher: true,
      cwd: "/projects/core/src",
      scopeCeiling: "/projects/core",
    });

    expect(result.allowed).toBe(true);
  });

  it("allows spawn when cwd equals ceiling", async () => {
    const result = await governanceGate({
      taskId: "test-2",
      label: "test task",
      prompt: "do something",
      origin: "user",
      ltm,
      skipVoucher: true,
      cwd: "/projects/core",
      scopeCeiling: "/projects/core",
    });

    expect(result.allowed).toBe(true);
  });

  it("denies spawn when cwd escapes ceiling", async () => {
    const result = await governanceGate({
      taskId: "test-3",
      label: "test task",
      prompt: "do something",
      origin: "user",
      ltm,
      skipVoucher: true,
      cwd: "/other/project",
      scopeCeiling: "/projects/core",
    });

    expect(result.allowed).toBe(false);
    expect(result.deniedReason).toContain("Scope violation");
    expect(result.deniedReason).toContain("escapes ceiling");
  });

  it("denies spawn when cwd is a sibling directory", async () => {
    const result = await governanceGate({
      taskId: "test-4",
      label: "test task",
      prompt: "do something",
      origin: "user",
      ltm,
      skipVoucher: true,
      cwd: "/projects/dash",
      scopeCeiling: "/projects/core",
    });

    expect(result.allowed).toBe(false);
    expect(result.deniedReason).toContain("Scope violation");
  });

  it("allows spawn when no ceiling is set", async () => {
    const result = await governanceGate({
      taskId: "test-5",
      label: "test task",
      prompt: "do something",
      origin: "user",
      ltm,
      skipVoucher: true,
      cwd: "/anywhere",
    });

    expect(result.allowed).toBe(true);
  });

  it("allows spawn when no cwd is set", async () => {
    const result = await governanceGate({
      taskId: "test-6",
      label: "test task",
      prompt: "do something",
      origin: "user",
      ltm,
      skipVoucher: true,
      scopeCeiling: "/projects/core",
    });

    expect(result.allowed).toBe(true);
  });

  it("denies parent traversal attack (../)", async () => {
    const result = await governanceGate({
      taskId: "test-7",
      label: "test task",
      prompt: "do something",
      origin: "user",
      ltm,
      skipVoucher: true,
      cwd: "/projects/core/../../etc",
      scopeCeiling: "/projects/core",
    });

    expect(result.allowed).toBe(false);
  });
});
