# Prompt Security Boundary

The system prompt has two layers: a **core prompt** controlled by the runtime, and a **personality layer** controlled by the user. The boundary between them is a security surface.

## Core prompt (runtime-controlled, not user-editable)

The core prompt is compiled at boot from `src/server.ts`. It includes:

| Section | Purpose | Why it's locked |
|---------|---------|-----------------|
| Identity block | Agent name, human name, privacy statement | Prevents identity spoofing between instances |
| Date and tier | Current date, active capability tier | Prevents hallucinated dates and capability claims |
| Capability boundaries | Explicit CAN/CANNOT list derived from `TIER_CAPS` | Prevents agents from offering actions they can't execute |
| Rules | Don't invent information, don't reference absent data | Prevents hallucination patterns |
| Agent spawning protocol | `[AGENT_REQUEST]` format, prompt quality rules | Prevents malformed agent spawns that waste resources |
| Autonomous work description | Background timer behavior, cooldowns, circuit breakers | Only injected when `spawning` capability is active |
| Security | Encrypted memory rules, password handling | Prevents credential leakage through the chat channel |
| Integrations status | Google/Slack/etc. availability, auth state | Prevents false claims about connected services |

The core prompt is **not** stored in the brain. It's compiled from code. A user cannot modify it by editing brain files.

### Why this matters

If the core prompt were editable, a user (or a compromised agent) could:

1. **Remove capability boundaries** — make a local-tier agent claim it can browse the web, send emails, or spawn agents. The agent would confidently promise actions it cannot deliver.
2. **Remove safety rules** — disable "don't invent information" or "don't reference absent data," producing an agent that hallucinates freely.
3. **Alter identity** — make one instance impersonate another, breaking trust in multi-instance environments.
4. **Bypass tier gating** — inject spawning instructions into a local-tier agent's prompt, causing it to emit `[AGENT_REQUEST]` blocks that the runtime correctly ignores but that confuse the user.
5. **Leak credentials** — remove the "never reveal password" instruction, exposing the safe word or vault keys through social engineering.

The core prompt is the contract between the runtime and the model. Breaking it breaks the agent.

## Personality layer (user-controlled, editable)

The personality layer is injected from brain files. Users customize it freely:

| File | What it controls |
|------|-----------------|
| `brain/identity/personality.md` | Voice, tone, conversational style |
| `brain/identity/tone-of-voice.md` | Writing rules, word choices, what to avoid |
| `brain/identity/brand.md` | Organization positioning, audience |
| `brain/identity/principles.md` | Decision-making guidelines |
| `brain/skills/*.yaml` | Task-specific instructions and triggers |
| `brain/settings.json` → `instanceName` | The agent's name |

The personality layer is wrapped in `--- Custom personality ---` delimiters inside the core prompt. It can shape how the agent communicates but cannot override what the agent is allowed to do.

### What personality CAN do

- Change the agent's voice (formal, casual, terse, warm)
- Add domain expertise ("you specialize in healthcare compliance")
- Set communication preferences ("always use bullet points")
- Inject organizational context ("our company ships physical products")

### What personality CANNOT do

- Grant capabilities the tier doesn't support
- Override safety rules
- Change the agent spawning protocol
- Access vault keys or encrypted memories
- Alter identity claims (name comes from `settings.json`, not personality)

## The principle

**Personality is skin. Core prompt is skeleton.**

Users customize how the agent feels. The runtime controls what the agent is. Same principle as the UI posture system: personalization (colors, labels, order) is free. The three signals (Sense/Work/Joy) are the non-negotiable contract.

This split is a security boundary, not a convenience feature. It prevents:

- **Privilege escalation** — personality cannot widen capabilities
- **Identity spoofing** — personality cannot change who the agent claims to be
- **Safety bypass** — personality cannot remove hallucination guards
- **Social engineering** — personality cannot expose system secrets

## Implementation

The boundary is enforced in `src/server.ts` at the Brain construction site (~line 379). The core prompt is a string array built from runtime state. The personality file is loaded from disk and injected in a delimited block within that array. The personality block has no structural power — it's context, not instructions that override preceding instructions.

The capability boundary block is generated dynamically from `TIER_CAPS[activeTier]` so it always reflects the actual runtime capabilities, not a static document that could drift.

## Upgrade path visibility

When the core prompt tells the agent what it CANNOT do, it also tells it how the user can unlock those capabilities:

> "If the user asks for something outside your capabilities, explain what tier unlocks it and how to upgrade (Settings → API Keys, or run `runcore register`)."

This turns the security boundary into a natural upsell without the agent hallucinating features. The agent honestly says "I can't do that, but here's how to unlock it" instead of pretending or going silent.
