/**
 * Trace Correlation Engine — background service that watches the activity stream,
 * builds trace chains, and uses the LLM to discover patterns and insights.
 *
 * Follows the established service pattern (morningBriefing.ts / backlogReview.ts):
 * module-level state, idempotent start/stop, timer-driven.
 */

import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getInstanceName } from "../instance.js";
import { getActivities, getActivitiesByTraceIds, logActivity } from "../activity/log.js";
import type { ActivityEntry } from "../activity/log.js";
import { completeChat } from "../llm/complete.js";
import { resolveProvider, resolveUtilityModel } from "../settings.js";
import { createLogger } from "../utils/logger.js";
import { getBoardProvider } from "../board/provider.js";
import { filterRoutine } from "./routine-patterns.js";
import { recordRoutineFiltered, recordResolvedFiltered, recordAnalysisThroughput } from "../metrics/firewall-metrics.js";
import { readBrainLines, appendBrainLine, writeBrainLines, ensureBrainJsonl } from "../lib/brain-io.js";
import { emitCdt } from "../pulse/activation-event.js";

const log = createLogger("trace-insights");

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TraceChain {
  rootTraceId: string;
  linkType: "backref" | "temporal-cluster";
  entries: ActivityEntry[];
  sources: string[];
  spanMs: number;
}

export interface TraceInsight {
  id: string;              // "ins_" + 8 hex
  discoveredAt: string;
  category: "pattern" | "anomaly" | "correlation" | "bottleneck";
  title: string;
  description: string;
  relatedTraceIds: string[];
  confidence: "high" | "medium" | "low";
}

