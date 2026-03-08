# Metrics module

System performance data. HTTP latency, agent durations, error rates.

## Files (append-only)

- **metrics.jsonl** — One JSON object per line. Fields: `timestamp`, `source`, `metric`, `value`, `tags`.

## Rules

- Append only. Never rewrite or truncate.
- Metrics are collected automatically by server middleware and agent runtime.
- Use the Observatory page (`/observatory`) to view metrics visually.
