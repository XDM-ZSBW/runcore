/**
 * Calibration Conversation — question bank and response interpretation.
 *
 * Defines the natural-language questions the agent asks during calibration,
 * and maps free-text responses to threshold values. No forms, no sliders —
 * a conversation that produces thresholds.
 */

import type {
  CalibrationQuestion,
  CalibrationDimension,
  CalibrationThresholds,
  DotThresholds,
} from "./types.js";
import { DEFAULT_THRESHOLDS, DEFAULT_DOT_THRESHOLDS } from "./types.js";

// ── Question bank ────────────────────────────────────────────────────────────

export const ONBOARDING_QUESTIONS: CalibrationQuestion[] = [
  {
    dimension: "autonomy",
    prompt:
      "When I'm working on something for you, do you want to see what I'm doing, or just hear about it when I'm done?",
    interpretations: [
      {
        patterns: ["approve", "see everything", "show me", "watch", "check first", "ask me"],
        value: "low",
        label: "low autonomy — I'll check with you before acting",
      },
      {
        patterns: ["important", "big stuff", "major", "significant", "depends"],
        value: "medium",
        label: "medium autonomy — I'll handle routine tasks, ask on big decisions",
      },
      {
        patterns: ["done", "finished", "just tell me", "handle it", "on your own", "don't bother"],
        value: "high",
        label: "high autonomy — I'll handle things and report back",
      },
    ],
    confirmation: "Got it — {{value}}. I'll handle things accordingly.",
  },
  {
    dimension: "work_visibility",
    prompt:
      "When things are going well with my work, how do you want to know?",
    interpretations: [
      {
        patterns: ["everything", "all of it", "always", "show me all", "keep me posted"],
        value: "high",
        label: "high visibility — work dot always active",
      },
      {
        patterns: ["summary", "overview", "highlights", "sometimes"],
        value: "medium",
        label: "medium visibility — work dot on notable activity",
      },
      {
        patterns: ["don't need", "don't care", "just keep going", "only problems", "quiet"],
        value: "low",
        label: "low visibility — work dot only on attention-needed",
      },
    ],
    confirmation: "Understood — {{value}}.",
  },
  {
    dimension: "escalation_speed",
    prompt: "What about when things go wrong?",
    interpretations: [
      {
        patterns: ["immediately", "right away", "instant", "asap", "tell me now"],
        value: "fast",
        label: "fast escalation — amber dot and nudge on any problem",
      },
      {
        patterns: ["depends", "serious", "important ones", "if it matters"],
        value: "normal",
        label: "normal escalation — nudge on significant issues",
      },
      {
        patterns: ["batch", "later", "when convenient", "summary", "collect"],
        value: "slow",
        label: "slow escalation — collect issues for review",
      },
    ],
    confirmation: "{{value}}. I'll match your preference on problem reporting.",
  },
  {
    dimension: "joy_frequency",
    prompt:
      'When I ask "how\'s it going?" — how often is too often?',
    interpretations: [
      {
        patterns: ["once", "1", "rarely", "not much", "minimal"],
        value: "1/day",
        label: "once a day max",
      },
      {
        patterns: ["twice", "2", "couple", "two"],
        value: "2/day",
        label: "up to twice a day",
      },
      {
        patterns: ["few", "3", "three", "several"],
        value: "3/day",
        label: "a few times a day",
      },
      {
        patterns: ["often", "4", "four", "frequently", "anytime", "whenever"],
        value: "4/day",
        label: "frequently — I like the check-ins",
      },
    ],
    confirmation: "Perfect. I'll check in at natural pauses, max {{value}}.",
  },
  {
    dimension: "verbosity",
    prompt: "When I explain things, do you prefer short and direct, or detailed with context?",
    interpretations: [
      {
        patterns: ["short", "brief", "direct", "concise", "just the answer", "bottom line"],
        value: "concise",
        label: "concise — short answers",
      },
      {
        patterns: ["balance", "medium", "some context", "depends", "normal"],
        value: "balanced",
        label: "balanced — context when it matters",
      },
      {
        patterns: ["detail", "explain", "thorough", "context", "full", "verbose", "everything"],
        value: "detailed",
        label: "detailed — full explanations",
      },
    ],
    confirmation: "{{value}}. I'll match that tone.",
  },
  {
    dimension: "proactivity",
    prompt: "Should I suggest things on my own, or wait for you to ask?",
    interpretations: [
      {
        patterns: ["wait", "ask", "only when", "don't suggest", "I'll tell you"],
        value: "low",
        label: "low proactivity — wait for asks",
      },
      {
        patterns: ["sometimes", "good ideas", "if relevant", "depends", "occasionally"],
        value: "medium",
        label: "medium proactivity — suggest when relevant",
      },
      {
        patterns: ["suggest", "go ahead", "proactive", "yes", "please", "absolutely", "initiative"],
        value: "high",
        label: "high proactivity — actively suggest things",
      },
    ],
    confirmation: "{{value}}. Noted.",
  },
  {
    dimension: "pace",
    prompt: "Do you prefer I work through things one at a time, or handle multiple things in parallel?",
    interpretations: [
      {
        patterns: ["one", "single", "sequential", "focus", "one at a time", "step by step"],
        value: "sequential",
        label: "sequential — one thing at a time",
      },
      {
        patterns: ["parallel", "multiple", "multitask", "several", "at once", "simultaneously"],
        value: "parallel",
        label: "parallel — handle multiple things at once",
      },
    ],
    confirmation: "{{value}}. That's how I'll pace my work.",
  },
];

