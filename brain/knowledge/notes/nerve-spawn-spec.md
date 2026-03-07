# Nerve Spawning — Spec

> Status: Draft (2026-03-07)
> Origin: "Can't go back once you chat anywhere. Sync just works."

## What

Any device becomes a nerve by opening a URL and entering the safe word. No install. No pairing. No account creation. The browser is the membrane. The PWA is the nerve. The brain stays home. The nerve carries what it needs and syncs when it can.

Personalized. Safe. Portable.

## Why

Parents won't install VPNs. They won't follow setup steps. They won't download apps from a store. They will type a URL and enter a word. That's the ceiling. Everything above that ceiling is engineering's problem, not the user's.

Once someone chats with their agent from a second device, the expectation is permanent. Sync is invisible. The brain is everywhere they are. You can't un-ring that bell.

## Done when

- Open URL on any device, enter safe word, you're talking to your agent
- Works on WiFi, cellular, offline, airplane mode
- Chat history, board, and recent context are on every nerve
- New messages sync back when connection resumes — no user action
- Device form factor determines the nerve shape automatically
- A parent can do it without help

## The three promises

| Promise | How |
|---------|-----|
| **Personalized** | Every nerve reads your brain. Same context, same threads, same agent personality. The snapshot carries your identity. |
| **Safe** | Safe word decrypts locally. Membrane redacts before cloud calls. Local LLM needs no network at all. No data at rest on the device is readable without the key. |
| **Portable** | Brain lives on one machine. Nerves carry encrypted snapshots. Any browser, any device, any network. Walk away and keep talking. |

## Nerve types by device

The nerve isn't configured. It's detected. The PWA reads the viewport, input methods, and device capabilities and assembles the right interface.

| Device | Nerve profile | What surfaces |
|--------|--------------|---------------|
| Watch | Glance | Pulse strip, nudges, single-tap responses |
| Phone | Voice + Touch | Chat, board, quick capture, voice input |
| Tablet | Touch | Full board, threads, operations, side-by-side |
| PC | Keyboard + Touch | Everything — the home station |

Same brain. Same safe word. Same session. Different shape.

## How a nerve spawns

```
1. User opens URL in browser (any device)
2. Service worker installs, caches app shell
3. Auth screen: enter safe word
4. Safe word → PBKDF2 → session key (deterministic)
5. Session key authenticates against Dash server (if reachable)
6. Server sends encrypted brain snapshot → stored in IndexedDB
7. "Add to Home Screen" prompt (PWA install)
8. Nerve is live.
```

After first sync, the nerve is self-sufficient. It doesn't need the server to function — only to sync.

## Brain snapshot — what travels

| Included | Why |
|----------|-----|
| Chat threads (last N messages per thread) | Continuity |
| Board state (pins, items) | Async collaboration |
| Recent memories (last 50 episodic) | Agent has context |
| Settings (posture, preferences) | Personalization |
| Agent identity (name, tone, principles) | Personality |

| Excluded | Why |
|----------|-----|
| Vault (keys, credentials) | Never leaves home |
| Full memory archive | Too large, not needed for chat |
| Credential store | Security boundary |
| Other instances' data | Membrane isolation |

## Sync model

**Down-sync (server → nerve):**
- On connect: pull fresh snapshot, update IndexedDB
- Differential: only changed entries since last sync timestamp
- Encrypted in transit and at rest (session key)

**Up-sync (nerve → server):**
- Queued writes stored in IndexedDB while offline
- On reconnect: replay in order via `POST /api/sync/replay`
- Types: new chat messages, board pins, quick capture entries

**Merge strategy:**
- Chat threads: append-merge (messages are append-only by nature)
- Board items: append-merge (pins are events)
- Settings: last-write-wins (single-user, no real conflict)
- No merge dialogs. No conflict screens. Sync is invisible.

**Sync indicator:**
- Connected + current: no indicator (clean)
- Connected + syncing: subtle pulse on status
- Offline: amber dot (not a banner, not a modal — a dot)

## LLM on the nerve

The nerve doesn't depend on the home server for inference. It carries its own.

**Fallback chain:**
1. **Local on-device model** — Gemma 2B / Phi-3 Mini / Llama 3.2 3B via MediaPipe LLM Inference API or WebLLM. Always available. Fully sovereign. No network needed.
2. **Cloud LLM through membrane** — OpenRouter / Anthropic / OpenAI. Activates once membrane trust is proven on that nerve. Membrane redacts sensitive fields before network egress. Same typed-placeholder system as desktop.
3. **No inference** — Browse cached brain, read threads, view board. Queue messages for when inference returns.

Every nerve gets local model on day one. Cloud model is earned — the membrane has to prove it can protect the snapshot on that device first. This isn't a premium tier. It's a trust gate.

## Membrane on the nerve

The membrane travels with the snapshot. Every nerve enforces the same rules:

- Sensitive fields identified by `brain/knowledge/sensitive.yaml` patterns
- Cloud LLM calls go through membrane redaction before network egress
- Local LLM calls skip the membrane (no network, no risk)
- The nerve's membrane is a copy of the home membrane — not a weaker version
- If the membrane spec updates at home, next sync pushes the update to all nerves

## Security model

- **At rest:** Snapshot encrypted in IndexedDB with session key. Device theft without safe word = unreadable blob.
- **In transit:** Sync over HTTPS (when available) or local network. Snapshot is pre-encrypted regardless.
- **In memory:** Decrypted only while PWA is active and session is valid. Service worker doesn't hold decrypted content.
- **Session timeout:** Configurable. Lock screen returns to safe word prompt. Cached snapshot stays encrypted.
- **Wipe:** "Forget this device" from any nerve or from home — clears IndexedDB, removes service worker, revokes sync token.

## Endpoints (new in Dash server)

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/sync/snapshot` | GET | Encrypted brain snapshot for nerve |
| `/api/sync/replay` | POST | Replay queued writes from nerve |
| `/api/sync/status` | GET | Last sync timestamp, pending changes |
| `/api/nerve/register` | POST | Register a new nerve (device fingerprint + session) |
| `/api/nerve/revoke` | POST | Wipe a nerve remotely |
| `/api/nerve/list` | GET | All registered nerves for this session |

## What this replaces

This isn't "mobile access." This is the product.

- No app store
- No account creation
- No cloud dependency
- No subscription gate on basic features
- No separate mobile UI
- No "desktop version" vs "mobile version"

One brain. Many nerves. Any device. Type the URL. Enter the word. You're home.

## Open questions

1. **Snapshot size** — How much brain fits comfortably in IndexedDB? 5MB? 50MB? Depends on thread history depth.
2. **Local model selection** — Which models run well in-browser on mid-range Android phones? Need benchmarks.
3. **Watch feasibility** — WearOS browser is limited. Can a Wear PWA run a service worker? May need Tile API instead.
4. **Sync frequency** — On WiFi: continuous? Every 5 min? On connect only?
5. **Multi-user on shared device** — Different safe words on same device URL. IndexedDB keyed by session hash. Architecturally clean but needs testing.
6. **WebLLM vs native** — MediaPipe LLM Inference API vs WebLLM (runs ONNX/WASM in browser). Which is more portable?
