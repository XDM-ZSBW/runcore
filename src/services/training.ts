/**
 * Paired Human Training — observes board craft, observatory usage, and
 * system tuning to provide coaching nudges and track proficiency.
 *
 * No LLM calls. All heuristics are regex-based (same patterns as grooming.ts).
 * Piggybacks on existing timers — no new intervals.
 *
 * Data:
 *   brain/training/proficiency.jsonl  — append-only observations (source of truth)
 *   brain/training/progress.json      — rewritable snapshot (derived cache)
 */

import { join } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createLogger } from "../utils/logger.js";
import {
  appendBrainLine,
  appendBrainLineSync,
  ensureBrainFileSync,
} from "../lib/brain-io.js";
import { logActivity, getActivities } from "../activity/log.js";
import { pushNotification } from "../goals/notifications.js";
import type { QueueTask } from "../queue/types.js";

const log = createLogger("training");

// ─── Paths ────────────────────────────────────────────────────────────────────

import { BRAIN_DIR } from "../lib/paths.js";
const TRAINING_DIR = join(BRAIN_DIR, "training");
const PROFICIENCY_FILE = join(TRAINING_DIR, "proficiency.jsonl");
const PROGRESS_FILE = join(TRAINING_DIR, "progress.json");
const SCHEMA_LINE = JSON.stringify({ _schema: "proficiency", _version: "1.0" });

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SkillObservation {
  type: "observation";
  skillId: string;
  timestamp: string;
  positive: boolean;
  context?: string;
}

interface StatusRollup {
  type: "status";
  skillId: string;
  timestamp: string;
  signal: number;
  observations: number;
  positive: number;
}

type SkillStatus = "undiscovered" | "introduced" | "learning" | "practicing" | "practiced";

interface SkillSnapshot {
  signal: number;
  observations: number;
  status: SkillStatus;
}

interface TreeSnapshot {
  label: string;
  level: number;
  unlocked: boolean;
  skills: Record<string, SkillSnapshot>;
}

interface NudgeInfo {
  skillId: string;
  type: "introduce" | "practice" | "celebrate" | "level_up";
}

export interface TrainingProgress {
  lastScan: string | null;
  lastBoardWatermark: string | null;
  lastActivityId: number;
  trees: Record<string, TreeSnapshot>;
  nextNudge: NudgeInfo | null;
}

// ─── Curriculum ───────────────────────────────────────────────────────────────

interface SkillDef {
  id: string;
  label: string;
  tree: string;
}

const BOARD_CRAFT_SKILLS: SkillDef[] = [
  { id: "bc.title", label: "Clear titles", tree: "board_craft" },
  { id: "bc.description", label: "Meaningful descriptions", tree: "board_craft" },
  { id: "bc.acceptance", label: "Acceptance criteria", tree: "board_craft" },
  { id: "bc.priority", label: "Sets priority", tree: "board_craft" },
  { id: "bc.file_paths", label: "References files", tree: "board_craft" },
  { id: "bc.exchanges", label: "Engages in grooming", tree: "board_craft" },
];

const OBSERVATORY_SKILLS: SkillDef[] = [
  { id: "ol.observatory", label: "Opens Observatory", tree: "observatory_literacy" },
  { id: "ol.briefing", label: "Reads briefing", tree: "observatory_literacy" },
  { id: "ol.bridge", label: "Reads bridge reports", tree: "observatory_literacy" },
  { id: "ol.grooming", label: "Acts on grooming nudges", tree: "observatory_literacy" },
];

const TUNING_SKILLS: SkillDef[] = [
  { id: "tc.settings", label: "Adjusts settings", tree: "tuning_core" },
  { id: "tc.goals", label: "Maintains goals", tree: "tuning_core" },
  { id: "tc.patterns", label: "Adjusts routine patterns", tree: "tuning_core" },
];

const ALL_SKILLS = [...BOARD_CRAFT_SKILLS, ...OBSERVATORY_SKILLS, ...TUNING_SKILLS];

// ─── Nudge messages ───────────────────────────────────────────────────────────