/**
 * Joy baseline seed question — asked during onboarding when no joy signal
 * history exists yet. Maps self-reported mood to a numeric baseline (1-4 scale).
 */
export const JOY_BASELINE_QUESTION: CalibrationQuestion = {
  dimension: "joy_frequency", // reuse dimension since there's no separate "joy_baseline" dimension
  prompt:
    "Last question before we get started — how are you feeling right now? Rough, meh, good, or great?",
  interpretations: [
    {
      patterns: ["rough", "bad", "terrible", "awful", "struggling", "1"],
      value: "1",
      label: "rough — starting baseline at 1",
    },
    {
      patterns: ["meh", "okay", "ok", "so-so", "alright", "fine", "2"],
      value: "2",
      label: "meh — starting baseline at 2",
    },
    {
      patterns: ["good", "pretty good", "doing well", "not bad", "3"],
      value: "3",
      label: "good — starting baseline at 3",
    },
    {
      patterns: ["great", "awesome", "fantastic", "amazing", "excellent", "4"],
      value: "4",
      label: "great — starting baseline at 4",
    },
  ],
  confirmation: "{{value}}. I'll use that as our starting point and learn from there.",
};

// ── Response interpretation ──────────────────────────────────────────────────

/**
 * Interpret a free-text response against a calibration question.
 * Returns the best matching threshold value and label, or null if no match.
 */
export function interpretResponse(
  question: CalibrationQuestion,
  response: string,
): { value: string; label: string } | null {
  const lower = response.toLowerCase().trim();

  let bestMatch: { value: string; label: string; score: number } | null = null;

  for (const interp of question.interpretations) {
    let score = 0;
    for (const pattern of interp.patterns) {
      if (lower.includes(pattern.toLowerCase())) {
        // Longer pattern matches are more specific, so weight them higher
        score += pattern.length;
      }
    }
    if (score > 0 && (!bestMatch || score > bestMatch.score)) {
      bestMatch = { value: interp.value, label: interp.label, score };
    }
  }

  return bestMatch ? { value: bestMatch.value, label: bestMatch.label } : null;
}

/**
 * Build a confirmation message for a matched interpretation.
 */
export function buildConfirmation(question: CalibrationQuestion, label: string): string {
  return question.confirmation.replace("{{value}}", label);
}

// ── Threshold derivation ─────────────────────────────────────────────────────

/**
 * Derive dot thresholds from calibration thresholds.
 * Maps high-level preferences to numeric sense/work/joy boundaries.
 */
export function deriveThresholds(thresholds: CalibrationThresholds): DotThresholds {
  const derived = { ...DEFAULT_DOT_THRESHOLDS };

  // Sense thresholds based on work visibility
  switch (thresholds.work_visibility) {
    case "high":
      derived.sense_calm = 3;
      derived.sense_active = 8;
      derived.sense_attention = 8;
      break;
    case "medium":
      derived.sense_calm = 5;
      derived.sense_active = 15;
      derived.sense_attention = 15;
      break;
    case "low":
      derived.sense_calm = 10;
      derived.sense_active = 25;
      derived.sense_attention = 25;
      break;
  }

  // Work thresholds based on autonomy and visibility
  switch (thresholds.autonomy) {
    case "high":
      derived.work_calm = 0;
      derived.work_active = thresholds.work_visibility === "low" ? 5 : 3;
      derived.work_attention = derived.work_active;
      break;
    case "medium":
      derived.work_calm = 0;
      derived.work_active = 2;
      derived.work_attention = 2;
      break;
    case "low":
      derived.work_calm = 0;
      derived.work_active = 1;
      derived.work_attention = 1;
      break;
  }

  // Joy baseline starts null — learned from signal history (20+ signals).
  derived.joy_baseline = null;

  return derived;
}

/**
 * Apply a seed joy baseline from the onboarding conversation answer.
 * Called when the user answered the joy baseline question and no
 * statistical baseline exists yet.
 */
export function applySeedBaseline(derived: DotThresholds, seedValue: string): void {
  const num = parseFloat(seedValue);
  if (num >= 1 && num <= 4) {
    derived.joy_baseline = num;
  }
}

/**
 * Get the subset of questions relevant for a set of dimensions.
 */
export function getQuestionsForDimensions(
  dimensions: CalibrationDimension[],
): CalibrationQuestion[] {
  return ONBOARDING_QUESTIONS.filter((q) => dimensions.includes(q.dimension));
}

/**
 * Merge partial answers with defaults to produce complete thresholds.
 */
export function mergeWithDefaults(
  partial: Partial<CalibrationThresholds>,
): CalibrationThresholds {
  return { ...DEFAULT_THRESHOLDS, ...partial };
}