export interface InsightRunSummary {
  ranAt: string;
  chainsAnalyzed: number;
  entriesAnalyzed: number;
  newInsights: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const ANALYSIS_INTERVAL_MS = 10 * 60 * 1000;  // 10 min
const FIRST_RUN_DELAY_MS = 2 * 60 * 1000;     // 2 min (let activity accumulate)
const MAX_INSIGHTS = 50;                        // FIFO eviction
const CLUSTER_WINDOW_MS = 5 * 60 * 1000;      // 5 min temporal window
const MIN_CLUSTER_SIZE = 2;
const MAX_ENTRIES_PER_ANALYSIS = 100;

// ─── Escalation config ──────────────────────────────────────────────────────

/** Categories eligible for auto-escalation to the board. */
const ESCALATION_CATEGORIES: TraceInsight["category"][] = ["bottleneck", "anomaly"];

/** Only escalate high-confidence insights. */
const ESCALATION_MIN_CONFIDENCE: TraceInsight["confidence"] = "high";

/** Track recently escalated titles to prevent duplicate board items. */
const escalatedTitles = new Set<string>();

/**
 * Cooldown tracker: maps insight title → timestamp of last escalation.
 * Prevents re-escalating the same pattern within ESCALATION_COOLDOWN_MS.
 */
const escalationCooldowns = new Map<string, number>();
const ESCALATION_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6h per pattern

/** Max activity entries to include in a triage LLM call. */
const TRIAGE_MAX_ENTRIES = 15;

/**
 * Patterns from done/cancelled board items — permanently suppressed from re-analysis.
 * Populated from board queries during escalation and at startup.
 */
const resolvedPatterns = new Set<string>();

// ─── State ──────────────────────────────────────────────────────────────────

let timer: ReturnType<typeof setInterval> | null = null;
let firstRunTimer: ReturnType<typeof setTimeout> | null = null;
let lastAnalysisId = 0;
let insights: TraceInsight[] = [];
let lastRun: InsightRunSummary | null = null;

// ─── Persistence ─────────────────────────────────────────────────────────────

const BRAIN_DIR = join(process.cwd(), "brain");
const INSIGHTS_FILE = join(BRAIN_DIR, "operations", "insights.jsonl");
const INSIGHTS_SCHEMA = JSON.stringify({ _schema: "insights", _version: "1.0" });

const WATERMARK_FILE = join(BRAIN_DIR, "operations", ".insights-watermark");

/** Load the analysis watermark so we don't re-analyze old entries on restart. */
function loadWatermark(): number {
  try {
    const raw = readFileSync(WATERMARK_FILE, "utf-8").trim();
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** Persist the analysis watermark to disk. */
function persistWatermark(id: number): void {
  try {
    writeFileSync(WATERMARK_FILE, String(id), "utf-8");
  } catch {
    log.debug("Failed to persist insights watermark");
  }
}

/** Load persisted insights from disk on startup. */
async function loadInsights(): Promise<void> {
  try {
    await ensureBrainJsonl(INSIGHTS_FILE, INSIGHTS_SCHEMA);
    const lines = await readBrainLines(INSIGHTS_FILE);
    const loaded: TraceInsight[] = [];
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj._schema) continue;
        if (obj.id && obj.title) loaded.push(obj as TraceInsight);
      } catch { continue; }
    }
    // Keep only the latest MAX_INSIGHTS
    insights = loaded.length > MAX_INSIGHTS
      ? loaded.slice(loaded.length - MAX_INSIGHTS)
      : loaded;
    log.info(`Loaded ${insights.length} persisted insight(s)`);
  } catch (err) {
    log.debug(`Could not load insights: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Append new insights to the JSONL file. */
async function persistInsights(newInsights: TraceInsight[]): Promise<void> {
  for (const ins of newInsights) {
    await appendBrainLine(INSIGHTS_FILE, JSON.stringify(ins));
  }
}

/** Compact insights file to only keep the latest MAX_INSIGHTS. */
async function compactInsights(): Promise<void> {
  const lines = [INSIGHTS_SCHEMA, ...insights.map((i) => JSON.stringify(i))];
  await writeBrainLines(INSIGHTS_FILE, lines);
  log.debug(`Insights compacted to ${insights.length} entries`);
}

// ─── Source affinity groups for temporal clustering ─────────────────────────

const SOURCE_AFFINITY: Record<string, string> = {
  autonomous: "agent-lifecycle",
  agent: "agent-lifecycle",
  system: "agent-lifecycle",
  "goal-loop": "goal-work",
  gmail: "google-sync",
  calendar: "google-sync",
  google: "google-sync",
  tasks: "google-sync",
  slack: "messaging",
  whatsapp: "messaging",
  "open-loop": "open-loop",
};

// ─── Chain building ─────────────────────────────────────────────────────────

/**
 * Build trace chains from activity entries using two strategies:
 * 1. Backref linking (union-find style)
 * 2. Temporal-source clustering (fallback for entries without backrefs)
 */
export function buildTraceChains(entries: ActivityEntry[]): TraceChain[] {
  const chains: TraceChain[] = [];

  // --- Strategy 1: Backref linking ---
  const byTraceId = new Map<string, ActivityEntry>();
  for (const e of entries) {
    byTraceId.set(e.traceId, e);
  }

  // Union-find: map each traceId to its root
  const parent = new Map<string, string>();
  function find(id: string): string {
    let root = id;
    while (parent.has(root) && parent.get(root) !== root) {
      root = parent.get(root)!;
    }
    // Path compression
    let cur = id;
    while (cur !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  function union(a: string, b: string): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  // Initialize each entry as its own root
  for (const e of entries) {
    parent.set(e.traceId, e.traceId);
  }

  // Link entries via backrefs
  const linkedTraceIds = new Set<string>();
  for (const e of entries) {
    if (e.backref && byTraceId.has(e.backref)) {
      union(e.traceId, e.backref);
      linkedTraceIds.add(e.traceId);
      linkedTraceIds.add(e.backref);
    }
  }

  // Group linked entries by root
  const groups = new Map<string, ActivityEntry[]>();
  for (const e of entries) {
    if (!linkedTraceIds.has(e.traceId)) continue;
    const root = find(e.traceId);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(e);
  }

  for (const [rootId, groupEntries] of groups) {
    if (groupEntries.length < 2) continue;
    groupEntries.sort((a, b) => a.id - b.id);
    const timestamps = groupEntries.map((e) => new Date(e.timestamp).getTime());
    const sources = [...new Set(groupEntries.map((e) => e.source))];
    chains.push({
      rootTraceId: rootId,
      linkType: "backref",
      entries: groupEntries,
      sources,
      spanMs: Math.max(...timestamps) - Math.min(...timestamps),
    });
  }

  // --- Strategy 2: Temporal-source clustering ---
  const unlinked = entries.filter((e) => !linkedTraceIds.has(e.traceId));
  if (unlinked.length >= MIN_CLUSTER_SIZE) {
    const sorted = [...unlinked].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );

    let clusterStart = 0;
    while (clusterStart < sorted.length) {
      const windowEnd = new Date(sorted[clusterStart].timestamp).getTime() + CLUSTER_WINDOW_MS;
      let clusterEnd = clusterStart;

      // Expand window
      while (
        clusterEnd + 1 < sorted.length &&
        new Date(sorted[clusterEnd + 1].timestamp).getTime() <= windowEnd
      ) {
        clusterEnd++;
      }

      const window = sorted.slice(clusterStart, clusterEnd + 1);

      // Sub-cluster by source affinity
      const affinityGroups = new Map<string, ActivityEntry[]>();
      for (const e of window) {
        const group = SOURCE_AFFINITY[e.source] ?? e.source;
        if (!affinityGroups.has(group)) affinityGroups.set(group, []);
        affinityGroups.get(group)!.push(e);
      }

      for (const [, groupEntries] of affinityGroups) {
        if (groupEntries.length < MIN_CLUSTER_SIZE) continue;
        const timestamps = groupEntries.map((e) => new Date(e.timestamp).getTime());
        const sources = [...new Set(groupEntries.map((e) => e.source))];
        chains.push({
          rootTraceId: groupEntries[0].traceId,
          linkType: "temporal-cluster",
          entries: groupEntries,
          sources,
          spanMs: Math.max(...timestamps) - Math.min(...timestamps),
        });
      }

      clusterStart = clusterEnd + 1;
    }
  }

  return chains;
}

// ─── LLM analysis ───────────────────────────────────────────────────────────

function getAnalystSystemPrompt(): string {
  return `You are an activity pattern analyst for ${getInstanceName()}, a personal AI operating system.
You receive trace chains — groups of related activity entries linked by trace IDs or temporal proximity.

Analyze these chains and report 0-5 insights. Each insight should be one of:
- "pattern": A recurring behavior or cycle (e.g., "Agent GC runs every minute")
- "anomaly": Something unusual or unexpected
- "correlation": Two seemingly unrelated activities that co-occur
- "bottleneck": A chain that takes unusually long or has repeated retries

Respond with ONLY a JSON array of insight objects. If no interesting patterns exist, return [].

Each object: { "category": "pattern"|"anomaly"|"correlation"|"bottleneck", "title": "short title", "description": "1-2 sentences", "relatedTraceIds": ["id1","id2"], "confidence": "high"|"medium"|"low" }`;
}

async function analyzeChains(chains: TraceChain[]): Promise<TraceInsight[]> {
  // Serialize chains for the LLM
  const serialized = chains.map((c) => ({
    rootTraceId: c.rootTraceId,
    linkType: c.linkType,
    sources: c.sources,
    spanMs: c.spanMs,
    entries: c.entries.map((e) => ({
      timestamp: e.timestamp,
      source: e.source,
      summary: e.summary,
      traceId: e.traceId,
      backref: e.backref ?? null,
    })),
  }));

  const provider = resolveProvider();
  const model = resolveUtilityModel();

  const response = await completeChat({
    messages: [
      { role: "system", content: getAnalystSystemPrompt() },
      { role: "user", content: JSON.stringify(serialized, null, 2) },
    ],
    model,
    provider,
  });

  // Parse JSON array from response (handle markdown fences)
  let jsonStr = response.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) jsonStr = fenceMatch[1].trim();

  const arrayMatch = jsonStr.match(/\[[\s\S]*\]/);
  if (!arrayMatch) return [];

  try {
    const parsed = JSON.parse(arrayMatch[0]);
    if (!Array.isArray(parsed)) return [];

    const now = new Date().toISOString();
    return parsed
      .filter(
        (p: any) =>
          p.category && p.title && p.description && p.relatedTraceIds,
      )
      .map((p: any) => ({
        id: "ins_" + randomBytes(4).toString("hex"),
        discoveredAt: now,
        category: p.category,
        title: p.title,
        description: p.description,
        relatedTraceIds: Array.isArray(p.relatedTraceIds) ? p.relatedTraceIds : [],
        confidence: p.confidence ?? "medium",
      }));
  } catch {
    log.warn("Failed to parse LLM insight response");
    return [];
  }
}

// ─── Pre-analysis filters ────────────────────────────────────────────────────

/**
 * Filter out activity entries whose summaries match patterns from
 * done/cancelled board items. Saves the LLM call for known-solved issues.
 */
function filterResolvedPatterns(entries: ActivityEntry[]): ActivityEntry[] {
  if (resolvedPatterns.size === 0) return entries;
  return entries.filter((e) => {
    const lower = e.summary.toLowerCase();
    for (const pattern of resolvedPatterns) {
      if (lower.includes(pattern)) return false;
    }
    return true;
  });
}

// ─── Core analysis run ──────────────────────────────────────────────────────

async function runAnalysis(): Promise<InsightRunSummary | null> {
  const rawEntries = (await getActivities(lastAnalysisId)).slice(0, MAX_ENTRIES_PER_ANALYSIS);

  if (rawEntries.length < 3) {
    log.info(`Only ${rawEntries.length} new entries — skipping analysis`);
    const summary: InsightRunSummary = {
      ranAt: new Date().toISOString(),
      chainsAnalyzed: 0,
      entriesAnalyzed: rawEntries.length,
      newInsights: 0,
    };
    lastRun = summary;
    return summary;
  }

  // Update watermark from raw (not filtered) to avoid re-analyzing filtered entries
  const rawWatermark = rawEntries[rawEntries.length - 1].id;

  // ── Filter pipeline (cheap string ops before expensive LLM call) ──

  // Component 3: Routine Activity Classifier — skip Instance GC, health checks, etc.
  const { kept: afterRoutine, filtered: routineCount } = filterRoutine(rawEntries);
  if (routineCount > 0) {
    log.debug(`Filtered ${routineCount} routine entries from analysis`);
    recordRoutineFiltered(routineCount);
  }

  // Component 2: Resolved-pattern filter — skip patterns from done/cancelled board items
  const newEntries = filterResolvedPatterns(afterRoutine);
  const resolvedCount = afterRoutine.length - newEntries.length;
  if (resolvedCount > 0) {
    recordResolvedFiltered(resolvedCount);
  }

  // Record analysis pipeline throughput
  recordAnalysisThroughput(rawEntries.length, newEntries.length);

  if (newEntries.length < 3) {
    log.info(`Only ${newEntries.length} entries after filtering (${routineCount} routine, ${resolvedCount} resolved) — skipping analysis`);
    lastAnalysisId = rawWatermark;
    persistWatermark(rawWatermark);
    const summary: InsightRunSummary = {
      ranAt: new Date().toISOString(),
      chainsAnalyzed: 0,
      entriesAnalyzed: newEntries.length,
      newInsights: 0,
    };
    lastRun = summary;
    return summary;
  }

  log.info(`Analyzing ${newEntries.length} entries (filtered ${rawEntries.length - newEntries.length} of ${rawEntries.length} raw)...`);

  const chains = buildTraceChains(newEntries);

  if (chains.length === 0) {
    log.info("No trace chains found — skipping LLM call");
    // Still update watermark so we don't re-analyze these
    lastAnalysisId = rawWatermark;
    persistWatermark(rawWatermark);
    const summary: InsightRunSummary = {
      ranAt: new Date().toISOString(),
      chainsAnalyzed: 0,
      entriesAnalyzed: newEntries.length,
      newInsights: 0,
    };
    lastRun = summary;
    return summary;
  }

  try {
    const newInsights = await analyzeChains(chains);

    // Append insights (FIFO eviction at MAX_INSIGHTS) + persist to disk
    insights.push(...newInsights);
    if (newInsights.length > 0) {
      persistInsights(newInsights).catch((err) => {
        log.debug(`Insight persist failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
    if (insights.length > MAX_INSIGHTS) {
      insights = insights.slice(insights.length - MAX_INSIGHTS);
      // Compact file after eviction to keep it trimmed
      compactInsights().catch((err) => {
        log.debug(`Insight compact failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }

    // Update watermark (use raw to skip filtered entries too)
    lastAnalysisId = rawWatermark;
    persistWatermark(rawWatermark);

    const summary: InsightRunSummary = {
      ranAt: new Date().toISOString(),
      chainsAnalyzed: chains.length,
      entriesAnalyzed: newEntries.length,
      newInsights: newInsights.length,
    };
    lastRun = summary;

    log.info(
      `Analysis complete: ${chains.length} chains, ${newInsights.length} new insights`,
    );

    if (newInsights.length > 0) {
      const titles = newInsights.map((i) => i.title).join("; ");
      logActivity({
        source: "system",
        summary: `Trace insights: ${newInsights.length} discovered — ${titles}`,
      });

      // Escalate actionable insights to the board
      escalateInsights(newInsights).catch((err) => {
        log.warn(`Insight escalation failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }

    return summary;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Analysis failed: ${msg}`);
    logActivity({ source: "system", summary: `Trace insight analysis failed: ${msg}` });
    return null;
  }
}

// ─── Insight triage ──────────────────────────────────────────────────────────

function getTriageSystemPrompt(): string {
  return `You are a triage analyst for ${getInstanceName()}, a file-based personal AI operating system.

You receive an insight (a bottleneck or anomaly detected by the trace correlation engine) along with the related activity entries that triggered it.

Your job: convert this vague observation into a concrete, actionable task spec that an autonomous agent can execute.

Respond with ONLY a JSON object (no markdown fences, no extra text):
{
  "problem": "1-2 sentence summary of what's wrong",
  "investigationSteps": ["step 1", "step 2", ...],
  "filesToCheck": [{"path": "src/...", "reason": "why this file matters"}],
  "acceptanceCriteria": ["criterion 1", "criterion 2", ...],
  "rootCauseHypothesis": "best guess based on the activity data"
}

Rules:
- Reference actual ${getInstanceName()} file paths (src/, brain/) — be specific
- Investigation steps should be concrete actions (read file X, check metric Y, compare timestamps)
- Acceptance criteria must be verifiable (not "works better" but "response time < 5s")
- Keep total output under 500 words`;
}

interface TriageResult {
  problem: string;
  investigationSteps: string[];
  filesToCheck?: { path: string; reason: string }[];
  acceptanceCriteria?: string[];
  rootCauseHypothesis?: string;
}

/**
 * Use the LLM to convert a vague insight into a concrete task spec.
 * Returns an enriched markdown description, or null on any failure.
 */
async function triageInsightForEscalation(insight: TraceInsight): Promise<string | null> {
  try {
    // Fetch related activity entries
    const relatedEntries = await getActivitiesByTraceIds(insight.relatedTraceIds);
    const capped = relatedEntries.slice(0, TRIAGE_MAX_ENTRIES);

    const slimEntries = capped.map((e) => ({
      timestamp: e.timestamp,
      source: e.source,
      summary: e.summary,
      traceId: e.traceId,
    }));

    const payload = {
      insight: {
        category: insight.category,
        title: insight.title,
        description: insight.description,
        confidence: insight.confidence,
        discoveredAt: insight.discoveredAt,
      },
      relatedActivity: slimEntries,
    };

    const provider = resolveProvider();
    const model = resolveUtilityModel();

    const response = await completeChat({
      messages: [
        { role: "system", content: getTriageSystemPrompt() },
        { role: "user", content: JSON.stringify(payload, null, 2) },
      ],
      model,
      provider,
      noCache: true,
    });

    // Parse JSON from response (handle markdown fences)
    let jsonStr = response.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) jsonStr = fenceMatch[1].trim();

    const objMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (!objMatch) {
      log.warn("Triage response contained no JSON object");
      return null;
    }

    const parsed: TriageResult = JSON.parse(objMatch[0]);
    if (!parsed.problem || !parsed.investigationSteps) {
      log.warn("Triage response missing required fields");
      return null;
    }

    // Format as markdown
    const sections: string[] = [
      `**Problem:** ${parsed.problem}`,
      ``,
      `**Investigation steps:**`,
      ...parsed.investigationSteps.map((s, i) => `${i + 1}. ${s}`),
    ];

    if (parsed.rootCauseHypothesis) {
      sections.push(``, `**Root cause hypothesis:** ${parsed.rootCauseHypothesis}`);
    }

    if (parsed.acceptanceCriteria && parsed.acceptanceCriteria.length > 0) {
      sections.push(``, `**Acceptance criteria:**`);
      for (const c of parsed.acceptanceCriteria) {
        sections.push(`- ${c}`);
      }
    }

    if (parsed.filesToCheck && parsed.filesToCheck.length > 0) {
      sections.push(``, `**Files to check:**`);
      for (const f of parsed.filesToCheck) {
        sections.push(`- \`${f.path}\` — ${f.reason}`);
      }
    }

    return sections.join("\n");
  } catch (err) {
    log.warn(`Triage failed for insight "${insight.title}": ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ─── Insight → Board escalation ──────────────────────────────────────────────

/**
 * Escalate high-confidence actionable insights to the board as backlog items.
 * Only bottlenecks and anomalies qualify — patterns and correlations are informational.
 *
 * Deduplicates against:
 * 1. In-memory set of recently escalated titles (fast path)
 * 2. Existing board items (checks for substring match in title — survives restarts)
 */
async function escalateInsights(newInsights: TraceInsight[]): Promise<void> {
  const board = getBoardProvider();
  if (!board?.isAvailable()) return;

  const now = Date.now();
  // Prune expired cooldowns
  for (const [title, ts] of escalationCooldowns) {
    if (now - ts > ESCALATION_COOLDOWN_MS) escalationCooldowns.delete(title);
  }

  const eligible = newInsights.filter(
    (i) =>
      ESCALATION_CATEGORIES.includes(i.category) &&
      i.confidence === ESCALATION_MIN_CONFIDENCE &&
      !escalatedTitles.has(i.title) &&
      !escalationCooldowns.has(i.title),
  );

  if (eligible.length === 0) return;

  // Fetch existing board items to deduplicate against (survives restarts)
  let existingTitles: string[] = [];
  try {
    const existing = await board.listIssues({ limit: 200 });
    if (existing) {
      existingTitles = existing.map((i) => i.title.toLowerCase());
      // Backfill the in-memory set so we don't re-query next time
      for (const item of existing) {
        const titleLower = item.title.toLowerCase();
        if (titleLower.startsWith("[bottleneck]") || titleLower.startsWith("[anomaly]")) {
          const stripped = titleLower.replace(/^\[(bottleneck|anomaly)\]\s*/, "");
          escalatedTitles.add(stripped);
          // Component 2: If item is resolved, add to permanent suppress list
          const stateLower = item.state.toLowerCase();
          if (stateLower === "done" || stateLower === "cancelled") {
            resolvedPatterns.add(stripped);
          }
        }
      }
    }
  } catch (err) {
    log.warn(`Failed to fetch board items for dedup: ${err instanceof Error ? err.message : String(err)}`);
  }

  for (const insight of eligible) {
    // Skip if already on the board (fuzzy: check if the insight title appears in any existing title)
    const titleLower = insight.title.toLowerCase();
    if (escalatedTitles.has(insight.title)) continue;
    const alreadyOnBoard = existingTitles.some(
      (t) => t.includes(titleLower) || titleLower.includes(t.replace(/^\[.*?\]\s*/, "")),
    );
    if (alreadyOnBoard) {
      escalatedTitles.add(insight.title);
      log.info(`Skipping escalation — already on board: ${insight.title}`);
      continue;
    }

    try {
      // Triage: enrich vague insight with concrete investigation spec
      const enrichedDescription = await triageInsightForEscalation(insight);

      const descriptionBody = enrichedDescription
        ? [
            `**Auto-escalated from insight engine**`,
            ``,
            `**Category:** ${insight.category}`,
            `**Confidence:** ${insight.confidence}`,
            `**Discovered:** ${insight.discoveredAt}`,
            ``,
            enrichedDescription,
            ``,
            `_Insight ID: ${insight.id}_`,
          ].join("\n")
        : [
            `**Auto-escalated from insight engine**`,
            ``,
            `**Category:** ${insight.category}`,
            `**Confidence:** ${insight.confidence}`,
            `**Discovered:** ${insight.discoveredAt}`,
            ``,
            insight.description,
            ``,
            `_Insight ID: ${insight.id}_`,
          ].join("\n");

      const issue = await board.createIssue(
        `[${insight.category}] ${insight.title}`,
        {
          description: descriptionBody,
          priority: insight.category === "bottleneck" ? 2 : 3,
        },
      );

      if (issue) {
        escalatedTitles.add(insight.title);
        escalationCooldowns.set(insight.title, Date.now());
        log.info(`Escalated insight to board: ${issue.identifier} — ${insight.title}`);
        logActivity({
          source: "board",
          summary: `Insight escalated to ${issue.identifier}: ${insight.title}`,
          detail: issue.url,
          actionLabel: "AUTONOMOUS",
          reason: "insight engine escalated high-confidence finding",
        });

        // DASH-102: Emit CDT activation via unified primitive
        emitCdt({
          triggerId: insight.id,
          sourceKey: `insight:${insight.category}`,
          anchor: insight.title,
          loopsInvolved: insight.relatedTraceIds,
        });
      }
    } catch (err) {
      log.warn(`Failed to escalate insight "${insight.title}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// ─── Resolved patterns hydration ─────────────────────────────────────────────

/**
 * Pre-populate resolvedPatterns from board items in terminal states.
 * Called once at startup so the first analysis run already benefits.
 */
async function hydrateResolvedPatterns(): Promise<void> {
  const board = getBoardProvider();
  if (!board?.isAvailable()) return;

  const existing = await board.listIssues({ limit: 200 });
  if (!existing) return;

  for (const item of existing) {
    const titleLower = item.title.toLowerCase();
    if (titleLower.startsWith("[bottleneck]") || titleLower.startsWith("[anomaly]")) {
      const stripped = titleLower.replace(/^\[(bottleneck|anomaly)\]\s*/, "");
      const stateLower = item.state.toLowerCase();
      if (stateLower === "done" || stateLower === "cancelled") {
        resolvedPatterns.add(stripped);
      }
      // Also backfill escalatedTitles
      escalatedTitles.add(stripped);
    }
  }

  if (resolvedPatterns.size > 0) {
    log.info(`Hydrated ${resolvedPatterns.size} resolved pattern(s) from board`);
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/** Schedule the next recurring analysis run after ANALYSIS_INTERVAL_MS. */
function scheduleNextRun(): void {
  timer = setTimeout(async () => {
    try {
      await runAnalysis();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`Analysis error: ${msg}`);
    }
    // Chain next run after this one completes (prevents overlap)
    if (timer) scheduleNextRun();
  }, ANALYSIS_INTERVAL_MS);
}

/** Start the insights analysis timer. Idempotent. */
export function startInsightsTimer(): void {
  if (timer || firstRunTimer) return;

  // Restore watermark so we don't re-analyze old entries
  lastAnalysisId = loadWatermark();
  log.debug(`Restored analysis watermark: ${lastAnalysisId}`);

  // Load persisted insights from disk (non-blocking)
  loadInsights().catch((err) => {
    log.debug(`Insight load failed: ${err instanceof Error ? err.message : String(err)}`);
  });

  // Hydrate resolvedPatterns from board state at startup
  hydrateResolvedPatterns().catch((err) => {
    log.debug(`Resolved patterns hydration failed: ${err instanceof Error ? err.message : String(err)}`);
  });

  // First run after a delay to let activity accumulate
  firstRunTimer = setTimeout(async () => {
    firstRunTimer = null;
    log.info("First insight analysis starting...");
    try {
      await runAnalysis();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`First analysis error: ${msg}`);
    }
    // Start recurring chain (10 min after first run completes, not from timer start)
    scheduleNextRun();
  }, FIRST_RUN_DELAY_MS);

  log.info(
    `Trace insights: first run in ${FIRST_RUN_DELAY_MS / 1000}s, then every ${ANALYSIS_INTERVAL_MS / 60_000} min`,
  );
}

/** Stop the insights timer. */
export function stopInsightsTimer(): void {
  if (firstRunTimer) {
    clearTimeout(firstRunTimer);
    firstRunTimer = null;
  }
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

/** Get all discovered insights. */
export function getInsights(): TraceInsight[] {
  return [...insights];
}

/** Get the summary of the last analysis run. */
export function getLastInsightRun(): InsightRunSummary | null {
  return lastRun;
}

/** Get timer diagnostic state. */
export function getInsightTimerState(): { timer: boolean; firstRunTimer: boolean; lastAnalysisId: number } {
  return { timer: timer !== null, firstRunTimer: firstRunTimer !== null, lastAnalysisId };
}

/** Trigger an immediate analysis run (for manual/API use). */
export async function triggerInsightAnalysis(): Promise<InsightRunSummary | null> {
  if (!timer && !firstRunTimer) return null;
  return runAnalysis();
}
