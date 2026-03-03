# Agent Task Templates Spec

Reusable patterns for spawning agent tasks via the Dash runtime. Each template defines a prompt structure, expected inputs/outputs, file operations, and success criteria grounded in the actual `src/agents/` infrastructure.

## How agents work in Dash

Agents are Claude CLI subprocesses spawned via `submitTask()`. The lifecycle:

```
submitTask(input) → createTask() → spawnAgent() → detached child process
  ↓ on exit
updateTask(status, output) → rememberTaskOutcome() → pushNotification()
  ↓ if sessionId batch completes
continueAfterBatch() → parse AGENT_REQUEST blocks → spawn next round (max 5)
```

Key constraints:
- Prompts written to file (`brain/agents/logs/{id}.prompt.txt`), not passed via shell
- `claude --print --output-format text --dangerously-skip-permissions` is the execution command
- Output captured to `brain/agents/logs/{id}.stdout` and `.stderr`
- `resultSummary` is first 1000 chars of stdout
- Vague prompts (buzzwords without file paths) are rejected before spawning
- Max 5 concurrent agents (configurable via `DASH_RUNTIME_MAX_AGENTS`)
- Default timeout: 10 minutes per agent

## Prompt anatomy

Every agent prompt should follow this structure:

```
[CONTEXT]       — What the agent needs to know (file contents, state, constraints)
[TASK]          — Exactly what to do, in imperative form
[OUTPUT]        — Expected output format and where to write it
[CONSTRAINTS]   — Boundaries: don't modify X, stay within Y files, etc.
```

The anti-pattern (caught by vague-prompt filter):
```
❌ "Create a comprehensive, production-ready solution for improving code quality"
✓  "Read src/agents/spawn.ts. Find the exit handler. Add a retry on non-zero exit codes
    with exponential backoff (base 2s, max 3 retries). Write the changes in-place."
```

File path references (`src/`, `brain/`, `.ts`, `.js`, `.md`) are required to pass the vague-prompt check in `server.ts`.

---

## Template 1: Code Review and Analysis

**When to use**: Reviewing a file or set of files for correctness, style, security, or architectural fit. Not for fixing — only analysis and reporting.

### Prompt pattern

```
You are reviewing code in the Dash codebase at E:\Dash.

Read these files:
- {file_paths}

Review focus: {focus_area}

Context:
{relevant_context — e.g. the PR description, the related issue, architectural constraints}

Produce a review as a markdown list with these categories:
- **Critical**: Bugs, security issues, data loss risks
- **Improvement**: Performance, readability, maintainability
- **Nit**: Style, naming, minor preferences
- **Positive**: Things done well (always include at least one)

For each item, include the file path and line number.
Write your review to brain/agents/logs/{task_id}.stdout (automatic via --print).
```

### Inputs

| Field | Required | Example |
|-------|----------|---------|
| `file_paths` | Yes | `src/agents/spawn.ts`, `src/agents/monitor.ts` |
| `focus_area` | Yes | `"error handling and edge cases"`, `"security (OWASP top 10)"`, `"TypeScript type safety"` |
| `relevant_context` | No | PR description, issue body, or architectural notes |

### Outputs

- **stdout**: Markdown review with categorized findings
- **Memory**: Episodic entry: `"Code review of {files}: {finding_count} items found"`
- **Board**: Optional — comment on linked issue via `addComment(issueId, summary)`

### File operations

| Operation | Files | Mode |
|-----------|-------|------|
| Read | Target source files | Read-only |
| Read | Related test files (if reviewing for coverage) | Read-only |
| Write | None — output goes to stdout only | — |

### Success criteria

1. Output is valid markdown with at least one item per non-empty category
2. Every finding references a specific file and line
3. No files modified (review is read-only)
4. Exit code 0

### Example AGENT_REQUEST

```json
[AGENT_REQUEST]
{
  "label": "Review spawn.ts error handling",
  "prompt": "Read src/agents/spawn.ts. Review for error handling completeness. Check: Are all child process events handled (exit, error, disconnect)? Are timeouts enforced? Is cleanup reliable on Windows (taskkill) and Unix (SIGTERM)? Output a categorized markdown review (Critical / Improvement / Nit / Positive) with file:line references."
}
[/AGENT_REQUEST]
```

---

## Template 2: Bug Investigation and Debugging