const INTRODUCE_MESSAGES: Record<string, string> = {
  "bc.title": "Tip: Board item titles work best with a verb + object (e.g. \"Add retry logic to webhook handler\"). Helps me understand the task at a glance.",
  "bc.description": "Tip: Adding 80+ characters of description to board items — file paths, expected behavior, constraints — helps me spec tasks before I start.",
  "bc.acceptance": "Tip: Adding acceptance criteria ('should', 'must', 'when X then Y') to board items helps me know when the work is done.",
  "bc.priority": "Tip: Setting priority on board items (P0–P3) helps me decide what to work on first when multiple items are ready.",
  "bc.file_paths": "Tip: Referencing file paths (src/, brain/, .ts, .md) in board item descriptions helps me find the right code immediately.",
  "bc.exchanges": "Tip: Commenting on board items (grooming exchanges) adds context I can use when I pick up the task.",
  "ol.observatory": "Tip: The Observatory (/observatory) shows real-time system health, activity, and insights. Worth checking regularly.",
  "ol.briefing": "Tip: I send a morning briefing daily. Reading it helps you know what happened overnight and what needs attention.",
  "ol.bridge": "Tip: Bridge reports summarize what I tried, what worked, and what failed. They're the best way to understand my autonomous work.",
  "ol.grooming": "Tip: When I nudge about vague board items, grooming them within 24h keeps the pipeline flowing.",
  "tc.settings": "Tip: brain/settings.json controls my behavior — provider, models, timers. Adjusting it tunes how I work.",
  "tc.goals": "Tip: Keeping brain/operations/goals.yaml up to date helps me prioritize autonomous work toward your actual goals.",
  "tc.patterns": "Tip: Discussing or adjusting routine patterns (timer intervals, autonomous behavior) helps me match your workflow.",
};

const CELEBRATE_MESSAGES: Record<string, string> = {
  "bc.title": "Your recent board items all have clear verb-noun titles. That's second nature now.",
  "bc.description": "Your board item descriptions are consistently detailed. I can spec tasks without guessing.",
  "bc.acceptance": "You've been adding acceptance criteria to board items reliably. That's a big help.",
  "bc.priority": "Priority settings on your board items are consistent. I know what matters most.",
  "bc.file_paths": "You regularly reference file paths in board items. I can jump straight to the code.",
  "bc.exchanges": "You're actively grooming board items with exchanges. Great collaboration signal.",
  "ol.observatory": "You're checking the Observatory regularly. You have good situational awareness.",
  "ol.briefing": "You consistently read the morning briefing. We're in sync on daily status.",
  "ol.bridge": "You read bridge reports and act on them. That feedback loop keeps me effective.",
  "ol.grooming": "You act on grooming nudges quickly. The backlog stays clean.",
  "tc.settings": "You've tuned the settings to match your workflow. System is well-calibrated.",
  "tc.goals": "Goals are up to date. My autonomous work stays aligned with your priorities.",
  "tc.patterns": "You've adjusted routine patterns. The system matches how you work.",
};

// ─── State ────────────────────────────────────────────────────────────────────

let progress: TrainingProgress = {
  lastScan: null,
  lastBoardWatermark: null,
  lastActivityId: 0,
  trees: {},
  nextNudge: null,
};

/** Rolling window of recent observations (in-memory, loaded from JSONL). */
let observations: SkillObservation[] = [];

/** Nudge cooldowns: skillId → last nudge ISO timestamp. */
const nudgeCooldowns = new Map<string, string>();

/** Daily nudge counter: "YYYY-MM-DD" → count. */
let dailyNudges = { date: "", count: 0 };

let initialized = false;

// ─── Init ─────────────────────────────────────────────────────────────────────

/**
 * Load progress.json into memory, create dir/files if missing.
 * Called once at server startup.
 */
