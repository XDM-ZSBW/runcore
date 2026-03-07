# Access Manifest Spec

> Defines the `.access/*.yaml` format for instance-level brain access partitioning.
> Established 2026-03-05. Companion to [Architecture Glossary](architecture-glossary.md).

---

## Location

```
brain/.access/
  dash.yaml
  wendy.yaml
  cora.yaml
  <custom-instance>.yaml
```

One manifest per instance. Filename matches the instance name (lowercase).

---

## Schema

```yaml
# brain/.access/<instance>.yaml
instance: <string>        # Instance name (must match filename)
role: <string>            # One of: personal, back-office, front-office, custom
description: <string>     # Human-readable role description

read:                     # Glob patterns — paths this instance can read
  - "operations/**"
  - "knowledge/**"

deny:                     # Glob patterns — explicit denials (override read)
  - "memory/experiences.jsonl"
  - "ops/audit.jsonl"

write:                    # Glob patterns — paths this instance can write
  - "operations/**"

guest_override:           # Optional — further restricts access for guest sessions
  read:
    - "knowledge/research/**"
    - "content/published/**"
  deny:
    - "operations/**"
  write: []               # Guests cannot write by default
```

All glob patterns are relative to the `brain/` directory.

---

## Field Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `instance` | string | yes | Instance name. Must match the YAML filename. |
| `role` | string | yes | Role identifier. Built-in roles: `personal`, `back-office`, `front-office`. Custom strings allowed. |
| `description` | string | no | Human-readable description of what this instance does. |
| `read` | string[] | yes | Glob patterns for readable brain paths. `["**/*"]` = full read access. |
| `deny` | string[] | no | Glob patterns that override `read`. Checked after `read` — if a path matches both `read` and `deny`, access is denied. |
| `write` | string[] | yes | Glob patterns for writable brain paths. `["**/*"]` = full write access. `[]` = read-only. |
| `guest_override` | object | no | Nested `read`/`deny`/`write` that replaces the instance's normal access when the session is a guest (non-owner). If absent, guests inherit the instance's normal access. |

---

## Evaluation Order

1. **`.locked` paths** — Checked first. If a path is in `.locked`, access is denied regardless of manifest. `.locked` is the absolute deny list (already enforced in Core).
2. **`deny` patterns** — If the requested path matches any `deny` glob, access is denied.
3. **`read`/`write` patterns** — If the requested path matches a `read` or `write` glob (depending on the operation), access is granted.
4. **Default deny** — If no pattern matches, access is denied.

For guest sessions, substitute the instance's `read`/`deny`/`write` with `guest_override` values before running the evaluation. `.locked` still applies first.

---

## Built-in Roles

### `personal` — Full access

```yaml
instance: dash
role: personal
description: "Personal agent — full brain access"
read: ["**/*"]
write: ["**/*"]
```

No `deny` needed — `.locked` paths are still enforced.

### `back-office` — Operations scope

```yaml
instance: wendy
role: back-office
description: "Back-office — operations, scheduling, financials"
read:
  - "operations/**"
  - "knowledge/**"
  - "content/drafts/**"
  - "calendar/**"
deny:
  - "memory/experiences.jsonl"
  - "identity/tone-of-voice.md"
  - "ops/audit.jsonl"
write:
  - "operations/**"
  - "calendar/**"
```

### `front-office` — Public scope

```yaml
instance: cora
role: front-office
description: "Front-office — client-facing, public knowledge only"
read:
  - "knowledge/research/**"
  - "content/published/**"
  - "identity/brand.md"
deny:
  - "operations/**"
  - "memory/**"
  - "content/drafts/**"
write:
  - "knowledge/bookmarks/**"
```

---

## Compatibility with `.locked`

The `.locked` file is Core's existing absolute-deny mechanism. Access manifests are layered on top:

| Check | Source | Overridable? |
|-------|--------|-------------|
| `.locked` | `brain/.locked` | No — always denies, regardless of manifest |
| `deny` | `brain/.access/<instance>.yaml` | No — instance-level deny is final |
| `read`/`write` | `brain/.access/<instance>.yaml` | N/A — these are grants, not overrides |

A path that appears in `.locked` cannot be accessed by any instance, even one with `read: ["**/*"]`. This preserves the existing security invariant.

---

## Enforcement Point

Access manifests are enforced at the **context assembler** (`src/context/assembler.ts`), not at the filesystem. The assembler receives the requesting instance's manifest and filters brain paths before building LLM context.

For write operations, enforcement happens at the **brain I/O layer** (`src/brain-io.ts` or equivalent) before any file write.

---

## Future Considerations

- **Entry-level filtering:** JSONL entries could carry a `visibility` field for finer-grained control within files. Not yet implemented — evaluate performance impact first.
- **Manifest inheritance:** Custom roles could extend built-in roles (e.g., `extends: back-office` with additional denies).
- **Runtime validation:** On instance boot, validate the manifest against the actual brain directory structure and warn about patterns that match nothing.
