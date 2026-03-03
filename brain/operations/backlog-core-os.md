# Core O/S Backlog — Excellence Roadmap

> Generated 2026-02-28 from telemetry analysis + architecture audit.
> Organized by the manifesto's own standard: stability over demo magic, agency with a heartbeat, cognitive sovereignty.
>
> **Status: ALL 17 ITEMS IMPLEMENTED** (2026-02-28). See commits 5f6e328..051104b.

---

## T0 — The Feedback Loop (root cause of most operational pain)

The system is grinding under load from its own feedback loops. Linear sync is slow → agent tasks delayed → retries → more sync → more delays → insight engine escalates → more tasks → more sync. Breaking this loop is prerequisite to everything else.

### B-001: Linear sync circuit breaker
**Problem:** Linear sync init takes 4-9s. Push failures ("No Linear state matches type 'cancelled'") cause infinite retry loops. Handoff errors recur: "1-2 local task(s) still unsynced — will retry next cycle."
**Fix:** Add circuit breaker that stops retrying after N consecutive failures. Add state mapping for 'cancelled'. Cap sync init at 3s with graceful degradation (work offline, sync later).
**Evidence:** DASH-141, DASH-123/124/125/126 (duplicates), DASH-144. Queue shows 4 copies of DASH-129.
**Impact:** Eliminates the cascading failure chain. Everything downstream gets faster.

### B-002: Agent exit code null — capture what's actually happening
**Problem:** Agents fail with `exit code null` (likely timeout, not crash). No stderr captured. Recovery agent spawned but outcome not recorded. Silent death → retry storm → budget exhaustion.
**Fix:** Capture stdout+stderr on all exits. Distinguish timeout vs crash vs clean exit. Log the actual failure reason before spawning recovery.
**Evidence:** DASH-131, DASH-136, DASH-140. Activity log shows "terminal, no retries left" with no root cause.
**Impact:** Turns invisible failures into diagnosable events. Prerequisite for fixing retry logic.

### B-003: Insight engine dedup — stop escalating the same bottleneck
**Problem:** Insight engine discovers same pattern repeatedly, creates duplicate Linear tasks. DASH-125/126 are duplicates of DASH-123, all manually consolidated. Same insights discovered at 18:51, 19:01, 19:12, 20:00, 21:16, 22:09.
**Fix:** Before creating a new task, check if an open task with matching keywords/pattern already exists. Add cooldown per insight pattern (e.g., 6h before re-escalating same issue).
**Impact:** Stops the board from diverging. Reduces sync load. Prevents cognitive clutter in the backlog itself.

---

## T1 — Silent Failures (you can't fix what you can't see)

### B-004: Log integration skip events
**Problem:** Calendar unavailable → skipped silently. Gmail unavailable → skipped silently. Open loop load failed → skipped silently. Changelog missing → skipped silently. No warnings, no metrics, no activity logs.
**Fix:** Add `log.warn()` + activity log entry for every skipped integration. Aggregate into a "health summary" visible in observatory.
**Evidence:** server.ts lines 3727, 3772, 3793, 3849 — all silent catch blocks.
**Impact:** User knows when integrations are degraded. The agent knows when to stop relying on missing context.

### B-005: Batch operation failure reporting
**Problem:** Batch pause/terminate swallow errors per-instance. Caller gets a count, not a list of failures. Encryption decryption fallback silently returns plaintext on failure.
**Fix:** Return `{ succeeded: string[], failed: Array<{id, error}> }` from batch ops. Log encryption failures with line context.
**Evidence:** instance-manager.ts lines 323, 347. brain-io.ts line 67.
**Impact:** Makes batch failures diagnosable. Prevents silent data exposure from encryption failures.

---

## T2 — Memory & Performance (the 5-day problem)

