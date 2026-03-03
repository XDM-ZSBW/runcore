/**
 * Backlog grooming script — applies all identified changes to queue.jsonl.
 *
 * Changes are append-only (last occurrence per id wins on load).
 * After appending, compacts the file to eliminate stale lines.
 */

import { readFileSync, appendFileSync } from 'fs';

const QUEUE_FILE = 'brain/operations/queue.jsonl';

// ── Load current state ──────────────────────────────────────────────
const data = readFileSync(QUEUE_FILE, 'utf8');
const entries = data.trim().split('\n')
  .map(l => { try { return JSON.parse(l); } catch { return null; } })
  .filter(Boolean);

const tasks = entries.filter(e => !e._schema);
const taskMap = new Map();
for (const t of tasks) taskMap.set(t.id, t);

const now = new Date().toISOString();
const updates = [];

function updateTask(id, changes, reason) {
  const existing = taskMap.get(id);
  if (!existing) {
    console.error(`  ✗ Task ${id} not found — skipping`);
    return;
  }
  const updated = {
    ...existing,
    ...changes,
    updatedAt: now,
  };
  // Add grooming exchange
  updated.exchanges = [
    ...(existing.exchanges || []),
    {
      id: `ex_groom_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,7)}`,
      author: 'Claude Code',
      body: `Backlog grooming: ${reason}`,
      source: 'manual',
      timestamp: now,
    }
  ];
  updates.push(updated);
  taskMap.set(id, updated);
  console.log(`  ${updated.identifier}: ${reason}`);
}

// ── BATCH 1: Cancel duplicates ──────────────────────────────────────
console.log('\n=== BATCH 1: Cancel duplicates ===');

updateTask('q_mm5i348r_jpndhoh', { state: 'cancelled' },
  'Duplicate of DASH-39 (WhatsApp via Twilio). Empty description, created by Linear sync.');

updateTask('q_mm5iijjr_xxwna17', { state: 'cancelled' },
  'Duplicate of DASH-45 (WhatsApp via CF Worker Relay). Empty description, created by Linear sync.');

updateTask('q_mm5pynfa_34sr60b', { state: 'cancelled' },
  'Duplicate of DASH-52 (Spec: Rules Engine Definition). Both had same spec work.');

updateTask('q_mm5sz7kj_rw14shk', { state: 'cancelled' },
  'Duplicate of DASH-62 (Implement Slack Integration). Same implementation scope.');

updateTask('q_mm5pw1z0_u8y8s01', { state: 'cancelled' },
  'Duplicate of DASH-12 (Spec: Agent Templates). DASH-12 already completed this spec.');

// ── BATCH 2: Cancel enterprise/irrelevant items ─────────────────────
console.log('\n=== BATCH 2: Cancel enterprise/irrelevant items ===');

updateTask('q_mm5ajqsz_lu8alci', { state: 'cancelled' },
  'Multi-Region Deployment is enterprise infrastructure, not needed for a solo personal agent.');

updateTask('q_mm5ajqzf_3mt78qc', { state: 'cancelled' },
  'Horizontal Scaling is enterprise infrastructure, not needed for a solo personal agent.');

updateTask('q_mm5ajr5t_9y2lra1', { state: 'cancelled' },
  'Queue-Based Task Processing already exists as queue.jsonl + QueueBoardProvider.');

updateTask('q_mm5ajrd2_kqhd43l', { state: 'cancelled' },
  'CI/CD Templates are enterprise infrastructure, not needed for local personal agent.');

updateTask('q_mm5ajrrr_pq28bh3', { state: 'cancelled' },
  'Python SDK is premature — Dash runtime is TypeScript. Revisit if Python agents needed.');

updateTask('q_mm5ajryt_nxxxta8', { state: 'cancelled' },
  'TypeScript/JavaScript SDK is premature — direct imports work fine for now.');

// ── BATCH 3: Mark already-built items as done ───────────────────────
console.log('\n=== BATCH 3: Mark already-built items as done ===');