**When to use**: Investigating a reported bug or unexpected behavior. The agent traces the issue through the codebase, identifies root cause, and proposes a fix — but does not apply it unless explicitly told to.

### Prompt pattern

```
You are debugging an issue in the Dash codebase at E:\Dash.

Symptom: {symptom_description}

Reproduction: {steps_or_conditions}

Start by reading these files (likely involved):
- {suspect_files}

Investigation steps:
1. Trace the execution path from {entry_point} through the relevant call chain
2. Identify where the actual behavior diverges from expected behavior
3. Check for related issues in adjacent code (callers, error handlers, edge cases)
4. If the bug involves state, check initialization and mutation points

Output format:
## Root cause
{one paragraph}

## Evidence
{file:line references showing the problematic code}

## Proposed fix
{specific code changes, with before/after}

## Risk assessment
{what else could break, what tests to run}
```

### Inputs

| Field | Required | Example |
|-------|----------|---------|
| `symptom_description` | Yes | `"Agent tasks stuck in 'running' after process exits"` |
| `steps_or_conditions` | Yes | `"Spawn an agent, kill the process externally. Task stays 'running' forever."` |
| `suspect_files` | Yes | `src/agents/monitor.ts`, `src/agents/spawn.ts` |
| `entry_point` | No | `"spawnAgent() in src/agents/spawn.ts"` |

### Outputs

- **stdout**: Root cause analysis with evidence, proposed fix, and risk assessment
- **Memory**: Episodic entry: `"Investigated bug: {symptom}. Root cause: {cause}"`
- **Memory** (if novel): Procedural entry for the debugging technique used

### File operations

| Operation | Files | Mode |
|-----------|-------|------|
| Read | Suspect files + their imports/callers | Read-only |
| Read | Related test files | Read-only |
| Read | Log files in `brain/agents/logs/` if relevant | Read-only |
| Write | None (investigation only) | — |

### Success criteria

1. Root cause identified with specific file:line evidence
2. Proposed fix is concrete (not "consider improving error handling")
3. Risk assessment covers regression surface
4. No files modified unless the prompt explicitly says "fix it"
5. Exit code 0

### Variant: Bug fix (investigation + apply)

Append to the prompt:
```
After identifying the root cause, apply the fix directly. Only modify the minimum
files necessary. Do not refactor surrounding code.
```

Additional success criteria for the fix variant:
- Modified files compile (`npm run build` passes)
- Changes are minimal and targeted

---

## Template 3: Feature Implementation

**When to use**: Building a new capability or extending existing functionality. Follows the three-pass workflow: this template covers Pass 2 (spec + build). Pass 1 (intent) comes from the user; Pass 3 (review) is a separate code review agent.

### Prompt pattern

```
You are implementing a feature in the Dash codebase at E:\Dash.

Intent (from user): {pass_1_intent}

Architecture context:
- This codebase uses: TypeScript, ESM, Hono server, file-backed JSONL memory
- Key patterns to follow: {patterns}
- Related existing code: {related_files}

Read these files first to understand the patterns:
- {reference_files}

Implementation requirements:
{numbered_requirements}

File plan:
- Create: {new_files}
- Modify: {modified_files}
- Do not touch: {protected_files}

After implementation:
1. Verify the build succeeds: run `npm run build`
2. Export new public APIs from the appropriate index.ts
3. If you created types, add them to src/types.ts or a local types.ts

Do not:
- Add tests (separate task)
- Add documentation (separate task)
- Refactor existing code beyond what's needed
- Install new dependencies without stating why
```

### Inputs

| Field | Required | Example |
|-------|----------|---------|
| `pass_1_intent` | Yes | `"I want agents to be able to pause and resume mid-task"` |
| `patterns` | Yes | `"Module-level timer pattern (src/goals/timer.ts), append-only JSONL, fire-and-forget background ops"` |
| `reference_files` | Yes | Files showing the pattern to follow |
| `numbered_requirements` | Yes | Specific implementation steps |
| `new_files` | No | Files to create |
| `modified_files` | Yes | Files that will change |
| `protected_files` | No | Files that must not be touched |

### Outputs

- **stdout**: Summary of what was built, files changed, and any decisions made
- **Files**: New/modified source files
- **Memory**: Episodic entry: `"Implemented {feature}. Files: {list}. Decisions: {key_decisions}"`
- **Board**: Update linked issue state to `in_progress` or `done`

