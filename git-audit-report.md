# Git History Audit Report

**Date:** 2026-03-04
**Repos audited:** `E:/core` (44 commits), `E:/dash` (492 commits)
**Scope:** PII, credentials, secrets, private keys in full commit history

---

## Summary

| Category | Core | Dash | Severity |
|----------|------|------|----------|
| Leaked credentials / API keys | None | None | - |
| Private keys / certificates | None | None | - |
| Personal email addresses | 2 found | 4 found | Medium |
| Phone numbers | None | None (timestamps only) | - |
| .env files with secrets | None (only .env.example) | None (only .env.example) | - |
| Hardcoded sender emails | 1 (fixed later) | 1 reference | Medium |
| Agent log PII | — | Deleted in e52d8dd but still in history | Medium |

**Overall: No credentials leaked. Main concern is personal email addresses baked into git history.**

---

## Detailed Findings

### 1. Personal Email Addresses (Medium)

| Email | Repo | Context | Commit(s) | Status |
|-------|------|---------|-----------|--------|
| `lfcasalf@gmail.com` | core | Hardcoded as `DEFAULT_FROM` in `src/google/gmail-send.ts` | `808c22b` (initial), fixed in `431a300` | **In history** — replaced with env var in later commit, but original remains in git log |
| `lfcasalf@gmail.com` | dash | Agent prompt log referencing Gmail sending | `e52d8dd` (deleted) | **In history** — file deleted but content persists in git log |
| `bcherrman@gmail.com` | core | Activity JSONL log entry ("Processing inbound email from...") | Recent agent batch commits | **In history** — operational log committed |
| `bcherrman@gmail.com` | dash | Agent prompt log ("To: bcherrman@gmail.com") | `e52d8dd` (deleted) | **In history** — file deleted but persists in git log |
| `alerts@herrmangroup.com` | dash | Hardcoded in distribution planning doc | `e52d8dd` (deleted) | **In history** — doc deleted but persists |
| `TOKEN@in.bragbin.com` | dash | BragBin product exploration research doc | `e52d8dd` (deleted) | **In history** — likely a placeholder/example but persists |

### 2. Git Author Email (Low)

Both repos use `dev@xdmpartners.com` as the sole commit author. This is an infrastructure email — acceptable for private repos, but ties all commits to this domain if repos go public.

### 3. Infrastructure Emails (Info — Intentional)

These appear in config/settings and are operational:
- `agent@pqrsystems.com`
- `core@pqrsystems.com`
- `wendy@pqrsystems.com`

No action needed unless you want to anonymize before going public.

### 4. Credentials — Clean

- All API keys use `process.env.*` lookups (RESEND_API_KEY, OPENROUTER_API_KEY, TWILIO_*, etc.)
- Only `.env.example` files were committed — with empty placeholder values
- Test fixtures use obvious dummy values: `sk-or-abc123`, `sk-or-test123`
- No private keys, certificates, or bearer tokens found in history
- Startup auth tokens are generated at runtime (`randomBytes(32)`) — never persisted

### 5. Phone Numbers — Clean

All phone-number-shaped matches in both repos are either:
- Unix timestamps in session IDs (e.g., `1772660488`)
- Twilio's well-known sandbox number (`+14155238886`) in `.env.example` comments
- Obvious test data (`15551234567`, `15551111111`)

---

## Remediation

### If repos remain private: No immediate action required.

### If repos go public, scrub these personal emails from history:

#### Option A: git-filter-repo (recommended)

```bash
# Install git-filter-repo if not already available
pip install git-filter-repo

# For core repo:
cd /e/core
git filter-repo --replace-text <(cat <<'EOF'
lfcasalf@gmail.com==>REDACTED@example.com
bcherrman@gmail.com==>REDACTED@example.com
EOF
) --force

# For dash repo:
cd /e/dash
git filter-repo --replace-text <(cat <<'EOF'
lfcasalf@gmail.com==>REDACTED@example.com
bcherrman@gmail.com==>REDACTED@example.com
alerts@herrmangroup.com==>REDACTED@example.com
EOF
) --force
```

#### Option B: BFG Repo Cleaner (simpler for large repos)

```bash
# Create a replacements file
cat > replacements.txt <<'EOF'
lfcasalf@gmail.com ==> REDACTED@example.com
bcherrman@gmail.com ==> REDACTED@example.com
alerts@herrmangroup.com ==> REDACTED@example.com
EOF

# Run BFG
java -jar bfg.jar --replace-text replacements.txt /e/core
java -jar bfg.jar --replace-text replacements.txt /e/dash

# Then for each repo:
git reflog expire --expire=now --all && git gc --prune=now --aggressive
```

### Preventive measures

1. **Add `.gitignore` entries** for `brain/agents/logs/` and operational JSONL files that may contain user data
2. **Pre-commit hook** using [git-secrets](https://github.com/awslabs/git-secrets) or [gitleaks](https://github.com/gitleaks/gitleaks) to catch PII/credentials before commit
3. **Don't commit agent prompt logs** — they may contain user-provided PII (emails, names, instructions)
4. **Review JSONL files** before committing — activity logs can capture inbound email addresses

---

## Conclusion

Both repositories are **clean of leaked credentials**. The only security concern is **personal email addresses** (`lfcasalf@gmail.com`, `bcherrman@gmail.com`, `alerts@herrmangroup.com`) embedded in git history through agent logs and hardcoded defaults. These were subsequently removed from the working tree (via env vars or file deletion) but persist in git history. Remediation is only necessary if the repos will be made public.
