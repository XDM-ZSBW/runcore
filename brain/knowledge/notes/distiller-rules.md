# Distiller Rules

> How Core files become templates. The membrane applied to itself.
> Identity out, tokens in. Fill at onboarding, resolve at runtime.

---

## Concept

The **distiller** strips identity from Core files to produce templates that any customer can hydrate. It's the membrane eating its own cooking — the same substitution model used for LLM traffic, applied to the brain's own configuration files.

A distilled file has no names, no personal details, no instance-specific values. Just structure with tokens. The core-agent fills the tokens during onboarding. The instance resolves them at runtime.

---

## Token Format

```
{{PROPERTY}}
```

Double curly braces. All caps. Descriptive name. Not the `<<CATEGORY_N>>` membrane format — these are **property tokens**, not entity addresses. They get filled once at creation, not substituted per-turn.

| Token | Filled with | Example |
|-------|------------|---------|
| `{{OWNER}}` | Vault owner's name | Bryant |
| `{{CHIEF_OF_STAFF}}` | Chief of staff instance name | Dash |
| `{{ADMIN}}` | Administration instance name | Wendy |
| `{{COMMERCIAL}}` | Commercial instance name | Cora |
| `{{LOSS_PREVENTION}}` | Loss prevention instance name | Marvin |
| `{{REPO_ROOT}}` | Instance repo path | E:/dash |
| `{{DELEGATE}}` | Emergency contact / surrogate | TBD |

---

## Distilled Templates

### vault.policy.template.yaml

```yaml
# Vault Policy — {{OWNER}}'s vault
# Classifies brain paths into access tiers.
# {{ADMIN}} (administration) generates these. {{LOSS_PREVENTION}} (loss prevention) enforces.
# Core provides the machinery.

owner: "{{OWNER}}"

tiers:
  open:
    - knowledge/research/**
    - content/published/**
    - identity/brand.md

  community:
    - operations/**
    - calendar/**
    - content/drafts/**
    - knowledge/notes/**
    - identity/principles.md
    - identity/tone-of-voice.md
    - identity/instances.yaml

  secured:
    - memory/experiences.jsonl
    - vault/**
    - identity/human.json
    - ops/audit.jsonl

default_tier: community
```

### instances.template.yaml

```yaml
# Instance Registry — {{OWNER}}'s agents

instances:
  "{{CHIEF_OF_STAFF}}":
    role: chief-of-staff
    department: all
    reports_to: "{{OWNER}}"
    description: "Chief of Staff agent — closest to the metal. Battle-tested. Reports back when the dictionary needs updating."
    access: "{{OWNER}}'s vault — full. Other vaults — none unless explicitly granted."
    interacts_with:
      - "{{OWNER}}"
    status: active

  "{{ADMIN}}":
    role: administration
    department: administration
    reports_to: "{{OWNER}}"
    description: "Administration department agent — scheduling, financials, back-office"
    access: partitioned
    interacts_with:
      - "{{OWNER}}"
    status: planned

  "{{COMMERCIAL}}":
    role: commercial
    department: commercial
    reports_to: "{{OWNER}}"
    description: "Commercial department agent — client-facing, public knowledge, content"
    access: partitioned
    template: true
    interacts_with:
      - external_clients
      - prospects
    status: planned

  "{{LOSS_PREVENTION}}":
    role: loss-prevention
    department: loss-prevention
    reports_to: "{{OWNER}}"
    description: "Loss prevention agent — watches the doors. Vault policy enforcement, anomaly detection, access auditing."
    access: partitioned
    interacts_with:
      - "{{OWNER}}"
      - "{{CHIEF_OF_STAFF}}"
    status: planned
```

---

## Distillation Rules

1. **Names are always tokens.** Any human name, instance name, or identity-specific value becomes a `{{TOKEN}}`.
2. **Structure stays.** Tiers, roles, departments, scaling rules, delegation TODOs — all preserved verbatim.
3. **Principles stay.** The dictionary is shared infrastructure. It doesn't get distilled.
4. **Paths stay.** Brain directory structure is Core's convention, not identity.
5. **Comments that reference specific people get tokenized.** "Bryant is CEO" → "{{OWNER}} is CEO".
6. **Comments that describe architecture stay verbatim.** "The one watching the doors can't also be the one opening them" is a principle, not identity.

---

## Hydration

During onboarding, the core-agent:
1. Asks the customer for values: name, agent names, preferences
2. Fills all `{{TOKENS}}` in the templates
3. Writes the hydrated files to the new instance's brain
4. Vault policy activates — the customer now has a vault

The distiller is reversible: given a hydrated file and a token map, you can produce the template again. Same membrane principle — bidirectional.

---

## Relationship to the Membrane

| Layer | Token format | Lifetime | Purpose |
|-------|-------------|----------|---------|
| **Distiller** | `{{PROPERTY}}` | Filled once at creation | Strip identity from templates |
| **Membrane** | `<<CATEGORY_N>>` | Substituted per-turn | Strip identity from LLM traffic |
| **Ledger** | `<<CATEGORY_N>>` | Immutable address | Stable entity reference |

The distiller is the membrane's sibling. Same principle (identity out, structure preserved), different scope (setup-time vs runtime).
