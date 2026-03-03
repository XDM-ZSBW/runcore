# Performance & Metrics Collection Specification

**Status:** Draft
**Date:** 2026-02-27
**Scope:** Extend the existing `src/metrics/` system with additional metric types, retention policies, dashboards, export capabilities, and coverage for uncaptured subsystems.

---

## 1. Current State

Dash already has a working metrics pipeline:

| Component | File | Role |
|-----------|------|------|
| `MetricsStore` | `src/metrics/store.ts` | JSONL persistence, query, summarize, rotate |
| Collector | `src/metrics/collector.ts` | 30s background collection of system/HTTP/agent/error metrics |
| Reporter | `src/metrics/reporter.ts` | Dashboard snapshots, alert threshold evaluation with cooldown |
| Middleware | `src/metrics/middleware.ts` | Hono middleware: request duration + status code |
| Types | `src/metrics/types.ts` | `MetricPoint`, `MetricSummary`, `AlertThreshold`, `DashboardSnapshot` |

**Metrics currently collected:**

```
system.cpu.percent          (%)        — process CPU
system.memory.heap_used     (bytes)    — V8 heap
system.memory.heap_total    (bytes)    — V8 heap total
system.memory.rss           (bytes)    — resident set size
system.memory.external       (bytes)    — C++ objects bound to JS
system.event_loop.drift     (ms)       — setTimeout(0) drift

http.request.count          (count)    — total requests per interval
http.request.error_count    (count)    — 4xx/5xx per interval
http.request.latency.*      (ms)       — avg, p50, p95, p99, max
http.request.status         (count)    — per status code (tag: status)

agent.spawn.count           (count)
agent.complete.count        (count)
agent.fail.count            (count)
agent.duration.*            (ms)       — avg, p95, max

error.total                 (count)
error.by_source             (count)    — per source (tag: source)
```

**Retention:** 10,000 points max, 24-hour TTL, rotation checked every ~30 min.

**Alerting:** 5 default thresholds (CPU, RSS, event loop drift, HTTP p95, error total). Cooldown per-metric per-severity. Max 50 recent alerts in memory.

---

## 2. Metric Types

Following OpenTelemetry semantic conventions, all metrics fall into three instrument types. The existing `MetricPoint` already supports all three via the `value` field — the distinction is semantic and drives how consumers interpret the data.

### 2.1 Counters (monotonically increasing)

Counters reset to 0 each collection interval (the collector flushes accumulators). Consumers compute rates by dividing `value` by the collection interval.

| Metric | Unit | Tags | Status |
|--------|------|------|--------|
| `http.request.count` | count | — | Exists |
| `http.request.error_count` | count | — | Exists |
| `http.request.status` | count | `status` | Exists |
| `agent.spawn.count` | count | — | Exists |
| `agent.complete.count` | count | — | Exists |
| `agent.fail.count` | count | — | Exists |
| `error.total` | count | — | Exists |
| `error.by_source` | count | `source` | Exists |
| `sidecar.request.count` | count | `sidecar` | **New** |
| `sidecar.error.count` | count | `sidecar` | **New** |
| `llm.request.count` | count | `provider`, `model` | **New** |
| `llm.token.input` | count | `provider`, `model` | **New** |
| `llm.token.output` | count | `provider`, `model` | **New** |
| `google.api.count` | count | `service` | **New** |
| `google.api.error_count` | count | `service` | **New** |
| `linear.sync.count` | count | — | **New** |
| `linear.sync.error_count` | count | — | **New** |
| `task.complete.count` | count | `result` | **New** |
| `learning.extract.count` | count | — | **New** |

### 2.2 Histograms (distributions)

Already stored as pre-aggregated percentiles (avg, p50, p95, p99, max). This approach avoids storing raw observations and is compatible with the existing store.

| Metric | Unit | Tags | Status |
|--------|------|------|--------|
| `http.request.latency.*` | ms | — | Exists |
| `agent.duration.*` | ms | — | Exists |
| `sidecar.request.duration.*` | ms | `sidecar` | **New** |
| `llm.request.duration.*` | ms | `provider`, `model` | **New** |
| `llm.time_to_first_token.*` | ms | `provider`, `model` | **New** |
| `google.api.duration.*` | ms | `service` | **New** |
| `linear.sync.duration.*` | ms | — | **New** |
| `learning.extract.duration.*` | ms | — | **New** |
| `context.assembly.duration.*` | ms | — | **New** |

