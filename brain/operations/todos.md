# Todos

## P0 — Do today

- [ ] Wire voucher_check into Dash as a capability (`src/capabilities/definitions/voucher.ts`), register in `server.ts`. Import `checkVoucher`/`issueVoucher` directly from core-brain or copy the functions. Dash already has its own `FileSystemLongTermMemory` instance.
- [ ] Fix Dash greeting — "running locally" is misleading. LLM inference hits OpenRouter/Anthropic. Rewrite to be accurate about what's local (data) vs cloud (inference).
- [ ] Fix Dash model label — model name tag (e.g. "claude-sonnet-4") missing next to agent name in UI. Was showing before, now gone. UI regression.

## P1 — This week

- [ ] Harden `airplaneMode` into real `privateMode` — currently just swaps provider to Ollama. Needs to actually block all outbound LLM API calls at the request layer, not just change the provider name. Fail loud if Ollama isn't available.
- [ ] Audit git history for PII — run `git log -p` scan on both `core` and `dash-brain` repos for personal data, credentials, env vars that may have been committed. Squash or filter-branch before anything goes public.
- [ ] Add access audit logging — when any brain file is read via MCP or direct access, log it (who, what, when). Currently no trail of who accessed what.
- [ ] Make `.locked` enforcement consistent — MCP server respects it, but Dash reads files directly and bypasses the lock check entirely. Centralize the guard.

## P2 — This month

- [ ] Orchestration layer — single security policy enforced across all brains (Dash, Claude Code, Wendy, future instances). One config, applied everywhere. Not per-brain opt-in.
- [ ] Voucher revocation via alert — when a voucher check fails, optionally notify human via Twilio/Resend/Gmail. "Someone just tried token X, it was invalid."
- [ ] Sensitive field redaction — before any API call, strip fields tagged as sensitive from context. Even in non-private mode, some things should never leave the machine.
- [ ] Multi-instance brain management — `E:\cores\*` pattern (Wendy, future Cora, others). Need tooling to spawn, configure, and manage multiple brain instances from one place.
- [ ] Core-brain as proper shared dependency — Dash currently copies memory code. Should import from core-brain as a local npm dependency so vouchers, encryption, and lock enforcement stay in sync.

## P3 — Backlog

- [ ] Local model fallback chain — if private mode is on and Ollama is down, queue requests instead of failing. Resume when available.
- [ ] Voucher scoping enforcement — currently scope is informational. Make it actually restrict what the voucher holder can do (e.g. `read:settings` only allows `get_settings`).
- [ ] Cross-brain audit dashboard — Dash UI view showing all voucher activity, access attempts, and security events across all instances.
- [ ] Pre-release security checklist — automated scan before any public release: no PII in git, no hardcoded keys, all brain files encrypted, `.locked` covering sensitive paths.
- [ ] Clean git history for v2 — fresh initial commit or filter-branch to strip all development history before public release.
