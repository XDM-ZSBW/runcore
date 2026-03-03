# Dash → Core Divergence Scan

> Generated 2026-03-03 from automated comparison of E:\Dash vs E:\Core.
> Purpose: identify what needs to be cherry-picked (v1) vs deferred to v2 (VBL).

## Summary

| Category | Count |
|----------|-------|
| Shared src/ files with code changes | 101 of 239 |
| Dash-only src/ files (new) | 14 |
| Core-only src/ files | 1 (`instance.ts`) |
| Dash-only public/ files | 1 meaningful (`registry.html`) + avatar cache |
| Brain schema mismatches | 4 minor |

---

## v1 Backport — Cherry-pick to Core Now

These are stable bug fixes and features that work regardless of brain schema.
Sorted by divergence size (changed lines).

### Critical (100+ lines diverged)

| File | Lines | What changed |
|------|-------|-------------|
| `server.ts` | 1298 | Route extraction (Slack/WhatsApp/Google sub-routers), registry UI, board scroll fix, new API endpoints |
| `agents/autonomous.ts` | 362 | DASH-150 planner skip cache persistence, DASH-161 spawn rate limiter, quality gate skip count + auto-demotion |
| `agents/continue.ts` | 87 | Continuation improvements |

### Medium (20-99 lines)

| File | Lines | What changed |
|------|-------|-------------|
| `capabilities/definitions/docs.ts` | 63 | Docs capability |
| `google/gmail-timer.ts` | 51 | Gmail timer fixes |
| `capabilities/definitions/browser.ts` | 50 | Browser capability |
| `capabilities/definitions/board.ts` | 50 | Board capability |
| `pulse/activation-event.ts` | 47 | CDT activation |
| `capabilities/definitions/email.ts` | 47 | Email capability |
| `capabilities/registry.ts` | 46 | Registry changes |
| `capabilities/definitions/calendar.ts` | 46 | Calendar capability |
| `openloop/scanner.ts` | 42 | OLP scanner fixes |
| `config/defaults.ts` | 42 | New defaults |
| `settings.ts` | 39 | Settings changes |
| `services/traceInsights.ts` | 36 | Quality gate, meetsQualityBar(), triage routing |
| `agents/runtime/config.ts` | 33 | Runtime config |
| `capabilities/definitions/email-context.ts` | 24 | Email context |
| `slack/webhooks.ts` | 23 | Slack webhook fixes |

### Small (2-20 lines)

51 files with minor changes — mostly import fixes, small bug fixes, capability
registration, type adjustments. Full list in scan data.

### New files to add to Core

| File | Category | v1? |
|------|----------|-----|
| `capabilities/definitions/agent-request.ts` | Agent spawning capability | Yes |
| `capabilities/definitions/board-view.ts` | Board view capability | Yes |
| `capabilities/validate.ts` | Capability validation | Yes |
| `channels/whatsapp-routes.ts` | Route extraction | Yes |
| `google/routes.ts` | Route extraction | Yes |
| `slack/routes.ts` | Route extraction | Yes |
| `integrations/definitions.ts` | Integration registry | Yes |
| `integrations/registry.ts` | Integration registry | Yes |
| `providers/google/docs.ts` | Google provider | Yes |
| `providers/google/email.ts` | Google provider | Yes |
| `providers/google/index.ts` | Google provider | Yes |
| `providers/index.ts` | Provider framework | Yes |
| `providers/registry.ts` | Provider framework | Yes |
| `providers/types.ts` | Provider framework | Yes |
| `public/registry.html` | Registry UI page | Yes |

---

## v2 Deferred — Needs VBL / Architecture Rework

These changes work today because they're hardcoded to Dash's brain schema.
In v2, they need to go through the Virtual Brain Layer (U-006).

### Hardcoded path patterns to abstract

Every file below contains `join(...)` or string literals pointing to specific
brain paths. v2 must route these through the brain manifest.

