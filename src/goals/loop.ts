/**
 * Goal loop — single check cycle.
 * Reads goals/todos, asks the LLM what to do, executes the chosen action, logs the result.
 * Follows extractor.ts pattern: never throws, returns result object, uses completeChat.
 */

import { join } from "node:path";
import type { Brain } from "../brain.js";
import type { ContextMessage } from "../types.js";
import type { ProviderName } from "../llm/providers/types.js";
import { completeChat } from "../llm/complete.js";
import { isSearchAvailable, search } from "../search/client.js";
// twilio/call.js is byok-tier — dynamic import
let _twilioMod: typeof import("../twilio/call.js") | null = null;
async function getTwilioMod() {
  if (!_twilioMod) { try { _twilioMod = await import("../twilio/call.js"); } catch {} }
  return _twilioMod;
}

// google/calendar.js is byok-tier — dynamic import
let _calMod: typeof import("../google/calendar.js") | null = null;
async function getCalMod() {
  if (!_calMod) { try { _calMod = await import("../google/calendar.js"); } catch {} }
  return _calMod;
}

import { pushNotification } from "./notifications.js";
import { readBrainFile } from "../lib/brain-io.js";
import { emitCdt } from "../pulse/activation-event.js";
import { getInstanceName, getAlertEmailFrom, resolveEnv } from "../instance.js";

import { BRAIN_DIR } from "../lib/paths.js";

export interface GoalCheckOptions {
  brain: Brain;
  provider: ProviderName;
  model?: string;
  humanName: string;
}

type GoalAction = "remind" | "remind-calendar" | "search" | "email" | "call" | "log" | "nothing";

export interface GoalCheckResult {
  ok: boolean;
  action: GoalAction;
  reasoning?: string;
  outcome?: string;
  error?: string;
}

function getDecisionPrompt(): string {
  return `You are ${getInstanceName()}'s goal-loop system. You review the human's goals, todos, and recent progress, then decide ONE action.

Current time: {{NOW}}
Human: {{HUMAN_NAME}}

Rules:
- Be conservative. "nothing" is usually the right answer.
- "remind" = push a short nudge to the human's next chat message. Use when a deadline is near, a P0 is stale, or encouragement helps.
- "remind-calendar" = push a calendar-related nudge (e.g. "You have a meeting with X in 30 minutes"). Use when upcoming calendar events are relevant to goals or deserve attention.
- "search" = web search for something that would advance a goal. Use sparingly — only when concrete info is needed.
- "email" = send an email to the human. Use for urgent items that need attention but are NOT immediate emergencies. Always prefer email over call.
- "call" = phone call to the human. ABSOLUTE LAST RESORT. Only if: (1) P0 emergency, (2) deadline is within the next hour, (3) you already tried email or reminder with no response. A phone call is disruptive — almost never correct.
- "log" = record an observation about goal progress to memory. Use when you notice a pattern worth remembering.
- "nothing" = no action needed right now. Default choice.

Escalation order: nothing → log → remind → email → call. Never skip email to go straight to call.

Respond with a single JSON object (no markdown fences):
{
  "action": "nothing" | "remind" | "remind-calendar" | "search" | "email" | "call" | "log",
  "reasoning": "one sentence explaining why",
  "message": "text of the reminder/search query/email/call message/log entry (omit for nothing)"
}`;
}

/**
 * Run a single goal check cycle. Never throws.
 */
export async function runGoalCheck(options: GoalCheckOptions): Promise<GoalCheckResult> {
  try {
    // 1. Read goals and todos from disk
    const [goalsRaw, todosRaw] = await Promise.all([
      readBrainFile(join(BRAIN_DIR, "operations", "goals.yaml")).catch(() => "(no goals file)"),
      readBrainFile(join(BRAIN_DIR, "operations", "todos.md")).catch(() => "(no todos file)"),
    ]);

    // 2. Retrieve recent episodic context
    const recentMemories = await options.brain.retrieve("goals tasks progress", { max: 5, type: "episodic" });
    const memoriesText = recentMemories.length > 0
      ? recentMemories.map((m) => `- [${m.createdAt}] ${m.content}`).join("\n")
      : "(no recent memories)";

    // 2b. Retrieve upcoming calendar events (if available)
    let calendarText = "(calendar not connected)";
    const calMod = await getCalMod();
    if (calMod?.isCalendarAvailable()) {
      try {
        const calResult = await calMod.getUpcomingEvents(4);
        if (calResult.ok && calResult.events && calResult.events.length > 0) {
          calendarText = calMod.formatEventsForContext(calResult.events);
        } else {
          calendarText = "(no upcoming events in next 4 hours)";
        }
      } catch {
        calendarText = "(calendar error)";
      }
    }

    // 3. Build prompt
    const now = new Date().toISOString();
    const systemPrompt = getDecisionPrompt()
      .replace("{{NOW}}", now)
      .replace("{{HUMAN_NAME}}", options.humanName);

    const messages: ContextMessage[] = [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: [
          "--- goals.yaml ---",
          goalsRaw,
          "",
          "--- todos.md ---",
          todosRaw,
          "",
          "--- Upcoming calendar ---",
          calendarText,
          "",
          "--- Recent memories ---",
          memoriesText,
        ].join("\n"),
      },
    ];

    // 4. Call LLM
    const raw = await completeChat({
      messages,
      model: options.model,
      provider: options.provider,
    });

    // 5. Parse response (lenient)
    const decision = parseDecision(raw);
    if (!decision) {
      return { ok: false, action: "nothing", error: `Failed to parse LLM response: ${raw.slice(0, 200)}` };
    }

    // 6. Execute action
    const outcome = await executeAction(decision, options);

    // DASH-102: Emit CDT activation via unified primitive
    if (decision.action !== "nothing") {
      emitCdt({
        triggerId: `goal:${decision.action}:${Date.now()}`,
        sourceKey: `goal:${decision.action}`,
        anchor: decision.reasoning ?? decision.action,
      });
    }

    // 7. Log as episodic memory
    await options.brain.learn({
      type: "episodic",
      content: `Goal check: action=${decision.action}, reasoning=${decision.reasoning ?? "none"}${outcome ? `, outcome=${outcome}` : ""}`,
      meta: { source: "goal-loop" },
    });

    return {
      ok: true,
      action: decision.action,
      reasoning: decision.reasoning,
      outcome,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, action: "nothing", error: message };
  }
}

