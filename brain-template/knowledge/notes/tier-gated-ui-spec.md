# Tier-Gated UI

> Status: **Approved by Dash**
> Created: 2026-03-08

## Problem

A fresh `npx @runcore-sh/runcore` install shows the full settings panel — mesh config, LLM providers, voice settings, Google Workspace, Linear board integration, service registry, API key vault, and navigation to observatory, ops, roadmap, registry pages. None of these work on local tier. The UI promises capabilities the system cannot deliver.

Worse: the UI implies infrastructure connectivity that doesn't exist. A fresh local install is a stranger — no bond, no governance, no membrane, no trust chain. The interface should reflect that.

## Principle

**The UI is a symptom of unresolved autonomy.** If the system can't do it, the button shouldn't exist. Progressive disclosure applies to UI surfaces the same way it applies to brain context — show what's relevant, hide what isn't, unlock as capability grows.

## Tier Capability Matrix

| Capability | Local | BYOK | Spawn | Hosted |
|---|---|---|---|---|
| Chat | yes | yes | yes | yes |
| Brain (memory, knowledge) | yes | yes | yes | yes |
| Ollama (local inference) | yes | yes | yes | yes |
| Identity (name, personality) | yes | yes | yes | yes |
| Safe word | yes | yes | yes | yes |
| HTTP server + UI | yes | yes | yes | yes |
| API key vault | no | yes | yes | yes |
| Cloud LLM providers | no | yes | yes | yes |
| Mesh (LAN discovery) | no | yes | yes | yes |
| Voice (TTS/STT) | no | yes | yes | yes |
| Integrations (Google, Linear, etc.) | no | yes | yes | yes |
| Service registry | no | yes | yes | yes |
| Agent spawning | no | no | yes | yes |
| Governance (vouchers, policies) | no | no | yes | yes |
| Alerting (SMS, email, webhook) | no | no | yes | yes |
| Observatory (system metrics) | no | no | yes | yes |

## UI Surface by Tier

### Local Tier (fresh install)

**Header nav:** None. No page links. Just the agent name and the chat.

**Settings panel shows:**
- Agent name (editable)
- Personality / custom rules
- Safe word mode
- Ollama model selection (local models only)
- Airplane mode toggle (locked ON, greyed out with "Local tier" label)

**Settings panel hides:**
- Mesh settings section
- LLM provider section (OpenRouter, API keys)
- Voice settings section
- Google Workspace section
- Task board / Linear section
- Key vault section
- "Manage Services & Capabilities" link

**Pages accessible:** `/` (chat) only. All other pages return 404 or redirect to `/`.

**Upgrade prompt:** Small, non-intrusive text at bottom of settings: "Unlock cloud models, voice, and integrations → `runcore register`"

### BYOK Tier

**Header nav:** `/library`, `/life`

**Settings panel adds:**
- API key vault
- LLM provider selection (cloud models)
- Airplane mode toggle (now functional)
- Voice settings (if sidecar detected)
- Integrations section (Google, Linear, etc.)
- "Manage Services" link → `/registry`

**Pages accessible:** `/`, `/library`, `/life`, `/registry`, `/help`

### Spawn Tier

**Header nav:** Full nav — `/library`, `/personal`, `/life`, `/registry`, `/observatory`, `/ops`, `/board`, `/roadmap`

**Settings panel adds:**
- Mesh settings (LAN announce, allow incoming)
- Agent spawning controls
- Governance dashboard link

**Pages accessible:** All pages.

### Hosted Tier

Same as Spawn. No additional UI — hosted is about who runs the infrastructure, not what the UI shows.

## Implementation

### 1. Server: expose tier to client

**Route:** `GET /api/tier` (already partially exists via settings)

Response:
```json
{
  "tier": "local",
  "capabilities": {
    "brain": true,
    "ollama": true,
    "server": true,
    "ui": true,
    "vault": false,
    "mesh": false,
    "spawning": false,
    "governance": false,
    "alerting": false,
    "voice": false,
    "integrations": false
  }
}
```

### 2. Client: fetch tier on load, gate UI

On page load (after auth), fetch `/api/tier`. Store in `window.__TIER__`.

Each settings section gets a `data-requires` attribute:
```html
<div id="mesh-settings-section" data-requires="mesh">
<div id="llm-settings-section" data-requires="vault">
<div id="voice-settings-section" data-requires="voice">
<div id="google-settings-section" data-requires="integrations">
<div id="board-settings-section" data-requires="integrations">
```

On tier load:
```javascript
function applyTierGating(caps) {
  document.querySelectorAll('[data-requires]').forEach(el => {
    const cap = el.dataset.requires;
    if (!caps[cap]) el.remove();  // remove, not hide — don't tease
  });
}
```

### 3. Navigation: tier-gated links

```javascript
const NAV_BY_TIER = {
  local:  [],
  byok:   ['library', 'life', 'registry', 'help'],
  spawn:  ['library', 'personal', 'life', 'registry', 'observatory', 'ops', 'board', 'roadmap'],
  hosted: ['library', 'personal', 'life', 'registry', 'observatory', 'ops', 'board', 'roadmap'],
};
```

Build nav dynamically from this map. No hardcoded links in HTML.

### 4. Page-level gating

Each sub-page (library.html, ops.html, etc.) also fetches `/api/tier` and redirects to `/` if the tier doesn't support it. Defense in depth — even if someone types the URL directly.

### 5. Settings.json template cleanup

The brain-template `settings.json` should reflect local tier defaults:

```json
{
  "airplaneMode": true,
  "models": { "chat": "auto", "utility": "auto" },
  "encryptBrainFiles": false,
  "safeWordMode": "always",
  "instanceName": "Core",
  "integrations": { "enabled": false, "services": {} }
}
```

No TTS/STT/avatar/backup/pulse/mesh config — those get created when the tier unlocks them.

## What This Does NOT Change

- The server still boots all routes regardless of tier (defense in depth is at the UI and middleware level, not route registration)
- The `requireSurface()` middleware already gates some pages — this complements it
- Tier upgrades take effect immediately without restart (client re-fetches `/api/tier`)
- The brain-template stays minimal — no personal data, no service configs

## Verification

1. Fresh `npx @runcore-sh/runcore` → chat screen only, minimal settings, no nav links
2. `runcore register` + `runcore activate <token>` → settings expand, nav appears
3. Direct URL to `/ops` on local tier → redirects to `/`
4. Settings panel never shows capabilities the tier can't deliver
