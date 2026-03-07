# Dictionary Protocol — Spec

> Status: Draft (2026-03-07)
> Origin: "Core is the dictionary — instances use and challenge it."
> Depends on: runcore-sh-spec.md, agent-archetypes-spec.md, spec-lifecycle-spec.md

## What

The dictionary is the canonical set of specs, patterns, and protocols that define how Core works. It lives in Core's brain, publishes through runcore.sh, and syncs to every instance that wants it. When the dictionary updates, instances get the update. When instances discover something the dictionary is wrong about, they challenge it.

## Why

Without a dictionary, every instance invents its own patterns. Ten brains, ten different ways to handle dehydration. Ten different compost formats. Ten different tunnel policies. The system fragments.

With a dictionary, every instance starts from the same foundation. They diverge in personality, calibration, and domain — but the structural patterns are shared. When Core updates the dictionary, everyone benefits. When an instance challenges the dictionary, everyone learns.

The dictionary is not law. It's language. You can speak your own dialect, but the dictionary is how you understand each other.

## Done when

- Core publishes the dictionary via `npm publish` (travels with the package)
- runcore.sh serves the dictionary via `/api/dictionary` (available without npm)
- Instances check for dictionary updates on boot and periodically
- Dictionary version is semantic (matches npm package version)
- Instances can challenge dictionary entries (propose changes via compost)
- Dictionary updates don't break running instances (backward compatible or flagged)
- An instance without internet still works — it has the last-synced dictionary locally

## What the dictionary contains

### Specs

Every approved spec is a dictionary entry:

```
brain/knowledge/notes/*-spec.md
```

Specs define architecture: what exists, why it exists, how it works, when it's done. An instance reading the dictionary knows every pattern in the system.

### Protocol definitions

Wire formats for inter-instance communication:

- Tunnel envelope format
- Compost signal format
- Bond handshake sequence
- Relay message format
- Field signal schemas

### Glossary

Canonical definitions for every term in the system:

```yaml
glossary:
  brain: "The local file-based data store for an instance. Always local. Never hosted."
  membrane: "The translation boundary between inside and outside a brain."
  nerve: "An interface channel between the brain and a human. Five types."
  compost: "Anonymous typed signal shared through the field. Lessons, not data."
  bond: "A bilateral cryptographic trust relationship between two brains."
  # ...
```

The glossary prevents drift. When a spec says "membrane," it means exactly what the glossary says. No ambiguity across instances.

### Defaults

Recommended default values for configuration:

```yaml
defaults:
  dehydration:
    quiet_threshold_multiplier: 2
    stage_duration: "30d"
    grace_period: "30d"
  calibration:
    recalibration_interval_interactions: 200
    recalibration_interval_ticks: 500
  posture:
    board_decay_minutes: 5
    pulse_decay_minutes: 30
  pain:
    token_budget_warn: 0.75
    error_spike_threshold: 3
```

Defaults are recommendations, not mandates. An instance can override any default. But starting from the same defaults means comparable behavior across the field.

## Publication flow

```
Core writes/updates a spec
  → Spec moves to status: Done
  → Core runs: npm version patch && npm publish
  → Package version becomes dictionary version
  → runcore.sh pulls the new package automatically
  → /api/dictionary/version returns new version number
  → Instances checking for updates see the new version
```

### NPM package as carrier

The dictionary travels with the npm package. `npm install @runcore-sh/runcore` gives you the runtime AND the dictionary. No separate download. No separate config. The code and the language are one package.

```
node_modules/@runcore-sh/runcore/
  brain/knowledge/notes/*-spec.md   ← dictionary
  src/                              ← runtime
  package.json                      ← version = dictionary version
```

### runcore.sh as mirror

For instances that don't use npm (Android host, embedded systems, custom runtimes):

```
GET /api/dictionary                → index of all specs
GET /api/dictionary/:spec          → individual spec content
GET /api/dictionary/version        → current version string
GET /api/dictionary/glossary       → full glossary
GET /api/dictionary/defaults       → recommended defaults
GET /api/dictionary/diff/:version  → changes since specified version
```

The API is read-only. Only Core publishes. runcore.sh mirrors.