### File operations

| Operation | Files | Mode |
|-----------|-------|------|
| Read | Reference files, existing modules | Read-only |
| Create | New source files per file plan | Create |
| Modify | Existing files per file plan | Edit |
| Read + Run | `npm run build` for verification | Shell |

### Success criteria

1. `npm run build` succeeds with no errors
2. New exports are accessible from their module's index.ts
3. Implementation matches the stated intent (not more, not less)
4. Follows existing patterns (naming, file structure, error handling)
5. No unrelated changes
6. Exit code 0

### Batch pattern: Feature + Review

Spawn two agents with the same `sessionId`:

```typescript
// Agent 1: Implement
await submitTask({
  label: "Implement pause/resume",
  prompt: "... (feature template) ...",
  sessionId: "feat-pause-resume",
});

// On batch complete (via continueAfterBatch):
// Agent 2: Review the implementation
// Auto-spawned with review template targeting the modified files
```

---

## Template 4: Testing and Validation

**When to use**: Writing tests for existing code, validating a feature works correctly, or running a verification pass after changes. Dash uses vitest (config at `vitest.config.ts`).

### Prompt pattern

```
You are writing tests for code in the Dash codebase at E:\Dash.

Code under test:
- {target_files}

Read the target files first, then read the test config:
- vitest.config.ts

Testing approach:
- Framework: vitest (already configured)
- Test location: test/{module_name}.test.ts (mirror src/ structure)
- Style: Arrange-Act-Assert, descriptive test names
- Coverage targets: {coverage_focus}

Write tests for:
{test_cases}

After writing tests, run them:
```bash
npx vitest run {test_file_path}
```

If tests fail, fix the test (not the source) unless the source has an obvious bug —
in which case, note it in your output but do not fix it.

Output: test file path + pass/fail summary.
```

### Inputs

| Field | Required | Example |
|-------|----------|---------|
| `target_files` | Yes | `src/agents/spawn.ts` |
| `coverage_focus` | Yes | `"error paths, timeout handling, batch completion"` |
| `test_cases` | Yes | Numbered list of specific scenarios to test |

### Outputs

- **stdout**: Test results (pass/fail per case) and any bugs discovered
- **Files**: New test file(s) in `test/`
- **Memory**: Episodic entry: `"Wrote {n} tests for {module}. {pass}/{total} passing."`

### File operations

| Operation | Files | Mode |
|-----------|-------|------|
| Read | Target source files | Read-only |
| Read | `vitest.config.ts` | Read-only |
| Read | Existing test files (for style reference) | Read-only |
| Create | `test/{module}.test.ts` | Create |
| Run | `npx vitest run {path}` | Shell |

### Success criteria

1. Test file created and syntactically valid
2. Tests run without vitest configuration errors
3. Tests cover the specified scenarios
4. Each test has a descriptive name explaining what it validates
5. No modifications to source files
6. Exit code 0

### Variant: Validation pass (no new tests)

For verifying existing code works after changes:

```
Run the existing test suite. Report:
1. Total pass/fail count
2. Any new failures (compared to {baseline} if available)
3. For each failure: file, test name, error message, likely cause

Do not modify any files.
```

---

## Template 5: Deployment and Ops

**When to use**: Operational tasks — checking system health, updating configuration, managing the agent runtime, syncing with external services, or preparing releases.

### Prompt pattern (health check variant)

```
You are performing an operational check on the Dash system at E:\Dash.

Task: {ops_task}

Check these systems:
- Agent runtime: Read brain/agents/tasks/*.json, count by status
- Queue health: Read brain/operations/queue.jsonl, check for stale items
- Memory integrity: Verify brain/memory/*.jsonl files are valid JSONL
- Build status: Run npm run build

Output format:
## System Health Report

### Agents
- Running: {n}
- Completed (last 24h): {n}
- Failed (last 24h): {n}
- Stuck (running > 30min): {list or "none"}

### Queue
- Total tasks: {n}
- In progress: {n}
- Stale (in_progress > 7 days): {list or "none"}

### Memory
- {file}: {line_count} entries, valid: {yes/no}

### Build
- Status: {pass/fail}
- Errors: {list or "none"}

### Recommendations
{actionable items, if any}
```

### Prompt pattern (release variant)