`*` = avg, p50, p95, p99, max (same pattern as existing HTTP latency metrics).

### 2.3 Gauges (point-in-time snapshots)

Recorded once per collection cycle. Value represents the instantaneous reading.

| Metric | Unit | Tags | Status |
|--------|------|------|--------|
| `system.cpu.percent` | % | — | Exists |
| `system.memory.heap_used` | bytes | — | Exists |
| `system.memory.heap_total` | bytes | — | Exists |
| `system.memory.rss` | bytes | — | Exists |
| `system.memory.external` | bytes | — | Exists |
| `system.event_loop.drift` | ms | — | Exists |
| `agent.active.count` | count | — | **New** |
| `agent.queued.count` | count | — | **New** |
| `agent.pool.utilization` | % | — | **New** |
| `sidecar.active` | count | `sidecar` | **New** |
| `memory.store.size` | count | `store` | **New** |
| `metrics.store.points` | count | — | **New** |
| `queue.depth` | count | — | **New** |
| `session.active.count` | count | — | **New** |

---

## 3. Storage

### 3.1 Evaluation: JSONL (current) vs time-series DB

| Criterion | JSONL (current) | Time-series DB (e.g. SQLite + extension, InfluxDB) |
|-----------|-----------------|------------------------------------------------------|
| **Setup complexity** | Zero — files only | Requires binary, schema, migrations |
| **Dependencies** | None (fs only) | New runtime dependency |
| **Query performance at 10K points** | ~5ms (in-memory cache) | <1ms (indexed) |
| **Query performance at 1M points** | Degrades — full scan on load | Constant — indexed |
| **Aggregation** | Manual (JS sort + percentile) | Built-in (SQL / Flux) |
| **Downsampling** | Manual rotation | Built-in retention policies |
| **Disk usage** | ~150 bytes/point | ~40 bytes/point (compressed) |
| **Operational cost** | None | Backup, upgrades, monitoring |
| **Portability** | Copy files | Export/import tooling |
| **Fits Dash philosophy** | Yes — file-based, no external deps | No — adds infrastructure |

**Decision: Keep JSONL as primary store.** Introduce a tiered aggregation layer (section 7) to extend retention without growing file size. A future migration to SQLite is viable if query volume or retention requirements exceed JSONL's capabilities — the `MetricsStore` interface already abstracts storage.

### 3.2 Storage architecture

```
brain/metrics/
  metrics.jsonl          ← raw points (current, ≤24 hours)
  hourly.jsonl           ← hourly aggregates (new, ≤30 days)
  daily.jsonl            ← daily aggregates (new, ≤365 days)
```

Each aggregation file uses the existing `MetricSummary` schema (count, sum, min, max, avg, p50, p95, p99) so query and reporting code is reused.

---

## 4. Specific Metrics — Detailed Definitions

### 4.1 Agent execution

```typescript
// On spawn (src/agents/spawn.ts — already instrumented)
recordAgentSpawn();

// On completion (src/agents/spawn.ts — already instrumented)
recordAgentCompletion(durationMs, success);

// New: gauge readings from AgentPool / AgentInstanceManager
// Added to collector.ts collect() function
agent.active.count   = pool.activeCount()
agent.queued.count   = pool.queuedCount()
agent.pool.utilization = (active / maxConcurrency) * 100
```

### 4.2 API response latency

Already captured by `metricsMiddleware()` attached to `/api/*`. To add per-route granularity:

```typescript
// Enhanced middleware (optional, tag-based)
recordHttp(durationMs, statusCode, route);
// → stores with tags: { status: "200", route: "/api/chat" }
```

**Recommendation:** Per-route tagging adds cardinality. Start with the current aggregated approach. Add per-route tags only for the top 10 routes by volume if latency debugging requires it.

### 4.3 Memory usage

Already captured: `system.memory.heap_used`, `heap_total`, `rss`, `external`.

**New additions to `collect()`:**