// --- Internal helpers ---

interface Decision {
  action: GoalAction;
  reasoning?: string;
  message?: string;
}

const VALID_ACTIONS = new Set<string>(["remind", "remind-calendar", "search", "email", "call", "log", "nothing"]);

function parseDecision(raw: string): Decision | null {
  let cleaned = raw.trim();
  // Strip markdown fences
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  cleaned = cleaned.trim();

  try {
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    if (typeof parsed !== "object" || parsed === null) return null;

    const action = String(parsed.action ?? "nothing");
    if (!VALID_ACTIONS.has(action)) return null;

    return {
      action: action as GoalAction,
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : undefined,
      message: typeof parsed.message === "string" ? parsed.message : undefined,
    };
  } catch {
    return null;
  }
}

async function executeAction(decision: Decision, options: GoalCheckOptions): Promise<string | undefined> {
  const now = new Date().toISOString();

  switch (decision.action) {
    case "remind": {
      const msg = decision.message ?? "Check your goals — something might need attention.";
      pushNotification({ timestamp: now, source: "goal-loop", message: msg });
      return `Reminder queued: ${msg}`;
    }

    case "remind-calendar": {
      const msg = decision.message ?? "You have an upcoming calendar event.";
      pushNotification({ timestamp: now, source: "calendar", message: msg });
      return `Calendar reminder queued: ${msg}`;
    }

    case "search": {
      if (!isSearchAvailable()) {
        pushNotification({ timestamp: now, source: "goal-loop", message: "I wanted to search for something related to your goals, but search isn't available right now." });
        return "Search unavailable";
      }
      const query = decision.message ?? "progress tips for current goals";
      const result = await search(query);
      if (result) {
        await options.brain.learn({
          type: "semantic",
          content: `Web search for goals: "${query}" — ${result.results.slice(0, 500)}`,
          meta: { source: "goal-loop", query },
        });
        pushNotification({ timestamp: now, source: "goal-loop", message: `I searched for "${query}" and found some info. Ask me about it!` });
        return `Searched: "${query}"`;
      }
      return "Search returned no results";
    }

    case "email": {
      const msg = decision.message ?? "You have a goal item that needs attention.";
      const apiKey = process.env.RESEND_API_KEY;
      if (!apiKey) {
        pushNotification({ timestamp: now, source: "goal-loop", message: `(Email unavailable) ${msg}` });
        return "Email unavailable — sent as reminder instead";
      }
      try {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            from: `${getInstanceName()} <${getAlertEmailFrom()}>`,
            to: [resolveEnv("ALERT_EMAIL_TO") ?? ""].filter(Boolean),
            subject: `[${getInstanceName()}] ${msg.slice(0, 80)}`,
            html: `<div style="font-family:sans-serif;max-width:600px;">
              <div style="background:#6d5dfc;color:white;padding:16px;border-radius:8px 8px 0 0;">
                <h2 style="margin:0;">Goal Alert</h2>
              </div>
              <div style="border:1px solid #e5e7eb;border-top:none;padding:16px;border-radius:0 0 8px 8px;">
                <p>${msg}</p>
                <p style="color:#6b7280;font-size:12px;">— ${getInstanceName()} goal loop at ${now}</p>
              </div>
            </div>`,
          }),
        });
        return res.ok ? `Email sent: ${msg}` : `Email failed (HTTP ${res.status})`;
      } catch (err) {
        return `Email failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    case "call": {
      const msg = decision.message ?? `Hey, ${getInstanceName()} here. You have a P0 item that needs attention today.`;
      const twilioMod = await getTwilioMod();
      if (!twilioMod) return "Call unavailable — Twilio module not loaded";
      const result = await twilioMod.makeCall({ message: msg });
      return result.message;
    }

    case "log": {
      const entry = decision.message ?? decision.reasoning ?? "Goal loop observation (no details)";
      await options.brain.learn({
        type: "semantic",
        content: entry,
        meta: { source: "goal-loop" },
      });
      return `Logged: ${entry}`;
    }

    case "nothing":
      return undefined;
  }
}