### B-006: Bounded in-memory collections
**Problem:** Activity log loads entire 24h history into memory on first access, then appends unboundedly. Queue store loads entire Map. Embeddings file is 12MB/699 lines. Metrics file is 4.1MB/14,779 lines.
**Fix:** Add max-size caps to in-memory arrays (activity: 500 entries, queue: cursor-based pagination). Add incremental compaction to metrics (rotate at 1.2x instead of 1.5x). Prune embeddings on startup.
**Evidence:** Activity log grows hundreds of MB for long-running instances. Embeddings file 12MB with no pruning.
**Impact:** The agent stays fast on day 5. Memory footprint stays predictable.

### B-007: Vector index availability caching + circuit breaker
**Problem:** Every call to `vectorIndex.isAvailable()` makes a network request. No backoff if Ollama is down. Called per matching operation in scanner, per lifecycle run.
**Fix:** Cache availability for 30s. Implement circuit breaker: after 3 consecutive failures, disable vector path for 5 min. Emit activity log on state transitions.
**Evidence:** scanner.ts and lifecycle.ts both call isAvailable() without caching.
**Impact:** Eliminates repeated timeout waits when Ollama is down. Scan cycles complete faster.

### B-008: Context assembler token budget enforcement
**Problem:** `assembleSections()` accepts `maxSupportingTokens` but never truncates. Token estimation is `chars / 4`. Supporting content can grow unboundedly.
**Fix:** Enforce truncation when supporting content exceeds budget. Log when truncation happens. Consider better token estimation.
**Evidence:** assembler.ts — maxSupportingTokens parameter accepted but unused.
**Impact:** Prevents LLM context overflows. Keeps context quality high as memory grows.

---

## T3 — Agent Reliability (agency with a heartbeat)

### B-009: Recovery agent timeout cap
**Problem:** Recovery agents inherit the original task's timeout (could be 2h). Recovery is usually simpler but gets the same generous window. If recovery itself times out, resources are wasted for hours.
**Fix:** Cap recovery agent timeout at 15 min regardless of original task timeout. Log recovery timeout separately.
**Evidence:** recover.ts spawns with same timeoutMs as original task.
**Impact:** Prevents stuck recovery agents from consuming resources indefinitely.

### B-010: GC scheduling jitter + backlog protection
**Problem:** Instance GC runs at fixed 1-minute intervals. All GC work hits at :00 seconds (thundering herd). Batch cap of 100 means eligible instances can pile up faster than GC drains them.
**Fix:** Add random jitter (0-10s) to GC interval. Add hard limit on pending terminal instances — force synchronous collection when exceeded. Log GC backlog depth.
**Evidence:** DASH-130, DASH-134, DASH-139. GC times range from 50ms to over 1 minute.
**Impact:** Smoother resource reclamation. No more GC-induced latency spikes.

### B-011: Retry logic audit — exponential backoff across global budget
**Problem:** Agents retry on timeout (exit code null). Global retry budget is 10-15 attempts across all agents. No exponential backoff between retries.
**Fix:** Add exponential backoff (1s, 2s, 4s, 8s...) between retries. Don't retry on timeout — mark as needs-investigation instead. Separate retry budget per task category.
**Evidence:** DASH-136 (Agent Retry Issue). Activity log shows immediate retry after failure.
**Impact:** Stops retry storms. Preserves budget for genuine transient failures.

---

## T4 — Open Loop Protocol Quality (holding tension properly)

### B-012: Resonance deduplication
**Problem:** Same loop can resonate with same activity entry multiple times if scanner runs again. No dedup before appending to resonances.jsonl. No check for existing (loopId, activityId) pairs.
**Fix:** Before pushing confirmed resonances, check if (loopId, matchedActivityId) already exists in the in-memory array. Skip duplicates.
**Evidence:** Resolution scanner reporting same loop resolved 4+ times (2026-02-28 21:20-21:34).
**Impact:** Clean resonance data. Observatory shows accurate match counts.

### B-013: O(n²) merge detection → bounded comparison
**Problem:** `findMergeCandidates()` compares every active loop with every other (nested loop). Embedding called for every pair. 100 active loops = 4,950 comparisons.
**Fix:** Cache embeddings during lifecycle run. Cap comparisons at 50 active loops (sample if more). Skip if embedding fails for either loop. Add idempotency check to prevent duplicate merges.
**Evidence:** lifecycle.ts lines 196-235.
**Impact:** Lifecycle runs stay fast as loop count grows. No duplicate merged loops.

