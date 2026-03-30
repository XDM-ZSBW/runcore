/**
 * Routine Activity Classifier — static allowlist of activity patterns
 * that are known-routine (startup, GC, health checks, etc.).
 *
 * Matching entries bypass LLM analysis in the insight engine.
 * Entries still flow into the activity log for history — only skipped for analysis.
 */

import type { ActivityEntry } from "../activity/log.js";

export interface RoutinePattern {
  /** Regex to test against entry.summary */
  pattern: RegExp;
  /** Human-readable label for logging */
  label: string;
}

export const ROUTINE_PATTERNS: RoutinePattern[] = [
  { pattern: /^Instance GC: collected \d+ of \d+/, label: "instance-gc" },
  { pattern: /^Metrics collector/, label: "metrics-tick" },
  { pattern: /^Grooming timer started/, label: "grooming-start" },
  { pattern: /^Health check/, label: "health-check" },
  { pattern: /^Webhook provider registered:/, label: "webhook-reg" },
  { pattern: /^Webhook providers registered:/, label: "webhook-reg-batch" },
  { pattern: /^Webhook admin routes mounted/, label: "webhook-mount" },
  { pattern: /^Webhook config updated/, label: "webhook-config" },
  { pattern: /^Session restored/, label: "session-restore" },
  { pattern: /^Agent runtime initialized/, label: "runtime-init" },
  { pattern: /^Recovering tasks from previous/, label: "task-recovery" },
  { pattern: /^Task recovery complete/, label: "task-recovery-done" },
  { pattern: /^LLM cache initialized/, label: "cache-init" },
  { pattern: /^Instance manager initialized/, label: "instance-mgr-init" },
  { pattern: /^GitHub integration initialized/, label: "github-init" },
  { pattern: /^Morning briefing delivered/, label: "briefing-delivered" },
  { pattern: /^Morning briefing error:/, label: "briefing-error" },
  { pattern: /^Backlog review complete/, label: "backlog-review" },
  { pattern: /^Grooming:/, label: "grooming-check" },
  { pattern: /^Queue compacted:/, label: "queue-compact" },
  { pattern: /^Trace insights:/, label: "trace-insights" },
  { pattern: /^Insight escalated to/, label: "insight-escalation" },
  { pattern: /^Recovery agent spawned/, label: "recovery-spawn" },
  { pattern: /^\[bottleneck\]/, label: "bottleneck-investigation" },
  { pattern: /^\[anomaly\]/, label: "anomaly-investigation" },
  { pattern: /^Promoted .* from backlog/, label: "backlog-promotion" },
  // Self-referential loop breakers: prevent insight engine from analyzing its own failure chain
  { pattern: /^Pre-validation filtered/, label: "prevalidation-filter" },
  { pattern: /^Cooldown:/, label: "cooldown-escalation" },
  { pattern: /^Insight escalation capped/, label: "escalation-cap" },
  { pattern: /planAndSpawn already running/, label: "planner-guard" },
  { pattern: /^No actionable items/, label: "planner-idle" },
  { pattern: /^Pulse trigger skipped/, label: "pulse-skip" },
  { pattern: /recently reviewed by planner/, label: "planner-cache-skip" },
  { pattern: /moved \d+ stale in_progress/, label: "stale-recovery" },
];

export function isRoutineActivity(summary: string): boolean {
  return ROUTINE_PATTERNS.some((p) => p.pattern.test(summary));
}

export function filterRoutine(entries: ActivityEntry[]): {
  kept: ActivityEntry[];
  filtered: number;
} {
  const kept: ActivityEntry[] = [];
  let filtered = 0;
  for (const e of entries) {
    if (isRoutineActivity(e.summary)) {
      filtered++;
    } else {
      kept.push(e);
    }
  }
  return { kept, filtered };
}