```
You are preparing a release for the Dash codebase at E:\Dash.

Read these files:
- brain/operations/changelog.md (for format reference)
- brain/operations/todos.md (for completed items since last release)
- package.json (for current version)

Tasks:
1. Determine the next version based on changes (semver)
2. Append a new entry to brain/operations/changelog.md (newest first, match existing format)
3. Update version in package.json
4. Verify build passes: npm run build

Do not:
- Create git tags (user handles git operations)
- Push anything
- Modify any file other than changelog.md and package.json
```

### Inputs

| Field | Required | Example |
|-------|----------|---------|
| `ops_task` | Yes | `"health check"`, `"prepare release"`, `"clean stale agents"` |

### Outputs (health check)

- **stdout**: Structured health report
- **Memory**: Episodic entry: `"System health check: {summary}"`
- **Files**: None modified

### Outputs (release)

- **stdout**: Version bump summary, changelog entry preview
- **Files**: `brain/operations/changelog.md` (appended), `package.json` (version bump)
- **Memory**: Episodic entry: `"Prepared release v{version}"`

### File operations

| Operation | Files | Mode |
|-----------|-------|------|
| Read | `brain/agents/tasks/*.json` | Read-only |
| Read | `brain/operations/queue.jsonl` | Read-only |
| Read | `brain/memory/*.jsonl` | Read-only |
| Run | `npm run build` | Shell |
| Modify (release only) | `changelog.md`, `package.json` | Edit |

### Success criteria (health check)

1. All sections populated with actual data (not placeholders)
2. Stuck agents identified with task IDs
3. JSONL validation catches malformed lines
4. Recommendations are actionable (not generic)

### Success criteria (release)

1. Version follows semver based on actual changes
2. Changelog entry matches existing format exactly
3. `npm run build` passes after version bump
4. No files modified beyond changelog and package.json

### Variant: Stale agent cleanup

```
Read brain/agents/tasks/*.json. Find tasks where:
- status is "running" AND createdAt is more than 30 minutes ago AND pid is not alive

For each stale task:
1. Update the task JSON: set status to "failed", error to "stale: process not found"
2. Log to stdout: task id, label, age

Do not delete any files. Only update status fields in existing task JSONs.
```

---

## Template 6: Integration Work

**When to use**: Connecting Dash to external services (Linear, Google, Twilio) or building internal integrations between Dash modules. Integrations follow the BoardProvider / sidecar pattern.

### Prompt pattern (new integration)

```
You are building an integration in the Dash codebase at E:\Dash.

Integration: {service_name}
Purpose: {what_it_does}

Study the existing integration patterns first:
- BoardProvider interface: src/board/types.ts
- Linear integration: src/linear/client.ts (for API client pattern)
- Queue sync: src/queue/sync.ts (for bidirectional sync pattern)
- Sync timer: src/queue/timer.ts (for background timer pattern)
- Sidecar pattern: src/tts/sidecar.ts or src/stt/sidecar.ts (for subprocess management)

Follow these patterns:
1. Types in {module}/types.ts
2. Client/provider in {module}/client.ts
3. Server routes in src/server.ts (group under /api/{module}/*)
4. Timer if background sync needed (module-level singleton, idempotent start/stop)
5. API keys from vault (never hardcoded, read via getVaultKey())

Implementation:
{numbered_steps}

Auth pattern:
- Store API key in vault as {VAULT_KEY_NAME}
- Read via getVaultKey("{VAULT_KEY_NAME}") at request time
- If key missing, return 401 with clear error message
- Never log or expose key values

After implementation, verify:
1. npm run build passes
2. Routes are registered in src/server.ts
3. Types are exported from module index.ts
```

### Prompt pattern (sync integration)

```
You are adding bidirectional sync between Dash and {service_name}.

Study the Linear sync implementation:
- src/queue/sync.ts (push/pull logic, conflict resolution)
- src/queue/timer.ts (background timer with exponential backoff)

Sync rules:
- Local-authoritative: Dash state wins on conflict
- Last-write-wins by timestamp for field-level merges
- Sync metadata fields: {service}Id, {service}SyncedAt, syncOrigin
- Timer interval: {interval} (with backoff on failure, max 30min)
- Auth pause: if key invalid, stop timer until key changes

Implement:
1. {service}/sync.ts — push() and pull() functions
2. {service}/timer.ts — background sync timer (follow src/queue/timer.ts pattern exactly)
3. Add sync routes to src/server.ts: POST /api/{service}/sync, GET /api/{service}/sync/health

State mapping:
{local_state → remote_state table}
```

