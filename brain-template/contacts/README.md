# Contacts module

Relationship graph of everyone and everything Core interacts with. Nodes are entities (humans, AI systems, organizations, services). Edges are relationships between them. Encrypted at rest because this is sensitive data.

## Files (append-only, encrypted)

- **entities.jsonl** — Entity records. Fields: `id` (ent_ + 8 hex), `type` (human | ai | organization | service), `name`, `aliases`, `channels` (array of {type, value}), `meta` (freeform type-specific data), `notes`, `tags`, `status` (active | archived).
- **edges.jsonl** — Relationship edges. Fields: `id` (edg_ + 8 hex), `from`/`to` (entity IDs), `type` (works_at | owns | introduced_by | collaborates_with | uses | built_by | reports_to), `label` (optional qualifier), `since` (ISO date or YYYY-MM), `notes`, `status` (active | archived).

## Privacy rules

- **Encrypt at rest.** All contact data is encrypted. Never store plaintext contact information.
- **Only record explicit knowledge.** Contact entries come from things Core was told about or directly interacted with — never scraped or inferred without basis.
- **This is Core's relational memory, not surveillance.** The graph represents Core's understanding of its world, not a dossier.
- **Archive, don't delete.** To remove an entity or edge, set `"status": "archived"` — never rewrite the file.

## Rules

- **Append only.** Add one new line per entry. Never overwrite or rewrite the file.
- To update an entity or edge, append a new line with the same `id` and updated fields. Last occurrence wins.
- Use `getRelationships(entityId)` to find all edges where an entity is `from` or `to`.
- Use `getGraph(entityId, depth)` for BFS traversal to explore relationship neighborhoods.