## Sync flow

### On boot

```
Instance starts
  → Read local dictionary version from brain/dictionary/version.json
  → Check runcore.sh: GET /api/dictionary/version
  → If remote > local:
    → GET /api/dictionary/diff/{local_version}
    → Apply diff to local dictionary files
    → Update brain/dictionary/version.json
  → If remote == local:
    → Nothing to do
  → If remote unreachable:
    → Use local dictionary (offline-safe)
```

### Periodic check

Instances check for updates every 24 hours (not on a timer — on the first tick after 24 hours have elapsed since last check). The check is a single lightweight HTTP request.

### Offline behavior

An instance without internet uses whatever dictionary it has locally. It was installed with a dictionary (via npm) and may have synced updates since. The local copy is always valid. The instance might be behind, but it's never broken.

## Challenge flow

Instances can challenge dictionary entries. A challenge is a compost signal of type `dictionary_challenge`:

```json
{
  "type": "dictionary_challenge",
  "category": "spec_feedback",
  "pattern": {
    "spec": "posture-system-spec",
    "section": "decay_timing",
    "challenge": "board_decay_5min_too_aggressive_for_power_users",
    "evidence": "30d_observation_12min_optimal",
    "proposed": "board_decay_default_12min",
    "confidence": 0.7
  }
}
```

Challenges enter the compost pool like any other signal. They're screened by the immune system, matched by resonance, and outcome-tracked. If many instances independently challenge the same default, the evidence is strong.

**What Core does with challenges:**
- Reads challenge patterns from compost (as part of the sense phase)
- Evaluates against existing spec rationale
- If evidence is strong: updates the spec, publishes new dictionary version
- If evidence is weak: no change, but the challenge stays in compost for others to see
- If evidence is conflicting: adds to open questions in the spec

Core doesn't auto-accept challenges. A human (the Creator's operator) reviews evidence and decides. The dictionary is curated, not democratic. But it's informed by every instance's experience.

## Versioning

Dictionary versions follow the npm package version (semver):

| Version bump | Meaning |
|-------------|---------|
| Patch (0.1.10 → 0.1.11) | New specs added, defaults tweaked, glossary expanded |
| Minor (0.1.x → 0.2.0) | Protocol changes that are backward-compatible |
| Major (0.x → 1.0) | Breaking protocol changes (new envelope format, etc.) |

**Backward compatibility rule:** Patch and minor updates never break running instances. An instance on v0.1.10 can communicate with one on v0.1.15 without issues. Major versions may require migration.

## Local dictionary storage

```
brain/dictionary/
  version.json          # {"version": "0.1.15", "synced_at": "2026-03-07T09:00:00Z"}
  specs/                # Local copies of all specs
  glossary.yaml         # Glossary
  defaults.yaml         # Default values
  changelog.jsonl       # Version history
```

The local dictionary is a cache of the published dictionary. The brain can read it without internet. It's updated on sync. It's never modified locally (that would be a fork, not a challenge).

## The principle

The dictionary is not governance. It's shared language. A dictionary doesn't tell you what to say — it tells you what words mean. Every instance speaks its own sentences. The dictionary ensures they're using the same words.

Core writes the dictionary. Instances read it. The field challenges it. The dictionary evolves. This is how language works: someone writes it down, everyone uses it, and when usage diverges enough from the written form, the dictionary updates. Core is just the first editor.

## Open questions

1. **Dictionary authority** — What if someone forks Core and publishes a competing dictionary? Is that healthy (dialect) or destructive (schism)?
2. **Dictionary and paid tier** — Do paid instances get dictionary updates faster? Or is the dictionary always free and simultaneous?
3. **Dictionary size** — At 50+ specs, the dictionary is substantial. Partial sync? Category-based sync? Or always full?
4. **Dictionary and templates** — When a Template spawns, does it inherit the Founder's dictionary version? Or does it sync its own?
5. **Dictionary deprecation** — When a spec is superseded, how long does the old version stay in the dictionary? Forever (for backward compat)?
6. **Human-readable dictionary** — Should the dictionary be browsable as documentation? herrmangroup.com/dictionary? Or is it code-only?