```typescript
// V8 heap statistics (more granular)
import v8 from "node:v8";
const heapStats = v8.getHeapStatistics();
points.push(
  { name: "system.memory.heap_size_limit", value: heapStats.heap_size_limit, unit: "bytes" },
  { name: "system.memory.used_heap_size",  value: heapStats.used_heap_size,  unit: "bytes" },
);

// Memory store sizes (brain file metrics)
const storeNames = ["experiences", "semantic", "procedural"];
for (const store of storeNames) {
  points.push({
    name: "memory.store.size",
    value: lineCount,
    unit: "count",
    tags: { store },
  });
}
```

### 4.4 CPU utilization

Already captured: `system.cpu.percent` via `process.cpuUsage()` delta.

The current implementation measures Node.js process CPU only. For system-wide CPU on Windows, use `os.cpus()`:

```typescript
import os from "node:os";

// Aggregate system CPU (all cores)
const cpus = os.cpus();
const totalIdle = cpus.reduce((sum, cpu) => sum + cpu.times.idle, 0);
const totalTick = cpus.reduce((sum, cpu) =>
  sum + cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq, 0);

points.push({
  name: "system.cpu.system_percent",
  value: 100 - (totalIdle / totalTick * 100),
  unit: "%",
});
```

### 4.5 Task completion rates

```typescript
// New recording function in collector.ts
export function recordTaskCompletion(result: "success" | "failure" | "cancelled"): void {
  taskCompletions.push(result);
}

// Flushed each cycle as:
// task.complete.count  tags: { result: "success" }
// task.complete.count  tags: { result: "failure" }
```

### 4.6 Error rates

Already captured: `error.total`, `error.by_source`. The `recordError(source)` function is called from agent spawn failures and can be called from any catch block.

**New sources to instrument:**

| Source | Call site |
|--------|----------|
| `"llm"` | `src/llm/openrouter.ts`, `src/llm/ollama.ts` — on stream/fetch errors |
| `"google"` | `src/google/*.ts` — on API errors |
| `"linear"` | `src/linear/client.ts` — on sync failures |
| `"sidecar"` | `src/search/client.ts`, `src/tts/client.ts`, `src/stt/client.ts` — on sidecar errors |
| `"vault"` | `src/vault/store.ts` — on decrypt/read failures |

### 4.7 LLM-specific metrics

```typescript
// New recording function
export function recordLlmRequest(opts: {
  provider: "openrouter" | "ollama";
  model: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  ttftMs?: number; // time to first token
  success: boolean;
}): void;

// Flushed as:
// llm.request.count           tags: { provider, model }
// llm.request.duration.*      tags: { provider, model }
// llm.token.input             tags: { provider, model }
// llm.token.output            tags: { provider, model }
// llm.time_to_first_token.*   tags: { provider, model }   (if streaming)
```

### 4.8 Sidecar metrics

```typescript
// New recording function
export function recordSidecarRequest(sidecar: "search" | "tts" | "stt" | "avatar", durationMs: number, success: boolean): void;

// Flushed as:
// sidecar.request.count       tags: { sidecar }
// sidecar.error.count         tags: { sidecar }
// sidecar.request.duration.*  tags: { sidecar }
```

---

## 5. Dashboard Requirements

### 5.1 Existing dashboard

`GET /api/metrics/dashboard` returns a `DashboardSnapshot` with:
- System gauges (CPU, memory, event loop)
- HTTP summary (total requests, error rate, latency)
- Agent summary (spawned, completed, failed, avg duration)
- Recent alerts (last 10)

### 5.2 Extended dashboard sections

The `DashboardSnapshot` type should be extended with optional sections. Each section is populated only when data exists (graceful degradation).

```typescript
interface DashboardSnapshot {
  // ... existing fields ...

  /** LLM usage — only present if llm.request.count data exists. */
  llm?: {
    totalRequests: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    avgDurationMs: number;
    avgTtftMs: number;
    errorRate: number;
    byModel: Array<{
      model: string;
      provider: string;
      requests: number;
      tokens: number;
      avgDurationMs: number;
    }>;
  };

  /** Sidecar health — only present if sidecar data exists. */
  sidecars?: {
    [name: string]: {
      available: boolean;
      requests: number;
      errors: number;
      avgDurationMs: number;
    };
  };

  /** Google integration stats. */
  google?: {
    totalApiCalls: number;
    errorRate: number;
    avgDurationMs: number;
    byService: Record<string, { calls: number; errors: number; avgMs: number }>;
  };

  /** Task / queue metrics. */
  tasks?: {
    queueDepth: number;
    completedTotal: number;
    failedTotal: number;
    completionRate: number;
  };
}
```