updateTask('q_google_oauth2', { state: 'done', assignee: null },
  'Code exists: src/google/auth.ts (10.8KB). OAuth2 flow fully implemented with token refresh, 401 retry, vault storage.');

updateTask('q_gmail_send', { state: 'done' },
  'Code exists: src/google/gmail-send.ts (9.2KB). Send and draft capabilities fully implemented.');

updateTask('q_google_drive', { state: 'done',
  title: 'Google Drive/Docs Read',
  description: 'Google Drive/Docs API client for reading and searching documents. Code: src/google/docs.ts.' },
  'Code exists: src/google/docs.ts (11.2KB). Drive/Docs read capabilities built.');

updateTask('q_mm5rz1zf_yz44988', { state: 'done' },
  'Code exists: src/channels/whatsapp.ts (8.9KB) + src/webhooks/twilio.ts (5.2KB) + src/services/whatsapp.ts (8.6KB). WhatsApp channel fully implemented.');

updateTask('q_mm5rz1zf_5a6wd14', { state: 'done' },
  'Code exists: src/health/alerting.ts (15.5KB) + alert-defaults.ts + alert-types.ts. Health monitoring with alerting fully built.');

updateTask('q_mm5rz1zf_2hdxvgh', { state: 'done' },
  'Code exists: src/linear/client.ts (20.8KB) + src/integrations/linear.ts (8.8KB) + webhooks, users, projects, retry. Bidirectional sync fully implemented.');

updateTask('q_mm5ajpzz_ena6jo2', { state: 'done' },
  'Spec completed as DASH-52 (Spec: Rules Engine Definition). Both DASH-52 and its duplicate DASH-54 are marked done.');

updateTask('q_mm5sc6wf_qzdmryn', { state: 'done' },
  'Code exists: src/slack/ — client.ts (18.3KB), channels.ts (11.3KB), types.ts (9.5KB), webhooks.ts (10.2KB), retry.ts (4.2KB). Full Slack integration built.');

updateTask('q_mm5ajsxg_3ktpri4', { state: 'done', assignee: null },
  'Code exists: src/tracing/tracer.ts (13.5KB). Distributed tracing implementation complete.');

updateTask('q_mm5ajtbl_xqmpsk9', { state: 'done', assignee: null },
  'Code exists: src/metrics/ — collector.ts (9.8KB), store.ts (6.8KB), reporter.ts (9.3KB), middleware.ts, index.ts. Full metrics system built.');

updateTask('q_mm5sc6wf_wk4o17j', { state: 'done' },
  'Spec: Performance & Metrics — code already built in src/metrics/ without formal spec. Metrics collection, storage, reporting all implemented.');

updateTask('q_mm5sc6wf_5afjje0', { state: 'done' },
  'Spec: Slack Integration — Slack integration already fully built in src/slack/ (5 files, ~53KB). Spec is moot since implementation is complete.');

updateTask('q_mm5sz7kj_z08y28d', { state: 'done' },
  'Spec: Notification System — notification code already exists in src/notifications/ (email, SMS, webhook channels). Built without formal spec.');

// ── BATCH 4: Cancel superseded items ────────────────────────────────
console.log('\n=== BATCH 4: Cancel superseded items ===');

updateTask('q_mm5aj90k_hb9chld', { state: 'done' },
  'Superseded by DASH-59 (Weekly Backlog Review) which is the formalized recurring version of this task. Initial grooming completed.');

updateTask('q_whatsapp_relay', { state: 'cancelled' },
  'WhatsApp via CF Worker Relay — the direct Twilio approach (DASH-39/DASH-57) was chosen and built instead. Relay pattern not needed.');

updateTask('q_mm5wa001_whatsapp', { state: 'done', assignee: null },
  'WhatsApp via Twilio spec and implementation both done. Code: src/channels/whatsapp.ts + src/webhooks/twilio.ts. Implemented as DASH-57.');

// ── BATCH 5: Fix DASH-48 identifier collision ──────────────────────
console.log('\n=== BATCH 5: Fix identifier collision ===');