### B-014: Open loop observability metrics
**Problem:** No metrics on loop quality: average lifetime, merge rate, resolution rate, vector vs keyword similarity distribution. Only qualitative activity logs.
**Fix:** Record metrics via MetricsStore: `olp.lifetime`, `olp.merge_rate`, `olp.resolution_rate`, `olp.scan_duration`. Surface in observatory.
**Impact:** Can diagnose OLP health quantitatively. Know if loops are actually resolving or just accumulating.

---

## T5 — Configuration & Durability (cognitive sovereignty)

### B-015: Centralize configuration defaults
**Problem:** Constants hardcoded across scanner.ts (scan interval, similarity threshold), lifecycle.ts (stale days), instance-manager.ts (GC batch size, health thresholds), metrics/store.ts (max points, max age). No single source of truth.
**Fix:** Create `src/config/defaults.ts` exporting all defaults. Each module imports from there. Add startup logging of effective config values.
**Impact:** Tunable system. One place to audit and adjust behavior.

### B-016: JSONL schema migration framework
**Problem:** Schema headers include `_version` but no migration logic. If schema changes, old files are read as-is without validation. No way to run migrations.
**Fix:** Add version check on load. Implement migration registry: `{ "1.0" → "1.1": (entry) => transformedEntry }`. Run migrations lazily on first read.
**Impact:** Safe schema evolution. No silent data corruption on upgrades.

### B-017: Health score time decay
**Problem:** Health score uses fixed point deductions (each retry: -15, each restart: -10). No decay — a retry from 6 hours ago counts the same as one from 30 seconds ago. Fresh instance with 3 retries scores 55 ("healthy") even though it's flaky.
**Fix:** Add exponential time decay to historical failures. Separate "flaky" (intermittent failures) from "failing" (consecutive failures). Make weights configurable.
**Evidence:** instance-manager.ts lines 440-487.
**Impact:** Accurate health assessment. Appropriate recovery decisions.

---

---

## v2.0 — Distribution & Update Channel

> Brainstormed 2026-03-02. Not yet specced. These are the problems to solve
> for Core to be a real multi-instance platform, not just a template you fork and forget.

### The core tension

Code evolves. Brain schema follows code. Brain data is personal. When an upstream code change
alters the shape of settings.json, JSONL schemas, or adds new brain modules, every running
instance needs to (a) learn about it, (b) migrate its brain data safely, (c) never lose
personal memories/identity in the process.

### U-001: Update subscription channel
**Problem:** Instances are standalone forks. No mechanism to learn about upstream code changes,
security patches, or new capabilities.
**Ideas:**
- On boot, Core pings a version endpoint (or checks a git remote), compares semver
- Notification: "v0.2.0 available — 3 security fixes, 2 new capabilities"
- Pull is always manual (local-first principle) — no auto-update
- Security patches could get a stronger signal (banner in UI, push notification)
- Channel is one-way: upstream → instance. No phoning home, no telemetry.

### U-002: Brain migration system
**Problem:** Code updates may change brain file schemas. Old instances have old-shape data.
Need to transform brain data without losing personal content.
**Ideas:**
- `brain/settings.json` gets a `schemaVersion: number` field
- Each release ships migration functions: `v1→v2`, `v2→v3`, etc.
- On boot: check version, run pending migrations sequentially, backup brain/ first
- Migrations only touch structure (add fields, rename columns, create new modules) — never
  modify personal content (memories, experiences, identity)
- Additive changes (new optional field, new module dir) use self-healing defaults — code
  falls back gracefully, no migration needed
- Structural changes (renames, type changes, removed fields) require explicit migration
- Boot sequence: `initInstanceName()` → `runPendingMigrations()` → `loadVault()` → `start()`
- Extends B-016 (JSONL schema migration framework)