### 5.3 Visualization requirements

The dashboard API serves JSON; the frontend (`public/`) renders it. Required visualizations:

| Panel | Type | Data source |
|-------|------|-------------|
| System health overview | Status cards (green/yellow/red) | Health check results |
| CPU over time | Sparkline | `system.cpu.percent` last 1h |
| Memory over time | Stacked area | `heap_used`, `rss` last 1h |
| HTTP latency | Line chart (p50, p95, p99) | `http.request.latency.*` last 1h |
| HTTP throughput | Bar chart | `http.request.count` last 1h |
| Error rate | Line chart + threshold line | `error.total` last 1h |
| Agent activity | Stacked bar | `agent.spawn/complete/fail` last 1h |
| LLM token usage | Counter + trend | `llm.token.*` last 24h |
| Active alerts | Alert list | `recentAlerts` |

**API endpoint for time-series charts:**

The existing `GET /api/metrics?name=X&since=ISO&limit=N` returns raw points. For charts, add:

```
GET /api/metrics/series?name=X&since=ISO&until=ISO&intervalMs=N
```

Returns points bucketed by interval (useful for rendering charts at consistent resolution without client-side aggregation).

---

## 6. Alerting Thresholds & Escalation

### 6.1 Existing thresholds

| Metric | Warn | Critical | Window | Min Samples |
|--------|------|----------|--------|-------------|
| `system.cpu.percent` | >80% | >95% | 2 min | 3 |
| `system.memory.rss` | >512MB | >1GB | 1 min | 2 |
| `system.event_loop.drift` | >100ms | >500ms | 2 min | 3 |
| `http.request.latency.p95` | >2s | >5s | 2 min | 5 |
| `error.total` | >10 | >50 | 5 min | 1 |

### 6.2 New thresholds

| Metric | Warn | Critical | Window | Min Samples | Rationale |
|--------|------|----------|--------|-------------|-----------|
| `agent.pool.utilization` | >80% | >95% | 2 min | 3 | Prevent agent starvation |
| `agent.fail.count` | >3 | >10 | 5 min | 1 | Detect broken agent configs |
| `llm.request.duration.p95` | >10s | >30s | 2 min | 3 | LLM provider slowdowns |
| `sidecar.error.count` | >5 | >15 | 5 min | 1 | Sidecar instability |
| `queue.depth` | >50 | >200 | 1 min | 2 | Queue buildup |
| `google.api.error_count` | >5 | >20 | 5 min | 1 | API quota / auth issues |
| `metrics.store.points` | >8000 | >9500 | 1 min | 1 | Store nearing rotation limit |
| `system.memory.heap_used` | >70% of heap_size_limit | >90% | 1 min | 2 | Heap pressure |

### 6.3 Escalation policy

```
Level 1 — Warning (severity: "warn")
  → Log to activity log (existing behavior)
  → Push to in-memory recent alerts (existing behavior)
  → If NotificationDispatcher configured:
      → Send to configured channels (webhook, Slack)

Level 2 — Critical (severity: "crit")
  → All Level 1 actions
  → If SMS channel configured: send Twilio SMS to owner
  → If RecoveryManager registered for the check: attempt auto-recovery
  → Set 5-minute re-evaluation cooldown (existing behavior)

Level 3 — Sustained critical (same alert fires 3+ times within 15 min)
  → All Level 2 actions
  → Log "sustained critical" to experiences.jsonl for long-term memory
  → Reduce cooldown to 2 minutes for rapid feedback during incident
```

**Implementation note:** Level 3 requires tracking fire counts per alert key. Add a `Map<string, { count: number; firstFired: number }>` to the reporter module.

---

## 7. Data Retention Policies

### 7.1 Tiered retention

| Tier | Granularity | Max age | Max records | File |
|------|-------------|---------|-------------|------|
| Raw | 30s intervals | 24 hours | 10,000 | `metrics.jsonl` |
| Hourly | 1 hour aggregates | 30 days | ~720 | `hourly.jsonl` |
| Daily | 1 day aggregates | 365 days | ~365 | `daily.jsonl` |