| Pattern | Files affected | v2 abstraction |
|---------|---------------|----------------|
| `brain/memory/*.jsonl` | `memory/file-backed.ts` | VBL Recall/Learn adapter |
| `brain/operations/queue.jsonl` | `queue/store.ts` | VBL Tasks adapter |
| `brain/ops/activity.jsonl` | `activity/log.ts` | VBL Activity adapter |
| `brain/operations/insights.jsonl` | `services/traceInsights.ts` | VBL internal, or remove from manifest |
| `brain/operations/notifications.jsonl` | `goals/notifications.ts` | VBL Notifications adapter |
| `brain/calendar/events.jsonl` | `calendar/store.ts` | VBL Schedule adapter |
| `brain/identity/*` | `settings.ts`, context assembler | VBL Identity adapter |
| `brain/agents/*` | `agents/store.ts`, cooldown, locks | VBL internal (runtime state) |
| `brain/metrics/*` | `metrics/store.ts` | VBL internal (telemetry) |
| `brain/settings.json` | `settings.ts` | Brain manifest replaces this |

### Brain structure differences (template divergence)

| Module | Dash | Core | v2 action |
|--------|------|------|-----------|
| `vault/` | Has encrypted credential store | Missing | Core needs vault as optional module in manifest |
| `sessions/` | Has session state files | Missing | Core needs session store in manifest |
| `knowledge/notes/` | 14 research notes | Empty | Template spawns empty, instance populates |
| `knowledge/protocols/` | 5 protocols | Missing | Template should scaffold empty dir |
| `knowledge/research/` | 5 research docs | Missing | Template should scaffold empty dir |
| `identity/human.json` | Has user profile | Missing | Manifest declares optional identity files |
| `brain/skills/*.yml` | Missing | Has 6 YMLs | Core has skills Dash doesn't — reverse flow violation |

### JSONL schema gaps

| File | Issue | v2 action |
|------|-------|-----------|
| `memory/resonances.jsonl` | Core has no schema header | Add `_schema` header to template |
| `memory/embeddings.jsonl` | Core has no proper schema line | Add `_schema` header to template |
| `ops/shares.jsonl` | Neither has schema header | Add `_schema` header to both |
| `memory/wins.jsonl` | Description personalized in Dash | Template uses generic description |

---

## Anomalies

1. **Core has `brain/skills/*.yml` that Dash doesn't have.** This violates the
   umbilical model (Dash leads, Core follows). These were likely added directly
   to Core. Need to decide: pull into Dash, or accept Core can have additive
   template content that Dash doesn't need.

2. **Core has `src/instance.ts` that Dash doesn't.** May be dead code or a
   bootstrap concept that Dash diverged from. Investigate before v2.

3. **49 avatar cache mp4s in Dash's public/.** These are instance-specific
   generated content, should be gitignored, never go to Core.

---

## Recommended Execution Order

### Phase 1: v1 sync (do now)
1. Cherry-pick the 14 new src/ files to Core
2. Cherry-pick server.ts route extraction (Slack/WhatsApp/Google sub-routers)
3. Cherry-pick agents/autonomous.ts (DASH-150, DASH-161, quality gate)
4. Cherry-pick services/traceInsights.ts (quality gate)
5. Cherry-pick services/routine-patterns.ts (false positive filter)
6. Add registry.html to Core public/
7. Bulk cherry-pick the 51 small-change files

### Phase 2: v2 groundwork (parallel track)
1. Introduce `brain.manifest.yaml` to both repos
2. Start reading paths from manifest instead of hardcoding (incremental)
3. Add missing `_schema` headers to Core template JSONL files
4. Scaffold empty dirs in Core template (knowledge/notes, protocols, research)
5. Design adapter interfaces for each VBL primitive

### Phase 3: v2 migration (when ready)
1. Abstract all hardcoded brain paths behind VBL adapters
2. Implement Core brain adapter (reads manifest, uses JSONL)
3. Template versioning + migration framework
4. First non-Core adapter (Obsidian? markdown wiki?)
