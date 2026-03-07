# Core OS — Spec

> Status: Draft (2026-03-07)
> Origin: "The host needs an OS, a nerve needs an endpoint."

## What

Core OS is the native runtime that holds and runs a brain. It is the host. It manages processes, storage, encryption, lifecycle, agents, membrane, and the tick cycle. It serves nerve endpoints but is not one. It runs on any device capable of being a trusted home — phone, PC, Raspberry Pi, NAS, server.

The nerve spec (nerve-spawn-spec.md) defines how endpoints connect. This spec defines what they connect to.

## Why

A browser can't hold a brain. No background persistence, no filesystem sovereignty, no real encryption at rest, no process lifecycle. The brain deserves a real home — not a tab that the OS can kill at will.

The host is infrastructure. It must survive reboots, sleep, power loss, and network changes. It must own its storage. It must be trusted, or nothing downstream can be trusted.

## Done when

- Core OS runs as a native process on Android, Linux, macOS, and Windows
- Brain is encrypted at rest, decrypted only while OS is running and authenticated
- Tick cycle (sense → work → joy) runs continuously in the background
- Nerves connect via URL, authenticate with safe word, receive snapshots
- Agents spawn and run within the OS process
- Membrane enforces on all outbound data — LLM calls, tunnel content, nerve snapshots
- Host survives device restart and resumes without user intervention
- A parent can set it up once and forget it exists

## What the OS does

### 1. Brain storage

- Owns a filesystem directory (or encrypted partition on mobile)
- Brain files: JSONL, YAML, markdown — same format as today
- Encrypted at rest using key derived from safe word (or device keychain on mobile)
- Decrypted into memory on unlock, re-encrypted on lock/sleep
- Backup: encrypted snapshots to local storage, USB, or (optionally) a bonded host

### 2. Process lifecycle

- Runs as a background service / daemon
- Survives app switching, screen off, device sleep
- Auto-starts on boot (configurable)
- Graceful shutdown: flush pending writes, seal brain, notify nerves
- Crash recovery: journal-based (JSONL is already append-only, recovery is replay)

### 3. Tick cycle

- **Sense:** Read ledger, check nerves, scan inbound tunnel envelopes, check dehydration timers
- **Work:** Process queued tasks, run agent actions, handle sync requests from nerves
- **Joy:** Measure delta — what changed, what improved, what needs attention. Update pulse.
- Runs on action (not timer). Every inbound event triggers a tick. Idle brain idles.

### 4. Agent runtime

- Agents are processes within the OS, not separate services
- Each agent has: access manifest, identity, scoped brain access
- Agents emit activity to `brain/ops/activity.jsonl` (feeds the runtime feed spec)
- Governance: voucher-checked, principle-bound, audited
- Spawn and kill managed by OS, not by individual agents

### 5. Membrane

- Enforces on all outbound paths: LLM calls, tunnel content, nerve snapshots, agent actions
- Sensitive field registry loaded from `brain/knowledge/sensitive.yaml`
- Typed-placeholder redaction — reversible, auditable
- Membrane config syncs to nerves (they enforce the same rules on their local LLM calls)
- The membrane is not optional. There is no mode where it is off.

### 6. Nerve server

- Hono HTTP server on a local port (auto-discovered, announced via mDNS on LAN)
- Serves: auth, sync snapshots, replay writes, nerve registration, brain API
- Does NOT serve the UI directly — nerves bring their own PWA shell
- Actually: serves the PWA shell too (index.html, sw.js, manifest.json) so the nerve can bootstrap from the URL

### 7. Tunnel relay client

- Connects to relay (runcore.sh or self-hosted) for inter-instance communication
- Sends/receives sealed envelopes per tunnel spec
- Relay connection is outbound-only — no inbound ports needed
- Tunnels survive network changes (reconnect on new IP)

### 8. Encryption

- Brain at rest: AES-256-GCM, key from PBKDF2(safe word, device salt)
- Brain in memory: decrypted working set only (not full brain)
- Nerve snapshots: encrypted with session key before transmission
- Tunnel envelopes: E2E encrypted with bond key (Ed25519 + X25519)
- Device keychain integration on mobile (Android Keystore, iOS Keychain) for key protection

## Platform targets

| Platform | Runtime | Package | Priority |
|----------|---------|---------|----------|
| Android | Kotlin + embedded Node (or pure Kotlin rewrite) | APK / Play Store | 1 — phone is the most sovereign device |
| Linux | Node.js daemon (systemd) | .deb / AppImage / Docker | 2 — servers, Pi, NAS |
| Windows | Node.js service (or Electron shell) | .exe / winget | 3 — current dev environment |
| macOS | Node.js daemon (launchd) | .dmg / brew | 4 |
| iOS | Swift + embedded runtime | App Store | 5 — Apple restrictions make this hardest |