### Inputs

| Field | Required | Example |
|-------|----------|---------|
| `service_name` | Yes | `"Slack"`, `"Notion"`, `"GitHub"` |
| `what_it_does` | Yes | `"Sync Dash board tasks with GitHub Issues"` |
| `numbered_steps` | Yes | Specific implementation steps |
| `VAULT_KEY_NAME` | Yes | `"GITHUB_TOKEN"` |

### Outputs

- **stdout**: Integration summary, routes added, how to configure
- **Files**: New module directory with types, client, optional timer
- **Memory**: Episodic entry: `"Built {service} integration. Routes: {list}. Vault key: {key_name}"`

### File operations

| Operation | Files | Mode |
|-----------|-------|------|
| Read | Existing integration code (for pattern reference) | Read-only |
| Create | `src/{service}/types.ts`, `client.ts`, `index.ts` | Create |
| Create (if sync) | `src/{service}/sync.ts`, `timer.ts` | Create |
| Modify | `src/server.ts` (add routes) | Edit |
| Run | `npm run build` | Shell |

### Success criteria

1. Follows existing patterns (BoardProvider, timer singleton, vault auth)
2. No hardcoded API keys or credentials
3. Graceful degradation when service unavailable (feature disabled, not crash)
4. `npm run build` passes
5. Routes documented in stdout summary
6. Sync metadata fields present if bidirectional

---

## Spawning guidelines

### Prompt quality checklist

Before spawning, verify the prompt:

- [ ] Contains at least one file path (`src/`, `brain/`, `.ts`, `.md`)
- [ ] States a specific task (not "improve" or "make comprehensive")
- [ ] Specifies output format or destination
- [ ] Lists files to read before acting
- [ ] Includes constraints (what NOT to do)

### Batch composition

When a task needs multiple templates, use `sessionId` to group them. The `continueAfterBatch()` system will review results and optionally spawn follow-up agents.

Common batch sequences:

| Sequence | Templates | Session pattern |
|----------|-----------|-----------------|
| Build + verify | Feature → Testing | Same sessionId, continuation spawns test agent |
| Fix + validate | Bug fix → Testing → Health check | Same sessionId, 3-round continuation |
| Ship | Feature → Testing → Release prep | Same sessionId, max rounds |
| Audit | Review → Review → Review | Parallel (same sessionId, different files) |

### Timeout guidance

| Template | Recommended timeout | Rationale |
|----------|-------------------|-----------|
| Code review | 5 min | Read-only, bounded scope |
| Bug investigation | 10 min (default) | May need to trace call chains |
| Feature implementation | 10–15 min | Depends on scope |
| Testing | 10 min | Includes test execution |
| Health check | 3 min | Mostly file reads |
| Release prep | 5 min | Bounded file changes |
| Integration | 15 min | Multiple files, build verification |

### Memory recording

Every agent records an episodic memory entry via `rememberTaskOutcome()` on completion. Templates can request additional memory writes:

```
After completing the task, also record a semantic memory entry:
brain.learn({ type: "semantic", content: "{fact}", meta: { source: "agent", taskId: "{id}" } })
```

Use this for facts discovered during investigation (e.g., "The Linear API rate limit is 1500 req/hr") or procedural knowledge (e.g., "To reset the sync timer, call stopSyncTimer() then startSyncTimer()").

---

## Failure handling

Agents that exit non-zero are marked `"failed"`. The spawn system tracks recent failures:

- 2+ failures in 5 minutes → phone call alert (with 15-min cooldown)
- Failed agents with `sessionId` block batch continuation for that session
- Runtime-managed agents (via `AgentInstanceManager`) get up to 2 retries with exponential backoff

### Common failure modes and mitigations

| Failure | Cause | Template mitigation |
|---------|-------|---------------------|
| Timeout | Scope too large | Break into smaller agents, reduce file count |
| Build failure | Bad code generation | Include "verify build" step in prompt |
| Empty output | Prompt too vague | Add file paths, specific instructions |
| Wrong files modified | Missing constraints | Add explicit "do not touch" list |
| Infinite continuation | Vague follow-up prompts | Caught by MAX_ROUNDS=5 and vague-prompt filter |