### U-003: Umbilical — Dash → Core → all instances
**Problem:** When an instance tunes code or adds a feature, there's no way to push that
improvement back to Core for other instances to benefit.
**The umbilical model (decided):**
- **Dash is the live testbed.** Bryant runs bleeding-edge changes in production daily.
  Every UI tweak, bug fix, and new feature gets battle-tested on Dash first.
- **Core only gets what survives.** When a change is stable in Dash, it gets
  cherry-picked back to Core. Core never leads — Dash always leads.
- **Other instances pull from Core at their own pace.** They get pre-tested, stable
  changes. Never raw experiments.
- Flow: `Dash (live) → test → stabilize → cherry-pick to Core → instances pull`
- This is NOT a traditional open-source contribution model. It's a single-source
  canary deployment where Dash is the canary.
**Mechanics:**
- Git cherry-pick or manual apply from Dash → Core (brain/ is gitignored, so only
  code/UI changes flow)
- Could automate: tag commits in Dash with `[core]` prefix → script extracts and
  applies to Core repo
- Registry-based sharing (brain/registry.md) is separate: skills, templates, and
  capabilities as packages. That's instance-to-instance, not code-level.
- Community contributions (if Core goes public) would PR into Core, get tested on
  Dash, then merge. Reverse flow for external contributors.

### U-004: Security update fast-path
**Problem:** Security patches must reach all instances quickly. Can't wait for users to
manually check.
**Ideas:**
- Severity levels: critical (UI banner + push notification), standard (boot-time notice)
- Signed update manifests so instances can verify authenticity
- Critical patches: always ship, even in airplane mode queue them for next online boot
- Security updates that touch code only (no schema change) skip migrations entirely

### U-005: Distribution model — lead climber
**Mental model:** Bryant is the lead climber. Dash is on the rock face, figuring out the
route, placing protection (stable releases) as it goes. Instances below clip in to those
anchors and follow a proven path. They don't solve the route themselves.

**Topology today:**
- Single origin of changes: Bryant's use cases, issues, ideas
- No other instances yet — pyramid has one node at the top
- Future: interconnected nodes, but always one lead climber per Core version

**Business model (undecided, thinking out loud):**
- **Free for now.** Building a following, proving the platform, growing the community.
  Open source Core repo, anyone can clone and run.
- **Paid option later?** Could be:
  - Free tier: open source Core, self-hosted, pull updates manually
  - Paid tier: managed updates, priority security patches, migration support,
    premium skills/capabilities, support channel
  - Or: Core is always free, paid services layer on top (hosting, marketplace, SLA)
- **Decision needed soon** but not blocking v1 launch. Ship free, learn what people
  value, then decide what's worth charging for.
- Key principle: the brain is always yours. Local-first. No lock-in. Paid services
  add convenience, not captivity.

### Open questions
- Should instances track which upstream version they forked from? (git tag vs settings field)
- How much divergence is acceptable before "update" becomes "merge conflict hell"?
- Should brain migrations be reversible (down-migrations)?
- Registry packages vs code updates — are these the same channel or separate?
- Free vs paid: what's the line? Updates? Skills marketplace? Hosting? Support?
- When to decide: after N users? After first paying customer asks? After v1 stability?

---

## Priority Map

| Tier | Items | Theme | Manifesto Alignment |
|------|-------|-------|---------------------|
| **T0** | B-001, B-002, B-003 | Break the feedback loop | "Stability over Demo Magic" — the system is busy, not better |
| **T1** | B-004, B-005 | Make failures visible | "Agency with a Heartbeat" — can't govern what you can't see |
| **T2** | B-006, B-007, B-008 | 5-day durability | "Optimize for the 5-day problem" — memory must stay bounded |
| **T3** | B-009, B-010, B-011 | Agent reliability | "Autonomy needs governance" — retries need discipline |
| **T4** | B-012, B-013, B-014 | OLP quality | "Hold tension" — resonances must be accurate and measurable |
| **T5** | B-015, B-016, B-017 | Foundation | "Cognitive Sovereignty" — the system must be auditable and evolvable |