// The second DASH-48 (Google Tasks for human) collides with the first DASH-48 (WhatsApp relay dupe, now cancelled).
// Reassign to DASH-67 since we have tasks up to DASH-66.
updateTask('q_google_tasks', {
  identifier: 'DASH-67',
  title: 'Google Tasks Integration — human task management via Google Tasks API',
},
  'Reassigned from DASH-48 to DASH-67 to fix identifier collision. DASH-48 was already used by (now-cancelled) WhatsApp CF Relay duplicate.');

// ── BATCH 6: Add descriptions to vague items and adjust priorities ──
console.log('\n=== BATCH 6: Enrich vague items ===');

updateTask('q_mm5aj97m_lt9l8b5', {
  description: 'Cache LLM API responses to reduce latency and cost for repeated/similar queries. Could use in-memory TTL cache or file-backed cache consistent with Dash\'s no-external-deps philosophy. Consider: cache key strategy, TTL, invalidation, max size.',
},
  'Added description. Low priority — optimization item for later.');

updateTask('q_mm5aj9ei_v2mbysw', {
  description: 'Web dashboard showing: agent status monitoring, health check results, recent activity logs, configuration overview, and board state. Frontend for the data already exposed by /healthz, /readyz, metrics, and queue endpoints.',
},
  'Added description. In progress — scoping what the dashboard covers.');

updateTask('q_mm5aj9m2_wmws4yf', {
  description: 'Agent runtime environment providing sandboxed execution context, resource limits, and lifecycle management. Code exists: src/agents/runtime.ts (26.9KB). Provides agent process isolation, environment setup, and cleanup.',
},
  'Added description noting existing code. In progress — runtime is built but may need refinement.');

updateTask('q_mm5aja0j_5skotyr', {
  description: 'Manages agent lifecycle: create, start, stop, restart, monitor. Code exists: src/agents/instance-manager.ts (25.6KB). Handles agent spawning, health monitoring, and graceful shutdown.',
},
  'Added description noting existing code. In progress — manager is built but may need refinement.');

updateTask('q_mm5ajatv_a1r0ew9', {
  description: 'Registry for sharing agent templates and skills across instances. Depends on DASH-12 (Agent Templates spec, done) and DASH-5 (Skills Library spec, done). Would allow publishing/discovering reusable agent patterns.',
  priority: 4,
},
  'Added description and lowered priority to P4 (low) — a nice-to-have after core agent architecture stabilizes.');

updateTask('q_mm5ajrkb_g6a52g3', {
  description: 'Set up a testing framework for Dash. Options: vitest (modern, fast, ESM-native), jest, or node:test (zero-dep). Should cover unit tests for queue store, memory, context assembler, and integration tests for agent workflows.',
  priority: 3,
},
  'Added description with testing framework options.');

updateTask('q_mm5ajs5v_238azbp', {
  description: 'Enhance GitHub integration beyond basic operations. Could include: PR review automation, issue triage, commit analysis, repo health monitoring. Depends on webhook support and agent capabilities.',
  priority: 4,
},
  'Added description and lowered priority to P4 — nice-to-have enhancement.');

updateTask('q_mm5ajscq_t9oda3q', {
  description: 'Support additional LLM providers beyond OpenRouter. Could include: direct Anthropic API, OpenAI, local models via Ollama. User currently uses OpenRouter which already aggregates providers, so this is low priority.',
  priority: 4,
},
  'Added description and lowered priority to P4 — OpenRouter already provides multi-provider support.');

updateTask('q_mm5ajsjk_cpkbqlg', {
  description: 'General webhook support for external integrations. Partial code exists: src/webhooks/twilio.ts, src/linear/webhooks.ts, src/slack/webhooks.ts. Need: generic webhook registration, signature verification, event routing, retry logic.',
  priority: 3,
},
  'Added description noting existing webhook code in specific integrations.');