### Android specifics

- Foreground service with persistent notification ("Core is running")
- Battery optimization exemption (user grants once at setup)
- Storage: app-private encrypted directory (not SD card)
- Local LLM: run natively via llama.cpp / MediaPipe, not through browser
- mDNS announcement for LAN nerve discovery
- WiFi + cellular: brain is always reachable by local nerves on same device, LAN nerves on WiFi

### Linux / Raspberry Pi

- The home server model: Pi in a closet, always on, brain lives there
- All devices in the house are nerves connecting to the Pi
- Lowest cost host: $35 device, runs indefinitely, sips power
- Perfect for the parent use case: set it up once, plug it in, done

## What the OS does NOT do

- **No UI.** The OS has no screens. Nerves have screens. The OS serves nerves.
- **No user-facing preferences panel.** Settings come through a nerve (the settings page in the PWA).
- **No cloud dependency.** Cloud LLM is optional, gated by membrane. Local LLM is the default.
- **No multi-user.** One brain per OS instance. Different people run different instances. Isolation is structural.
- **No app store for agents.** Agents are spawned by the brain owner, governed by access manifests. No marketplace.

## The split

```
┌─────────────────────────────────────────┐
│              Core OS (Host)             │
│                                         │
│  Brain ── Agents ── Membrane ── Ticks   │
│    │         │          │               │
│    │         │          │               │
│  Storage   Runtime   Enforcement        │
│  (files)   (processes) (all outbound)   │
│                                         │
│  ┌─── Nerve Server (Hono) ───┐          │
│  │  /api/sync/snapshot       │          │
│  │  /api/sync/replay         │          │
│  │  /api/nerve/register      │          │
│  │  /api/auth                │          │
│  │  /public/* (PWA shell)    │          │
│  └───────────────────────────┘          │
│                                         │
│  ┌─── Tunnel Client ────────┐           │
│  │  relay connection        │           │
│  │  envelope send/receive   │           │
│  └──────────────────────────┘           │
└─────────────────────────────────────────┘
          │              │
     ┌────┘              └────┐
     ▼                        ▼
┌──────────┐           ┌──────────┐
│  Nerve   │           │  Nerve   │
│  (Phone) │           │  (PC)    │
│  PWA     │           │  Browser │
│  Local   │           │  Full    │
│  LLM     │           │  keyboard│
└──────────┘           └──────────┘
```

## Relationship to existing code

| Current | Becomes |
|---------|---------|
| `src/brain.ts` | Core OS brain module (unchanged) |
| `src/server.ts` | Nerve server within Core OS |
| `src/mcp-server.ts` | Internal brain API (agents use this) |
| `src/agents/` | Agent runtime within Core OS |
| `src/llm/membrane.ts` | Membrane module within Core OS |
| `brain/` directory | The brain — owned by the OS, served to nerves |
| Dash (`E:/dash`) | First nerve implementation (PWA) + first OS prototype |

Dash is currently both host and nerve in one process. The split separates them. The host becomes Core OS. The nerve becomes the PWA. Dash's server.ts is the embryo of both.

## Setup (the parent test)

1. Install app (Play Store / apt install / download)
2. Open app. "Choose a safe word."
3. Done. Core OS is running. Brain is created. Nerve server is live.
4. On another device: open browser, type `http://<phone-name>.local:3577`
5. Enter safe word. You're in.

Five steps. One decision (the safe word). No email. No password rules. No verification code. No terms of service checkbox.

## Open questions

1. **Node on Android** — Embedded Node.js (via libnode) or rewrite core runtime in Kotlin? Kotlin is cleaner but doubles the codebase.
2. **iOS feasibility** — Apple kills background processes aggressively. Can Core OS survive on iOS, or is iOS nerve-only?
3. **Pi as default host** — Should the recommended setup be "Pi in a closet + phone as nerve" rather than phone as host?
4. **Brain migration** — Moving brain from one host to another (old phone to new phone). Encrypted backup → restore? Direct transfer over LAN?
5. **Multiple hosts** — Can one person run two hosts (phone + Pi) with the same brain? Or is it strictly one host, N nerves? Replication vs single source of truth.
6. **Packaging** — Play Store requires review. Side-loading (APK) is faster but loses parent trust. F-Droid?
