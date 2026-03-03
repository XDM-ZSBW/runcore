/**
 * Calendar context provider — injects today's schedule into the LLM prompt
 * when the user mentions calendar-related keywords.
 * Reads from the local CalendarStore (works offline, no Google dependency).
 */

import { getCalendarStore } from "../../calendar/store.js";
import type { ContextProviderCapability, ContextInjection, ActionContext } from "../types.js";

export const calendarContextProvider: ContextProviderCapability = {
  id: "calendar-context",
  pattern: "context",
  keywords: ["schedule", "calendar", "event", "meeting", "agenda", "free", "busy", "available", "when am i"],

  getPromptInstructions(_ctx: ActionContext): string {
    return ""; // Context providers inject data, not prompt instructions
  },

  shouldInject(message: string): boolean {
    const store = getCalendarStore();
    if (!store) return false;
    const keywords = /\b(schedule|calendar|events?|meetings?|agenda|free|busy|available|when am i)\b/i;
    return keywords.test(message);
  },

  async getContext(_message: string): Promise<ContextInjection | null> {
    const store = getCalendarStore();
    if (!store) return null;

    const events = await store.getTodayEvents();
    if (events.length === 0) return null;

    const dateLabel = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
    const formatted = store.formatEventsForContext(events);

    return {
      label: "Today's calendar",
      content: [
        `--- Today's calendar (${dateLabel}) ---`,
        formatted,
        `--- End calendar ---`,
        `Use this schedule to answer the user's question about their day, meetings, or availability.`,
      ].join("\n"),
    };
  },
};