export function initTraining(): void {
  if (initialized) return;
  initialized = true;

  try {
    ensureBrainFileSync(PROFICIENCY_FILE, SCHEMA_LINE);

    // Load progress snapshot
    if (existsSync(PROGRESS_FILE)) {
      const raw = JSON.parse(
        readFileSync(PROGRESS_FILE, "utf-8"),
      );
      progress = raw as TrainingProgress;
    } else {
      // Write default progress
      progress = buildDefaultProgress();
      writeProgressSync(progress);
    }

    // Load recent observations (30d window) from JSONL
    loadObservations();

    log.info("Training system initialized");
  } catch (err) {
    log.warn(`Training init failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function buildDefaultProgress(): TrainingProgress {
  return {
    lastScan: null,
    lastBoardWatermark: null,
    lastActivityId: 0,
    trees: {
      board_craft: {
        label: "Board Craft",
        level: 1,
        unlocked: true,
        skills: Object.fromEntries(
          BOARD_CRAFT_SKILLS.map((s) => [s.id, { signal: 0, observations: 0, status: "undiscovered" as SkillStatus }]),
        ),
      },
      observatory_literacy: {
        label: "Observatory Literacy",
        level: 2,
        unlocked: false,
        skills: Object.fromEntries(
          OBSERVATORY_SKILLS.map((s) => [s.id, { signal: 0, observations: 0, status: "undiscovered" as SkillStatus }]),
        ),
      },
      tuning_core: {
        label: "Tuning Core",
        level: 3,
        unlocked: false,
        skills: Object.fromEntries(
          TUNING_SKILLS.map((s) => [s.id, { signal: 0, observations: 0, status: "undiscovered" as SkillStatus }]),
        ),
      },
    },
    nextNudge: null,
  };
}

function writeProgressSync(p: TrainingProgress): void {
  try {
    const dir = TRAINING_DIR;
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2) + "\n", "utf-8");
  } catch (err) {
    log.warn(`Failed to write progress.json: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function loadObservations(): void {
  try {
    const raw = readFileSync(PROFICIENCY_FILE, "utf-8");
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    observations = [];

    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        if (obj._schema) continue;
        if (obj.type === "observation" && obj.timestamp >= cutoff) {
          observations.push(obj as SkillObservation);
        }
      } catch {
        // skip malformed
      }
    }
  } catch {
    observations = [];
  }
}

// ─── Board Craft heuristics ───────────────────────────────────────────────────

function assessBoardCraft(task: QueueTask): SkillObservation[] {
  const now = new Date().toISOString();
  const obs: SkillObservation[] = [];
  const id = task.identifier;
  const desc = task.description || "";
  const title = task.title || "";

  // bc.title: >5 words, contains a verb
  const wordCount = title.trim().split(/\s+/).length;
  const hasVerb = /\b(?:add|create|fix|update|remove|implement|refactor|build|design|configure|integrate|migrate|optimize|enable|disable|set up|write|deploy|test|validate|handle|extract|convert|move|rename|replace|rewrite|clean|improve|extend)\b/i.test(title);
  obs.push({
    type: "observation",
    skillId: "bc.title",
    timestamp: now,
    positive: wordCount > 5 && hasVerb,
    context: `${id}: ${wordCount} words${hasVerb ? ", has verb" : ", no verb"}`,
  });

  // bc.description: >80 chars OR has file paths/acceptance keywords
  const hasFilePaths = /(?:src\/|brain\/|public\/|\.ts|\.js|\.md)/.test(desc);
  const hasActionableDetail = /(?:acceptance|criteria|deliverable|must|should|implement|add|create|fix|update|remove|when|endpoint|route|component)/i.test(desc);
  obs.push({
    type: "observation",
    skillId: "bc.description",
    timestamp: now,
    positive: desc.length >= 80 || hasFilePaths || hasActionableDetail,
    context: `${id}: ${desc.length} chars${hasFilePaths ? ", has paths" : ""}${hasActionableDetail ? ", has detail" : ""}`,
  });

  // bc.acceptance: contains should/must/when/deliverable
  const hasAcceptance = /\b(?:should|must|when|deliverable|given|then|expect|verify|assert)\b/i.test(desc);
  obs.push({
    type: "observation",
    skillId: "bc.acceptance",
    timestamp: now,
    positive: hasAcceptance,
    context: `${id}: ${hasAcceptance ? "has" : "no"} acceptance keywords`,
  });

  // bc.priority: priority !== 0
  obs.push({
    type: "observation",
    skillId: "bc.priority",
    timestamp: now,
    positive: task.priority !== 0,
    context: `${id}: priority=${task.priority}`,
  });

  // bc.file_paths: description references src/ or brain/ or .ts/.md
  obs.push({
    type: "observation",
    skillId: "bc.file_paths",
    timestamp: now,
    positive: hasFilePaths,
    context: `${id}: ${hasFilePaths ? "references files" : "no file refs"}`,
  });

  // bc.exchanges: has human-authored exchanges (source: "chat")
  const humanExchanges = (task.exchanges ?? []).filter((ex) => ex.source === "chat");
  obs.push({
    type: "observation",
    skillId: "bc.exchanges",
    timestamp: now,
    positive: humanExchanges.length > 0,
    context: `${id}: ${humanExchanges.length} chat exchange(s)`,
  });

  return obs;
}

// ─── Observatory Literacy heuristics ──────────────────────────────────────────

async function assessObservatoryLiteracy(): Promise<SkillObservation[]> {
  const now = new Date().toISOString();
  const obs: SkillObservation[] = [];
  const activities = await getActivities(progress.lastActivityId);

  // ol.observatory: check for observatory access in activity log
  const hasObservatoryAccess = activities.some(
    (a) => a.summary.toLowerCase().includes("observatory") ||
           a.source === "system" && a.summary.includes("/observatory"),
  );
  if (hasObservatoryAccess) {
    obs.push({
      type: "observation",
      skillId: "ol.observatory",
      timestamp: now,
      positive: true,
      context: "Observatory accessed recently",
    });
  }

  // ol.briefing: chat activity within hours of briefing delivery
  const briefingActivity = activities.find(
    (a) => a.source === "system" && a.summary.includes("Morning briefing delivered"),
  );
  if (briefingActivity) {
    const briefingTime = new Date(briefingActivity.timestamp).getTime();
    const chatAfterBriefing = activities.some(
      (a) =>
        (a.source === "board" || a.source === "agent") &&
        new Date(a.timestamp).getTime() > briefingTime &&
        new Date(a.timestamp).getTime() < briefingTime + 4 * 60 * 60 * 1000,
    );
    obs.push({
      type: "observation",
      skillId: "ol.briefing",
      timestamp: now,
      positive: chatAfterBriefing,
      context: chatAfterBriefing ? "Activity seen after briefing" : "No activity after briefing",
    });
  }

  // ol.bridge: references bridge report or acts on failed task
  const bridgeRef = activities.some(
    (a) => a.summary.toLowerCase().includes("bridge") ||
           a.summary.toLowerCase().includes("bridge report"),
  );
  if (bridgeRef) {
    obs.push({
      type: "observation",
      skillId: "ol.bridge",
      timestamp: now,
      positive: true,
      context: "Bridge report referenced in activity",
    });
  }

  // ol.grooming: check if user groomed items within 24h of a grooming nudge
  const groomingNudge = activities.find(
    (a) => a.source === "board" && a.summary.includes("Grooming"),
  );
  if (groomingNudge) {
    const nudgeTime = new Date(groomingNudge.timestamp).getTime();
    const groomedAfter = activities.some(
      (a) =>
        a.source === "board" &&
        a.summary.includes("exchange") &&
        new Date(a.timestamp).getTime() > nudgeTime &&
        new Date(a.timestamp).getTime() < nudgeTime + 24 * 60 * 60 * 1000,
    );
    if (groomedAfter) {
      obs.push({
        type: "observation",
        skillId: "ol.grooming",
        timestamp: now,
        positive: true,
        context: "Groomed items within 24h of nudge",
      });
    }
  }

  return obs;
}

// ─── Tuning Core heuristics ───────────────────────────────────────────────────

function assessTuningCore(): SkillObservation[] {
  const now = new Date().toISOString();
  const obs: SkillObservation[] = [];

  // tc.settings: check if settings.json differs from defaults
  try {
    const settingsPath = join(BRAIN_DIR, "settings.json");
    if (existsSync(settingsPath)) {
      const content = readFileSync(settingsPath, "utf-8");
      const settings = JSON.parse(content);
      // If settings has been customized (more than just default keys)
      const keys = Object.keys(settings);
      const isCustomized = keys.length > 2; // default has ~2 keys
      obs.push({
        type: "observation",
        skillId: "tc.settings",
        timestamp: now,
        positive: isCustomized,
        context: `settings.json has ${keys.length} keys`,
      });
    }
  } catch {
    // can't read settings — skip
  }

  // tc.goals: check if goals.yaml was updated in last 30 days
  try {
    const goalsPath = join(BRAIN_DIR, "operations", "goals.yaml");
    if (existsSync(goalsPath)) {
      const stat = statSync(goalsPath);
      const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
      obs.push({
        type: "observation",
        skillId: "tc.goals",
        timestamp: now,
        positive: stat.mtimeMs > thirtyDaysAgo,
        context: `goals.yaml last modified ${Math.round((Date.now() - stat.mtimeMs) / (24 * 60 * 60 * 1000))}d ago`,
      });
    }
  } catch {
    // can't stat goals — skip
  }

  // tc.patterns: check activity log for settings/routine discussions
  // This is a lightweight check — just see if there have been chat exchanges about patterns
  // We'll rely on the activity log scan in assessObservatoryLiteracy for the full picture

  return obs;
}

// ─── Signal computation ───────────────────────────────────────────────────────

function computeSkillStatus(skillId: string): SkillSnapshot {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const relevant = observations.filter(
    (o) => o.skillId === skillId && o.timestamp >= cutoff,
  );

  const total = relevant.length;
  const positive = relevant.filter((o) => o.positive).length;
  const signal = total > 0 ? positive / total : 0;

  let status: SkillStatus;
  if (total === 0) {
    status = "undiscovered";
  } else if (total <= 3) {
    status = "introduced";
  } else if (signal < 0.5) {
    status = "learning";
  } else if (signal < 0.8) {
    status = "practicing";
  } else {
    status = "practiced";
  }

  return { signal: Math.round(signal * 100) / 100, observations: total, status };
}

// ─── Level progression ────────────────────────────────────────────────────────

function checkTreeUnlocks(trees: Record<string, TreeSnapshot>): boolean {
  let changed = false;

  // Level 2 (Observatory Literacy): unlocks when 3+ Board Craft skills are practicing/practiced
  const bcSkills = Object.values(trees.board_craft?.skills ?? {});
  const bcProficient = bcSkills.filter(
    (s) => s.status === "practicing" || s.status === "practiced",
  ).length;
  const olShouldUnlock = bcProficient >= 3;
  if (trees.observatory_literacy && trees.observatory_literacy.unlocked !== olShouldUnlock) {
    trees.observatory_literacy.unlocked = olShouldUnlock;
    changed = true;
  }

  // Level 3 (Tuning Core): unlocks when 2+ Observatory Literacy skills are practicing/practiced
  const olSkills = Object.values(trees.observatory_literacy?.skills ?? {});
  const olProficient = olSkills.filter(
    (s) => s.status === "practicing" || s.status === "practiced",
  ).length;
  const tcShouldUnlock = olProficient >= 2;
  if (trees.tuning_core && trees.tuning_core.unlocked !== tcShouldUnlock) {
    trees.tuning_core.unlocked = tcShouldUnlock;
    changed = true;
  }

  return changed;
}

// ─── Nudge engine ─────────────────────────────────────────────────────────────

const MAX_DAILY_NUDGES = 3;
const SKILL_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24h

function canNudge(skillId: string): boolean {
  // Daily limit
  const today = new Date().toISOString().slice(0, 10);
  if (dailyNudges.date !== today) {
    dailyNudges = { date: today, count: 0 };
  }
  if (dailyNudges.count >= MAX_DAILY_NUDGES) return false;

  // Per-skill cooldown
  const lastNudge = nudgeCooldowns.get(skillId);
  if (lastNudge) {
    const elapsed = Date.now() - new Date(lastNudge).getTime();
    if (elapsed < SKILL_COOLDOWN_MS) return false;
  }

  return true;
}

function recordNudge(skillId: string): void {
  const now = new Date().toISOString();
  nudgeCooldowns.set(skillId, now);
  const today = now.slice(0, 10);
  if (dailyNudges.date !== today) {
    dailyNudges = { date: today, count: 1 };
  } else {
    dailyNudges.count++;
  }
}

function pickNudge(trees: Record<string, TreeSnapshot>): NudgeInfo | null {
  // Priority 1: celebrate — skill just crossed 0.8
  for (const tree of Object.values(trees)) {
    if (!tree.unlocked) continue;
    for (const [skillId, snap] of Object.entries(tree.skills)) {
      if (snap.status === "practiced" && canNudge(skillId)) {
        // Check if this is a "just crossed" event by looking at previous progress
        const prev = progress.trees[getTreeKey(skillId)]?.skills[skillId];
        if (prev && prev.status !== "practiced") {
          return { skillId, type: "celebrate" };
        }
      }
    }
  }

  // Priority 2: level_up — new tree just unlocked
  for (const [key, tree] of Object.entries(trees)) {
    const prevTree = progress.trees[key];
    if (tree.unlocked && prevTree && !prevTree.unlocked) {
      const firstSkill = Object.keys(tree.skills)[0];
      if (firstSkill && canNudge(firstSkill)) {
        return { skillId: firstSkill, type: "level_up" };
      }
    }
  }

  // Priority 3: introduce — lowest-ordered undiscovered skill in active tree
  for (const tree of Object.values(trees)) {
    if (!tree.unlocked) continue;
    for (const [skillId, snap] of Object.entries(tree.skills)) {
      if (snap.status === "undiscovered" && canNudge(skillId)) {
        return { skillId, type: "introduce" };
      }
    }
  }

  // Priority 4: practice — lowest-signal skill in active tree
  let lowestSignal = Infinity;
  let lowestSkill: string | null = null;
  for (const tree of Object.values(trees)) {
    if (!tree.unlocked) continue;
    for (const [skillId, snap] of Object.entries(tree.skills)) {
      if (snap.observations >= 4 && snap.signal < 0.5 && snap.signal < lowestSignal && canNudge(skillId)) {
        lowestSignal = snap.signal;
        lowestSkill = skillId;
      }
    }
  }
  if (lowestSkill) {
    return { skillId: lowestSkill, type: "practice" };
  }

  return null;
}

function getTreeKey(skillId: string): string {
  const prefix = skillId.split(".")[0];
  if (prefix === "bc") return "board_craft";
  if (prefix === "ol") return "observatory_literacy";
  if (prefix === "tc") return "tuning_core";
  return "board_craft";
}

function formatNudgeMessage(nudge: NudgeInfo): string {
  switch (nudge.type) {
    case "introduce":
      return INTRODUCE_MESSAGES[nudge.skillId] ?? `Training tip for ${nudge.skillId}.`;
    case "celebrate":
      return CELEBRATE_MESSAGES[nudge.skillId] ?? `Great work on ${nudge.skillId}!`;
    case "level_up": {
      const tree = getTreeKey(nudge.skillId);
      const label = tree === "observatory_literacy" ? "Observatory Literacy" : "Tuning Core";
      return `Level up! ${label} unlocked. You've got the previous skills down — let's build on that.`;
    }
    case "practice":
      return INTRODUCE_MESSAGES[nudge.skillId]
        ? `Reminder: ${INTRODUCE_MESSAGES[nudge.skillId]}`
        : `Keep practicing ${nudge.skillId}.`;
    default:
      return "";
  }
}

// ─── Main scan ────────────────────────────────────────────────────────────────

/**
 * Primary training scan. Called after grooming completes.
 * 1. Assess Board Craft from passed-in tasks
 * 2. Assess Observatory Literacy from activity log
 * 3. Assess Tuning Core from file checks
 * 4. Append observations, recompute status, write snapshot, nudge
 */
async function runTrainingScan(tasks: QueueTask[]): Promise<void> {
  const now = new Date().toISOString();
  const newObs: SkillObservation[] = [];

  // 1. Board Craft — assess tasks updated since last watermark
  const watermark = progress.lastBoardWatermark ?? "1970-01-01T00:00:00Z";
  for (const task of tasks) {
    if (task.state === "done" || task.state === "cancelled") continue;
    if (task.updatedAt > watermark || task.createdAt > watermark) {
      newObs.push(...assessBoardCraft(task));
    }
  }

  // 2. Observatory Literacy (if tree unlocked)
  if (progress.trees.observatory_literacy?.unlocked) {
    const olObs = await assessObservatoryLiteracy();
    newObs.push(...olObs);
  }

  // 3. Tuning Core (if tree unlocked)
  if (progress.trees.tuning_core?.unlocked) {
    newObs.push(...assessTuningCore());
  }

  if (newObs.length === 0) {
    log.debug("Training scan: no new observations");
    return;
  }

  // 4. Append observations to JSONL
  for (const ob of newObs) {
    try {
      await appendBrainLine(PROFICIENCY_FILE, JSON.stringify(ob));
    } catch {
      try {
        appendBrainLineSync(PROFICIENCY_FILE, JSON.stringify(ob));
      } catch {
        // non-critical
      }
    }
    observations.push(ob);
  }

  // Trim observations to 30d window
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  observations = observations.filter((o) => o.timestamp >= cutoff);

  // 5. Recompute skill snapshots
  const trees = { ...progress.trees };
  for (const skill of ALL_SKILLS) {
    const treeKey = getTreeKey(skill.id);
    if (!trees[treeKey]) continue;
    trees[treeKey].skills[skill.id] = computeSkillStatus(skill.id);
  }

  // 6. Check tree unlocks
  const leveledUp = checkTreeUnlocks(trees);

  // 7. Pick nudge
  const nudge = pickNudge(trees);

  // 8. Append status rollups to JSONL
  for (const skill of ALL_SKILLS) {
    const treeKey = getTreeKey(skill.id);
    const snap = trees[treeKey]?.skills[skill.id];
    if (!snap || snap.observations === 0) continue;

    const rollup: StatusRollup = {
      type: "status",
      skillId: skill.id,
      timestamp: now,
      signal: snap.signal,
      observations: snap.observations,
      positive: Math.round(snap.signal * snap.observations),
    };
    try {
      await appendBrainLine(PROFICIENCY_FILE, JSON.stringify(rollup));
    } catch {
      // non-critical
    }
  }

  // 9. Update and write progress snapshot
  // Find highest activity ID from recent activities
  try {
    const activities = await getActivities(progress.lastActivityId);
    if (activities.length > 0) {
      progress.lastActivityId = activities[activities.length - 1].id;
    }
  } catch {
    // non-critical
  }

  progress = {
    lastScan: now,
    lastBoardWatermark: now,
    lastActivityId: progress.lastActivityId,
    trees,
    nextNudge: nudge,
  };

  try {
    await mkdir(TRAINING_DIR, { recursive: true });
    await writeFile(PROGRESS_FILE, JSON.stringify(progress, null, 2) + "\n", "utf-8");
  } catch {
    writeProgressSync(progress);
  }

  // 10. Deliver nudge
  if (nudge) {
    const message = formatNudgeMessage(nudge);
    if (message) {
      pushNotification({
        timestamp: now,
        source: "training",
        message,
      });
      recordNudge(nudge.skillId);
    }
  }

  logActivity({
    source: "system",
    summary: `Training scan: ${newObs.length} observations${nudge ? `, nudged ${nudge.skillId} (${nudge.type})` : ""}`,
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Hook: called by grooming timer after runGroomingCheck completes.
 * Fire-and-forget — errors logged, never thrown to caller.
 */
export async function onGroomingComplete(tasks: QueueTask[]): Promise<void> {
  if (!initialized) initTraining();

  try {
    await runTrainingScan(tasks);
  } catch (err) {
    log.warn(`Training scan failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Sync: returns formatted training summary for morning briefing.
 * Returns null if no training data exists yet.
 */
export function getTrainingSummary(): string | null {
  if (!initialized) return null;

  const parts: string[] = [];

  for (const [, tree] of Object.entries(progress.trees)) {
    if (!tree.unlocked) continue;
    const skills = Object.values(tree.skills);
    const total = skills.length;
    const proficient = skills.filter(
      (s) => s.status === "practicing" || s.status === "practiced",
    ).length;
    parts.push(`${tree.label}: ${proficient}/${total} skills practiced`);
  }

  if (parts.length === 0) return null;

  // Add next nudge hint
  if (progress.nextNudge) {
    const skill = ALL_SKILLS.find((s) => s.id === progress.nextNudge?.skillId);
    if (skill) {
      parts.push(`Next: ${skill.label.toLowerCase()}`);
    }
  }

  return "  " + parts.join(". ") + ".";
}

/**
 * Sync: returns cached progress for API endpoint.
 */
export function getTrainingProgress(): TrainingProgress {
  if (!initialized) initTraining();
  return progress;
}