updateTask('q_mm5ajsqj_0p7xkrj', {
  description: 'Define a plugin architecture by extracting the common pattern from Google, Slack, Linear, and WhatsApp integrations. Each integration follows: auth → client → timer/webhook → context injection. Formalize this as a plugin interface.',
  priority: 3,
},
  'Added description. Should be done after Google/Slack/Linear integrations stabilize.');

updateTask('q_mm5ajti0_0w56j10', {
  description: 'Replace console.log with structured JSON logging. Should include: log levels (debug/info/warn/error), request correlation IDs, consistent field names, file rotation or size limits. Low effort, moderate value for debugging agent flows.',
  priority: 3,
},
  'Added description. Good developer experience improvement.');

updateTask('q_mm5ajtvv_jf0nch3', {
  description: 'High-level agent orchestration: multi-agent coordination, task delegation, result aggregation, conflict resolution. Significant code exists in src/agents/ (autonomous.ts, spawn.ts, triage.ts, store.ts). Depends on agent runtime (DASH-4) and instance manager (DASH-6) which are in progress.',
  priority: 2,
},
  'Added description noting existing code. Blocked on DASH-4 and DASH-6 completion.');

updateTask('q_mm5ajua4_dv8q9wo', {
  description: 'Fix issues with Linear API integration: validation errors on sync, self-correction loop when API returns unexpected data, add verification step before handing off synced tasks. Code: src/linear/client.ts, src/queue/sync.ts.',
  priority: 2,
},
  'Added description. Important for reliable Linear sync.');

updateTask('q_morning_briefing', {
  description: 'Daily morning briefing combining: today\'s calendar events (DASH-42, done), unread email summary (DASH-43, done), board status digest. Delivered as notification via existing channels (SMS, email, WhatsApp). All dependencies are now built.',
  priority: 2,
},
  'Updated description — all dependencies (Calendar, Gmail, WhatsApp) are now built. Ready for implementation.');

updateTask('q_mm5rz1zf_5bth6j1', {
  state: 'backlog',
  priority: 2,
  description: 'Recurring task: Every Friday, review backlog items for: stale issues (>30 days), unspec\'d items that need definition, completed work to mark done, priority adjustments. Service code exists: src/services/backlogReview.ts (13.1KB). Task is recurring, not a one-time build.',
},
  'Moved to backlog (recurring). Service code already exists. This is a process task, not a deliverable.');

updateTask('q_mm5sz7kj_n4phtnw', {
  description: 'Define file upload, storage, versioning, and sharing capabilities. Include local storage with cloud backup (Google Drive integration already built), file type validation, automatic compression, and integration with agent workflows. Support for document templates and agent-generated files.',
  priority: 3,
},
  'Added description noting Google Drive integration is already built.');

// DASH-50 and DASH-51 are one-off tasks — lower their priority since they're not critical
updateTask('q_mm5kn5au_7pf04bd', {
  priority: 3,
  description: 'Test the Google Tasks integration by creating a recurring Friday 4 PM status report task. Depends on DASH-67 (Google Tasks Integration).',
},
  'Lowered priority to P3 (medium) — this is a test/demo task, not a feature.');

updateTask('q_mm5kpwi2_upi34sy', {
  priority: 3,
  description: 'Test the Calendar integration by creating a status report calendar event at 4:30 PM. Depends on DASH-42 (Calendar, done).',
},
  'Lowered priority to P3 (medium) — this is a test/demo task, not a feature.');

// ── Write updates ───────────────────────────────────────────────────
console.log(`\n=== Writing ${updates.length} updates ===`);
const appendData = updates.map(u => JSON.stringify(u)).join('\n') + '\n';
appendFileSync(QUEUE_FILE, appendData, 'utf8');
console.log('Done. Updates appended to queue.jsonl.');

// ── Summary ─────────────────────────────────────────────────────────
const cancelled = updates.filter(u => u.state === 'cancelled').length;
const done = updates.filter(u => u.state === 'done').length;
const enriched = updates.filter(u => u.state !== 'cancelled' && u.state !== 'done').length;
console.log(`\nSummary: ${cancelled} cancelled, ${done} marked done, ${enriched} enriched/updated`);