### 7.2 Aggregation process

Add a new `Aggregator` class (or function) invoked during rotation:

```typescript
// Called by rotate() when dropping points older than 24h
async function aggregateToHourly(points: MetricPoint[]): Promise<void> {
  // Group points by metric name + hour
  // For each group, compute MetricSummary (count, sum, min, max, avg, p50, p95, p99)
  // Append to hourly.jsonl
}

// Called by a daily timer (or hourly rotation)
async function aggregateToDaily(hourlySummaries: MetricSummary[]): Promise<void> {
  // Group hourly summaries by metric name + day
  // Merge summaries (weighted average for avg, min of mins, max of maxes, etc.)
  // Append to daily.jsonl
}
```

### 7.3 Rotation schedule

| Action | Trigger | Current behavior |
|--------|---------|-----------------|
| Raw rotation | Every 60 collect cycles (~30 min) | Drop points >24h or >10K — **extend to aggregate before dropping** |
| Hourly rotation | Daily at midnight (new timer) | Drop summaries >30 days |
| Daily rotation | Monthly on 1st (new timer) | Drop summaries >365 days |

---

## 8. Metric Naming Conventions

Follow [OpenTelemetry Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/) where applicable.

### 8.1 Rules

1. **Dot-separated hierarchy:** `{namespace}.{object}.{measurement}`
2. **Lowercase, no camelCase:** `http.request.latency.p95` not `httpRequestLatencyP95`
3. **Units in metadata, not names:** `system.memory.rss` with `unit: "bytes"`, not `system.memory.rss_bytes`
4. **Use tags for dimensions:** `http.request.status` with `tags: { status: "200" }`, not `http.request.status.200`
5. **Counter names describe the thing counted:** `agent.spawn.count`, not `agent.spawns`
6. **Histogram suffixes:** `.avg`, `.p50`, `.p95`, `.p99`, `.max` (already established)
7. **Gauge names describe the measured thing:** `agent.active.count`, `queue.depth`

### 8.2 Namespace registry

| Namespace | Scope |
|-----------|-------|
| `system.*` | Process-level: CPU, memory, event loop, disk |
| `http.*` | HTTP server: requests, latency, status codes |
| `agent.*` | Agent lifecycle: spawn, complete, fail, duration, pool |
| `error.*` | Error tracking: total, by source |
| `llm.*` | LLM providers: requests, tokens, latency, TTFT |
| `sidecar.*` | Sidecar processes: search, TTS, STT, avatar |
| `google.*` | Google API: calendar, gmail, tasks, docs |
| `linear.*` | Linear integration: sync, webhooks |
| `queue.*` | Task queue: depth, processing |
| `task.*` | Task outcomes: completion, cancellation |
| `learning.*` | Memory extraction pipeline |
| `context.*` | Context assembly performance |
| `metrics.*` | Self-referential: store size, collection duration |
| `memory.*` | Brain memory stores: line counts |

---

## 9. Integration with Existing Logging

### 9.1 Current logging

- `logActivity()` — in-memory append-only log, echoes to `console.log` with `[source]` prefix.
- `console.log/error` — direct output from various modules.

### 9.2 Integration approach

Logging and metrics serve different purposes and should remain separate systems:

| Concern | System | When to use |
|---------|--------|-------------|
| What happened | Activity log | Human-readable events: "Agent spawned", "Search query executed" |
| How much / how fast | Metrics | Numeric measurements: latency, count, utilization |
| Something broke | Both | `recordError(source)` for metric + `logActivity()` for narrative |

**Bridge points:**

1. **Metrics → Activity log:** Alert firings already call `logActivity()` (reporter.ts:143). Extend to log rotation events and collection errors.

2. **Activity log → Metrics:** Add a counter `activity.log.count` with tag `source` to track event volume per source. Instrument in `logActivity()`:

```typescript
// In src/activity/log.ts
import { recordActivityEvent } from "../metrics/collector.js";

export function logActivity(opts: { ... }): ActivityEntry {
  // ... existing logic ...
  recordActivityEvent(opts.source);
  return entry;
}
```

3. **Structured logging (future):** If a structured logger (e.g., pino) is adopted, metrics collection points become natural log-enrichment sites — attach `traceId`, `duration`, `status` to log lines.

