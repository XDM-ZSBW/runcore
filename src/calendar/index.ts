/**
 * Calendar module — native calendar primitive with adapter-based sync.
 */

export { CalendarStore, createCalendarStore, getCalendarStore } from "./store.js";
export { GoogleCalendarAdapter, getGoogleCalendarAdapter } from "./google-adapter.js";
export { calendarRoutes } from "./routes.js";
export type {
  CalendarEvent,
  Calendar,
  CalendarSource,
  CalendarAdapter,
  SyncResult,
  EventFilter,
  FreeBusySlot,
} from "./types.js";
