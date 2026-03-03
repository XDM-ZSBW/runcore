/**
 * Calendar capability — create, update, delete events via the local CalendarStore.
 * Google sync happens in the background via the adapter.
 */

import { getCalendarStore } from "../../calendar/store.js";
import { getGoogleCalendarAdapter } from "../../calendar/google-adapter.js";
import { logActivity } from "../../activity/log.js";
import { pushNotification } from "../../goals/notifications.js";
import { getInstanceName } from "../../instance.js";
import type { ActionBlockCapability, ActionContext, ActionExecutionResult } from "../types.js";

const actionLabel = (ctx: ActionContext) =>
  ctx.origin === "autonomous" ? "AUTONOMOUS" : "PROMPTED";

const reason = (ctx: ActionContext, verb: string) => {
  switch (ctx.origin) {
    case "email": return `${getInstanceName()} email triggered calendar ${verb}`;
    case "autonomous": return `planner ${verb}d calendar event`;
    default: return `AI ${verb}d calendar event via chat`;
  }
};

export const calendarCapability: ActionBlockCapability = {
  id: "calendar",
  pattern: "action",
  tag: "CALENDAR_ACTION",
  keywords: ["schedule", "calendar", "meeting", "event", "appointment", "agenda"],

  getPromptInstructions(ctx) {
    const name = ctx.name ?? "the user";
    return [
      `## Calendar (via [CALENDAR_ACTION] blocks)`,
      `To create, update, or delete calendar events, include a [CALENDAR_ACTION] block in your response.`,
      ``,
      `Create an event:`,
      `[CALENDAR_ACTION]`,
      `{"action": "create", "title": "Team standup", "start": "2026-03-02T09:00:00-08:00", "end": "2026-03-02T09:30:00-08:00", "description": "Daily sync", "location": "Zoom", "attendees": ["alice@example.com"]}`,
      `[/CALENDAR_ACTION]`,
      ``,
      `Update an event (requires eventId from calendar data):`,
      `[CALENDAR_ACTION]`,
      `{"action": "update", "eventId": "abc123", "title": "Renamed event", "start": "2026-03-02T10:00:00-08:00", "end": "2026-03-02T10:30:00-08:00"}`,
      `[/CALENDAR_ACTION]`,
      ``,
      `Delete an event:`,
      `[CALENDAR_ACTION]`,
      `{"action": "delete", "eventId": "abc123"}`,
      `[/CALENDAR_ACTION]`,
      ``,
      `Fields: title, start (ISO 8601), end (ISO 8601), description, location, attendees (email array), timeZone. For update/delete, eventId is required.`,
      `Create and update events without confirmation — just do it and mention what you did. Confirm with ${name} before deleting events (destructive). When calendar data is in context, use the real eventId values.`,
    ].join("\n");
  },

  getPromptOverride(origin) {
    if (origin === "email") {
      return [
        `## Calendar (via [CALENDAR_ACTION] blocks)`,
        `If someone asks to schedule a meeting, create an event, or set up an appointment — DO IT immediately with a [CALENDAR_ACTION] block.`,
        `[CALENDAR_ACTION]`,
        `{"action": "create", "title": "Meeting title", "start": "2026-03-05T10:00:00-08:00", "end": "2026-03-05T10:30:00-08:00", "description": "Notes", "attendees": ["email@example.com"]}`,
        `[/CALENDAR_ACTION]`,
        `For updates: {"action": "update", "eventId": "abc123", "title": "New title"}`,
        `For deletes: {"action": "delete", "eventId": "abc123"}`,
      ].join("\n");
    }
    if (origin === "autonomous") {
      return [
        `Create a calendar event:`,
        `[CALENDAR_ACTION]`,
        `{"action": "create", "title": "Meeting title", "start": "2026-03-05T10:00:00-08:00", "end": "2026-03-05T10:30:00-08:00", "description": "Notes", "attendees": ["email@example.com"]}`,
        `[/CALENDAR_ACTION]`,
        ``,
        `Update an event:`,
        `[CALENDAR_ACTION]`,
        `{"action": "update", "eventId": "abc123", "title": "New title", "start": "..."}`,
        `[/CALENDAR_ACTION]`,
        ``,
        `Delete an event:`,
        `[CALENDAR_ACTION]`,
        `{"action": "delete", "eventId": "abc123"}`,
        `[/CALENDAR_ACTION]`,
      ].join("\n");
    }
    return null;
  },

  async execute(payload, ctx): Promise<ActionExecutionResult> {
    const store = getCalendarStore();
    if (!store) return { capabilityId: "calendar", ok: false, message: "Calendar store not initialized" };

    const req = payload as Record<string, any>;
    const label = actionLabel(ctx);
    const adapter = getGoogleCalendarAdapter();

    if (req.action === "create" && req.title && req.start && req.end) {
      try {
        const event = await store.create({
          title: req.title,
          start: req.start,
          end: req.end,
          description: req.description,
          location: req.location,
          attendees: req.attendees?.map((email: string) => ({
            email,
            role: "required" as const,
            status: "needs-action" as const,
          })),
          recurrence: req.recurrence,
          timezone: req.timeZone,
          source: "manual",
        });

        // Push to Google in background
        if (adapter.isAvailable()) {
          adapter.push(event).catch(() => {});
        }

        logActivity({ source: "calendar", summary: `Created event${ctx.origin === "email" ? " via email" : ""}: ${req.title}`, actionLabel: label, reason: reason(ctx, "create") });
        pushNotification({ timestamp: new Date().toISOString(), source: "calendar", message: `Created calendar event: **${req.title}** (${new Date(req.start).toLocaleString()})` });
        return { capabilityId: "calendar", ok: true, message: `Created event: ${req.title}` };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logActivity({ source: "calendar", summary: `Failed to create event${ctx.origin === "email" ? " via email" : ""}: ${msg}`, actionLabel: label, reason: reason(ctx, "create") });
        if (ctx.origin === "chat") {
          pushNotification({ timestamp: new Date().toISOString(), source: "calendar", message: `Failed to create event "${req.title}": ${msg}` });
        }
        return { capabilityId: "calendar", ok: false, message: msg };
      }
    }

    if (req.action === "update" && req.eventId) {
      try {
        const { action: _, eventId, ...changes } = req;
        const event = await store.update(eventId, changes);
        if (!event) return { capabilityId: "calendar", ok: false, message: `Event not found: ${eventId}` };

        // Push to Google in background
        if (adapter.isAvailable() && event.externalIds.google) {
          adapter.push(event).catch(() => {});
        }

        logActivity({ source: "calendar", summary: `Updated event${ctx.origin === "email" ? " via email" : ""}: ${eventId}`, actionLabel: label, reason: reason(ctx, "update") });
        if (ctx.origin === "chat") {
          pushNotification({ timestamp: new Date().toISOString(), source: "calendar", message: `Updated calendar event${req.title ? `: **${req.title}**` : ""}` });
        }
        return { capabilityId: "calendar", ok: true, message: `Updated event: ${eventId}` };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logActivity({ source: "calendar", summary: `Failed to update event: ${msg}`, actionLabel: label, reason: reason(ctx, "update") });
        if (ctx.origin === "chat") {
          pushNotification({ timestamp: new Date().toISOString(), source: "calendar", message: `Failed to update event: ${msg}` });
        }
        return { capabilityId: "calendar", ok: false, message: msg };
      }
    }

    if (req.action === "delete" && req.eventId) {
      try {
        const event = await store.cancel(req.eventId);
        if (!event) return { capabilityId: "calendar", ok: false, message: `Event not found: ${req.eventId}` };

        // Remove from Google in background
        if (adapter.isAvailable() && event.externalIds.google) {
          adapter.remove(event.externalIds.google).catch(() => {});
        }

        logActivity({ source: "calendar", summary: `Deleted event${ctx.origin === "email" ? " via email" : ""}: ${req.eventId}`, actionLabel: label, reason: reason(ctx, "delete") });
        if (ctx.origin === "chat") {
          pushNotification({ timestamp: new Date().toISOString(), source: "calendar", message: `Deleted calendar event` });
        }
        return { capabilityId: "calendar", ok: true, message: `Deleted event: ${req.eventId}` };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logActivity({ source: "calendar", summary: `Failed to delete event: ${msg}`, actionLabel: label, reason: reason(ctx, "delete") });
        if (ctx.origin === "chat") {
          pushNotification({ timestamp: new Date().toISOString(), source: "calendar", message: `Failed to delete event: ${msg}` });
        }
        return { capabilityId: "calendar", ok: false, message: msg };
      }
    }

    return { capabilityId: "calendar", ok: false, message: "Unknown or incomplete calendar action" };
  },
};