---

## 10. Performance Impact of Metrics Collection

### 10.1 Current overhead

| Operation | Cost | Frequency |
|-----------|------|-----------|
| `recordHttp()` | ~0.001ms (push to array + increment counter) | Per HTTP request |
| `recordAgentSpawn/Completion()` | ~0.001ms (increment counter) | Per agent lifecycle event |
| `recordError()` | ~0.001ms (increment + map set) | Per error |
| `collect()` | ~2-5ms (memory snapshot + event loop probe + file append) | Every 30s |
| `store.recordBatch()` | ~1-3ms (JSON.stringify + appendFile) | Every 30s |
| `store.query()` (first call) | ~5-50ms (readFile + JSON.parse per line) | On demand |
| `store.query()` (cached) | ~1-5ms (array filter) | On demand |
| `buildDashboard()` | ~10-30ms (multiple queries) | On demand |
| `evaluateAlerts()` | ~5-15ms (queries per threshold) | Every 30s (AlertManager) |

### 10.2 Budget for new metrics

Adding the new metrics defined in this spec increases:
- **Recording calls:** ~8 new recording functions, each <0.01ms. Negligible.
- **Collection points per cycle:** From ~15 to ~40 points. `recordBatch()` cost increases proportionally: ~3-6ms.
- **Disk writes:** From ~2KB/cycle to ~5KB/cycle. At 30s intervals = ~14MB/day raw (before rotation).
- **Memory:** Cache grows from ~10K to ~20K points before rotation triggers. ~3MB additional heap.

### 10.3 Safeguards

