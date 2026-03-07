# Todos

## P0 — Do today

- [x] Wire voucher_check into Dash — already implemented. `createVoucherCapability` registered at Dash `server.ts:4698`.
- [x] Fix Dash greeting — rewritten to be honest: data local, inference cloud, switchable in Settings.
- [x] Fix Dash model label — fixed in 88f9332.

## P1 — This week

- [ ] Nerve endpoints — the brain responds to whichever nerve is talking. Phone, PC, earbuds, tablet — customers swap/mirror/sync as they want. MVP: Android on home WiFi → PC relay. Priority: push notifications, voice chat (bluetooth earbuds), morning briefing (compiled overnight, ready before owner wakes), text chat. The nerve is not the brain. The brain stays put. Nerves plug in and out.

- [x] Harden `airplaneMode` into real `privateMode` — fetch guard blocks cloud LLM hosts, integration gate, PrivateModeError. Done in 88f9332, defense-in-depth in 20a2126.
- [x] Audit git history for PII — completed in f500e1f. Report: `git-audit-report.md`.
- [x] Make `.locked` enforcement consistent — centralized in 88f9332.
- [x] Minimal HTTP server — Hono server with mDNS announcement. Done in d3932d2.
- [x] Claude Code as orchestrated agent — governance, governed-spawn, heartbeat implemented in a240d1f.
- [x] Add access audit logging — audit infrastructure was already in place (brain-io.ts + audit.ts + HTTP middleware + MCP wrappers). Fixed one bypass: roadmap endpoint using raw readFile instead of readBrainFile.
- [x] PrivacyMembrane — reversible typed-placeholder redaction. `src/llm/membrane.ts`, `src/llm/sensitive-registry.ts`, `brain/knowledge/sensitive.yaml`. Integrated into redact.ts, complete.ts, server.ts with streaming token buffer. 2026-03-05.
- [x] Approve agent sync protocol — Approved 2026-03-05. [Spec](../knowledge/notes/agent-sync-protocol.md). Tell Dash.
- [ ] Voice pass on existing content drafts — Read the new voice rules, then re-read each draft looking for violations. [Tone of voice](../identity/tone-of-voice.md)
- [ ] Voice pass on herrmangroup.com website copy — Open the site and read it through the lens of the warmth rules. [herrmangroup.com](https://herrmangroup.com)

## P2 — This month

- [x] Sensitive field redaction — upgraded to PrivacyMembrane (2026-03-05). See P1.
- [x] Voucher failure alerts — `checkVoucherWithAlert()` in voucher.ts fires alerts on invalid/expired tokens. Decoupled via `setVoucherAlertFn()` callback, wired to `sendAlert()` (email + SMS) in mcp-server.ts.
- [ ] Core-brain as proper shared dependency — Compare what Dash copies vs what Core exports. `src/memory/file-backed.ts`
- [ ] Instance access partitioning — Implement `.access/*.yaml` manifest enforcement in context assembler. [Access Manifest Spec](../knowledge/notes/access-manifest-spec.md)
- [ ] Wendy instance setup — Spawn back-office instance from Core. Create access manifest, identity, brain partition. [Architecture Glossary](../knowledge/notes/architecture-glossary.md)
- [ ] Cora instance setup — Spawn front-office instance from Core. Create access manifest, identity, brain partition. [Architecture Glossary](../knowledge/notes/architecture-glossary.md)
- [ ] Node mesh networking — Read the mesh config that's locked to defaults. `src/settings.ts` lines 171-172. [Architecture Glossary](../knowledge/notes/architecture-glossary.md)
- [ ] Three-repo split — Separate core-membrane from core engine. [Three-repo architecture](../knowledge/notes/three-repo-membrane-architecture.md)
- [ ] Brain access partitioning (U-007) — Implement role-based access manifests per the spec. [Access Manifest Spec](../knowledge/notes/access-manifest-spec.md)
- [ ] Guest authentication — Read the research, then look at existing voucher system it reuses. [Guest auth research](../knowledge/research/guest-auth-methods.md)
- [ ] Publish LinkedIn posts — Open POST-3 and POST-4, confirm voice, then post. [Use AI Different](../../content/drafts/use-ai-different.md)
- [ ] Publish long-form content — Voice pass first. Start with the construction piece (closer to right tone already). [Remodel/Gut Rehab/New Construction](../../content/drafts/ai-transformation-types.md)

- [ ] Delegation / surrogate model — Define scoped, time-limited, revocable delegation tokens for emergency contact / surrogate access. "On behalf of" voucher semantics. No one gets root. [Instances](../identity/instances.yaml)
- [ ] Break-in policy / abandoned vault — What happens when the keyholder disappears? Retention, stale property, lockbox access, legal/ethical/architectural implications. Where delegation, surrogate, and Marvin (loss prevention) converge. Sets tone for the whole governance model.

## P3 — Backlog

- [ ] Local model fallback chain — Read how the current Ollama fallback works. `src/llm/complete.ts`
- [ ] Voucher scoping enforcement — Read current voucher implementation to see where scope is checked. `src/voucher.ts`
- [ ] Cross-brain audit dashboard — Read Dash's existing audit log to understand what data is available. `E:/dash/brain/ops/audit.jsonl`
- [ ] Pre-release security checklist — Re-read the git audit report from the last scan. [Git audit report](../../git-audit-report.md)
- [ ] Clean git history for v2 — Check current repo size and commit count to scope the work.
- [ ] Monetization model decision — Read the research, pick a phase 1 pricing structure. [Monetization research](../knowledge/research/monetization-models.md)
- [ ] Dash UI tone audit — Open Dash in the browser and click through every screen with the voice doc open. [Tone of voice](../identity/tone-of-voice.md)
- [ ] Anti-patterns file — Read the banned words/tones section of tone-of-voice.md, then expand into full examples. [Tone of voice](../identity/tone-of-voice.md)
