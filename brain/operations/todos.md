# Todos

## P0 — Do today

- [x] Wire voucher_check into Dash — already implemented. `createVoucherCapability` registered at Dash `server.ts:4698`.
- [x] Fix Dash greeting — rewritten to be honest: data local, inference cloud, switchable in Settings.
- [x] Fix Dash model label — fixed in 88f9332.

## P1 — This week

- [x] Harden `airplaneMode` into real `privateMode` — fetch guard blocks cloud LLM hosts, integration gate, PrivateModeError. Done in 88f9332, defense-in-depth in 20a2126.
- [x] Audit git history for PII — completed in f500e1f. Report: `git-audit-report.md`.
- [x] Make `.locked` enforcement consistent — centralized in 88f9332.
- [x] Minimal HTTP server — Hono server with mDNS announcement. Done in d3932d2.
- [x] Claude Code as orchestrated agent — governance, governed-spawn, heartbeat implemented in a240d1f.
- [x] Add access audit logging — audit infrastructure was already in place (brain-io.ts + audit.ts + HTTP middleware + MCP wrappers). Fixed one bypass: roadmap endpoint using raw readFile instead of readBrainFile.

## P2 — This month

- [ ] Sensitive field redaction — before any API call, strip fields tagged as sensitive from context. Even in non-private mode, some things should never leave the machine.
- [ ] Voucher revocation via alert — when a voucher check fails, optionally notify human via Twilio/Resend/Gmail. "Someone just tried token X, it was invalid."
- [ ] Core-brain as proper shared dependency — Dash currently copies memory code. Should import from core-brain as a local npm dependency so vouchers, encryption, and lock enforcement stay in sync.
- [ ] Multi-instance brain management — `E:\cores\*` pattern (Wendy, future Cora, others). Need tooling to spawn, configure, and manage multiple brain instances from one place.
- [ ] Hub-spoke mesh networking — spokes proxy LLM/brain through hub, data never leaves the hub. Tabled until core is stable. Design notes exist from 2026-03-05 session.

## P3 — Backlog

- [ ] Local model fallback chain — if private mode is on and Ollama is down, queue requests instead of failing. Resume when available.
- [ ] Voucher scoping enforcement — currently scope is informational. Make it actually restrict what the voucher holder can do (e.g. `read:settings` only allows `get_settings`).
- [ ] Cross-brain audit dashboard — Dash UI view showing all voucher activity, access attempts, and security events across all instances.
- [ ] Pre-release security checklist — automated scan before any public release: no PII in git, no hardcoded keys, all brain files encrypted, `.locked` covering sensitive paths.
- [ ] Clean git history for v2 — fresh initial commit or filter-branch to strip all development history before public release.