1. **Collection timeout:** If `collect()` takes >5s (shouldn't happen), log a warning and skip the cycle. Prevents metrics from becoming a bottleneck.

```typescript
const COLLECT_TIMEOUT_MS = 5_000;

async function collect(): Promise<void> {
  const start = performance.now();
  // ... existing collection logic ...
  const elapsed = performance.now() - start;
  if (elapsed > COLLECT_TIMEOUT_MS) {
    console.warn(`[metrics] Collection took ${Math.round(elapsed)}ms — exceeds ${COLLECT_TIMEOUT_MS}ms budget`);
  }
  // Self-metric
  points.push({
    timestamp: now,
    name: "metrics.collect.duration",
    value: Math.round(elapsed),
    unit: "ms",
  });
}
```

2. **Backpressure:** If `appendFile` fails (disk full, permissions), the collector logs the error and continues. Data for that cycle is lost but the system keeps running (existing behavior in collector.ts:166).

3. **Cache size limit:** If cache exceeds 20K points, force rotation on next cycle regardless of the normal rotation schedule.

4. **Tag cardinality control:** Limit unique tag combinations per metric to 100. High-cardinality tags (e.g., per-request-id) must never be used as metric tags — those belong in traces or logs.

---

## 11. Export Capabilities

### 11.1 Prometheus-compatible endpoint

Expose `GET /metrics` (not under `/api/` — follows Prometheus convention) returning metrics in Prometheus exposition format:

```
# HELP dash_system_cpu_percent Process CPU utilization
# TYPE dash_system_cpu_percent gauge
dash_system_cpu_percent 12.5

# HELP dash_http_request_count_total HTTP requests since last collection
# TYPE dash_http_request_count_total counter
dash_http_request_count_total 42

# HELP dash_http_request_duration_milliseconds HTTP request latency
# TYPE dash_http_request_duration_milliseconds summary
dash_http_request_duration_milliseconds{quantile="0.5"} 23
dash_http_request_duration_milliseconds{quantile="0.95"} 156
dash_http_request_duration_milliseconds{quantile="0.99"} 892
dash_http_request_duration_milliseconds_count 42
dash_http_request_duration_milliseconds_sum 1847

# HELP dash_agent_active_count Currently active agents
# TYPE dash_agent_active_count gauge
dash_agent_active_count 3
```

**Naming translation:** `system.cpu.percent` → `dash_system_cpu_percent` (dots to underscores, `dash_` prefix to avoid collisions).

### 11.2 JSON export

```
GET /api/metrics/export?since=ISO&until=ISO&format=json
```

Returns all raw points in the time range as a JSON array. Useful for one-off analysis or piping into external tools.

### 11.3 CSV export

```
GET /api/metrics/export?since=ISO&until=ISO&format=csv
```

Returns:
```csv
timestamp,name,value,unit,tags
2026-02-27T10:00:00.000Z,system.cpu.percent,12.5,%,
2026-02-27T10:00:00.000Z,http.request.count,42,count,
```

### 11.4 OpenTelemetry OTLP push (future)

If Dash is deployed alongside an OTLP collector (e.g., Grafana Alloy, OpenTelemetry Collector), add an optional OTLP/HTTP exporter:

```typescript
// src/metrics/exporters/otlp.ts
export async function pushToOtlp(endpoint: string, points: MetricPoint[]): Promise<void>;
```

Configured via `brain/settings.json`:
```json
{
  "metrics": {
    "otlp": {
      "enabled": false,
      "endpoint": "http://localhost:4318/v1/metrics",
      "intervalMs": 60000
    }
  }
}
```

**Not in initial scope.** Build only when there is a concrete deployment requiring it.

---

## 12. Implementation Architecture

### 12.1 Module structure (extended)

```
src/metrics/
  types.ts              ← existing: MetricPoint, MetricSummary, etc.
  store.ts              ← existing: MetricsStore (JSONL persistence)
  collector.ts          ← existing: background collection + recording API
  reporter.ts           ← existing: dashboard + alert evaluation
  middleware.ts          ← existing: Hono HTTP middleware
  index.ts              ← existing: public API re-exports
  aggregator.ts          ← NEW: hourly/daily aggregation logic
  prometheus.ts          ← NEW: Prometheus exposition format exporter
  series.ts              ← NEW: time-bucketed series query for charts
```

### 12.2 Collection intervals

| Metric category | Interval | Rationale |
|----------------|----------|-----------|
| System gauges (CPU, memory, event loop) | 30s | Current — good balance of resolution vs overhead |
| HTTP counters + histograms | 30s | Current — flushed from in-memory accumulators |
| Agent counters + histograms | 30s | Current — flushed from in-memory accumulators |
| Error counters | 30s | Current |
| LLM counters + histograms | 30s | Match existing pattern |
| Sidecar counters + histograms | 30s | Match existing pattern |
| Google/Linear API counters | 30s | Match existing pattern |
| Queue/pool gauges | 30s | Match existing pattern |
| Memory store sizes | 300s (5 min) | Low-change data, avoid unnecessary disk reads |
| Self-metrics (store size, collect duration) | 30s | Detect collection overhead |

### 12.3 Integration points in server.ts

```typescript
// Existing (no changes needed)
app.use("/api/*", metricsMiddleware());          // line ~418
startCollector(metricsStore);                     // line ~3593
const metricsStore = new MetricsStore(BRAIN_DIR); // line ~204

// New: Prometheus endpoint
app.get("/metrics", async (c) => {
  const snapshot = await buildDashboard(metricsStore);
  const latest = await metricsStore.query({ limit: 100 });
  return c.text(toPrometheusFormat(snapshot, latest));
});

// New: time-series endpoint
app.get("/api/metrics/series", async (c) => {
  // Bucket raw points by interval for chart rendering
});

// New: export endpoints
app.get("/api/metrics/export", async (c) => {
  // JSON or CSV export based on format param
});
```

### 12.4 New recording hooks

Instrumentation calls to add in existing modules:

| File | Hook | Records |
|------|------|---------|
| `src/llm/openrouter.ts` | `recordLlmRequest(...)` after stream completes | LLM duration, tokens, TTFT |
| `src/llm/ollama.ts` | `recordLlmRequest(...)` after stream completes | LLM duration, tokens, TTFT |
| `src/search/client.ts` | `recordSidecarRequest("search", ...)` | Search latency |
| `src/tts/client.ts` | `recordSidecarRequest("tts", ...)` | TTS latency |
| `src/stt/client.ts` | `recordSidecarRequest("stt", ...)` | STT latency |
| `src/avatar/client.ts` | `recordSidecarRequest("avatar", ...)` | Avatar generation latency |
| `src/google/calendar.ts` | `recordGoogleApi("calendar", ...)` | Calendar API latency |
| `src/google/gmail.ts` | `recordGoogleApi("gmail", ...)` | Gmail API latency |
| `src/google/tasks.ts` | `recordGoogleApi("tasks", ...)` | Tasks API latency |
| `src/google/docs.ts` | `recordGoogleApi("docs", ...)` | Docs API latency |
| `src/linear/client.ts` | `recordLinearSync(...)` | Sync duration |
| `src/context/assembler.ts` | `recordContextAssembly(...)` | Assembly duration |
| `src/learning/extractor.ts` | `recordLearningExtract(...)` | Extraction duration |

### 12.5 Schema for new JSONL files

**hourly.jsonl:**
```json
{"_schema": "metrics_hourly", "_version": "1.0", "_description": "Hourly aggregated metrics"}
{"name": "system.cpu.percent", "hour": "2026-02-27T10:00:00.000Z", "count": 120, "sum": 1440, "min": 5.2, "max": 28.7, "avg": 12.0, "p50": 11.5, "p95": 24.3, "p99": 27.1, "unit": "%"}
```

**daily.jsonl:**
```json
{"_schema": "metrics_daily", "_version": "1.0", "_description": "Daily aggregated metrics"}
{"name": "system.cpu.percent", "day": "2026-02-27", "count": 2880, "sum": 34560, "min": 2.1, "max": 95.3, "avg": 12.0, "p50": 11.5, "p95": 24.3, "p99": 27.1, "unit": "%"}
```

---

## 13. Implementation Priority

| Phase | Scope | Effort |
|-------|-------|--------|
| **Phase 1** | LLM metrics (`recordLlmRequest`), sidecar metrics (`recordSidecarRequest`), self-metrics (`metrics.collect.duration`, `metrics.store.points`) | Small — add recording functions to collector, instrument ~6 files |
| **Phase 2** | Agent pool gauges, queue depth, Google/Linear API metrics | Small — add gauge readings to `collect()`, instrument ~6 files |
| **Phase 3** | Tiered aggregation (hourly.jsonl, daily.jsonl), retention rotation timers | Medium — new `aggregator.ts`, extend `rotate()` |
| **Phase 4** | Prometheus export endpoint, JSON/CSV export | Medium — new `prometheus.ts`, new routes |
| **Phase 5** | Extended dashboard snapshot, time-series bucketed API | Medium — extend `DashboardSnapshot`, new `series.ts` |
| **Phase 6** | New alert thresholds, Level 3 escalation logic | Small — config changes, fire-count tracking |

Phases 1-2 deliver the most value with the least effort. Phase 3 unlocks long-term trending. Phases 4-6 are driven by operational needs.

---

## Appendix A: Metric Point Schema Reference

```typescript
interface MetricPoint {
  timestamp: string;       // ISO 8601
  name: string;            // dot-separated, lowercase
  value: number;           // numeric measurement
  unit?: string;           // "ms" | "bytes" | "%" | "count"
  tags?: Record<string, string>; // dimensional labels
}
```

## Appendix B: Collection Architecture Diagram

```
                    ┌──────────────────────────┐
                    │     External Systems      │
                    │  (LLM, Google, Linear)    │
                    └──────────┬───────────────┘
                               │ recordLlm / recordGoogle / ...
                               ▼
┌──────────┐  recordHttp   ┌──────────────────┐  30s timer   ┌──────────────┐
│   Hono   │──────────────▶│    Collector      │─────────────▶│ MetricsStore │
│ Middleware│               │  (in-memory       │  recordBatch │  (JSONL)     │
└──────────┘               │   accumulators)   │              └──────┬───────┘
                            └──────────────────┘                     │
                               ▲                                     │ query / summarize
          recordAgent*         │                                     ▼
┌──────────┐  recordError  ┌──────────────────┐              ┌──────────────┐
│  Agents  │──────────────▶│                  │              │   Reporter   │
│  spawn.ts│               │  Activity Log    │◀─ alert log ─│  (dashboard, │
└──────────┘               │  (in-memory)     │              │   alerts)    │
                            └──────────────────┘              └──────┬───────┘
                                                                     │
                                                                     ▼
                                                     ┌───────────────────────────┐
                                                     │     HTTP API Endpoints     │
                                                     │  /api/metrics/dashboard    │
                                                     │  /api/metrics/series       │
                                                     │  /api/metrics/export       │
                                                     │  /metrics (Prometheus)     │
                                                     └───────────────────────────┘
```
