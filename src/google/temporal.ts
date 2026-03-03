/**
 * Temporal validation layer.
 * Catches day-of-week mismatches before calendar entries are created.
 * Fixes ts_temporal_mismatch_01: March 4, 2026 is Wednesday, not Tuesday.
 *
 * Root cause: new Date('2026-03-04') parses as UTC midnight.
 * getDay() returns local-timezone day, which can shift backward by 1
 * in timezones behind UTC. All date math must use UTC methods on
 * UTC-parsed strings, or local methods on locally-constructed dates.
 */

import { createLogger } from "../utils/logger.js";

const log = createLogger("google.temporal");

const DAY_NAMES = [
  "sunday", "monday", "tuesday", "wednesday",
  "thursday", "friday", "saturday",
] as const;

export type DayName = (typeof DAY_NAMES)[number];

export interface TemporalValidation {
  valid: boolean;
  /** The actual day-of-week for the given date */
  actualDay: string;
  /** The expected day-of-week (if provided) */
  expectedDay?: string;
  /** ISO date string (YYYY-MM-DD) */
  date: string;
  /** Mismatch details (only if invalid) */
  mismatch?: string;
}

/**
 * Parse a date string into year/month/day without timezone ambiguity.
 * Extracts the date portion and constructs using local-time constructor
 * to avoid the UTC-midnight-shifts-to-previous-day bug.
 */
export function parseDateSafe(dateStr: string): Date {
  // Extract YYYY-MM-DD from any ISO string or date-only string
  const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) {
    throw new Error(`Cannot parse date from: ${dateStr}`);
  }
  const [, year, month, day] = match;
  // Use the (year, monthIndex, day) constructor — this uses LOCAL time,
  // so getDay() will match the calendar date the user intended.
  return new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
}

/**
 * Get the day-of-week name for a date string, correctly.
 * Uses parseDateSafe to avoid UTC/local timezone mismatch.
 */
export function getDayOfWeek(dateStr: string): string {
  const d = parseDateSafe(dateStr);
  return DAY_NAMES[d.getDay()];
}

/**
 * Get the day-of-week index (0=Sunday, 6=Saturday) for a date string.
 */
export function getDayOfWeekIndex(dateStr: string): number {
  return parseDateSafe(dateStr).getDay();
}

/**
 * Normalize a day name to lowercase for comparison.
 * Accepts full names ("Wednesday") and abbreviations ("Wed").
 */
function normalizeDayName(name: string): DayName | null {
  const lower = name.toLowerCase().trim();
  // Exact match
  const exact = DAY_NAMES.find((d) => d === lower);
  if (exact) return exact;
  // Prefix match (at least 3 chars: "mon", "tue", "wed", etc.)
  if (lower.length >= 3) {
    const prefix = DAY_NAMES.find((d) => d.startsWith(lower));
    if (prefix) return prefix;
  }
  return null;
}

/**
 * Validate that a date string falls on the expected day-of-week.
 *
 * @param dateStr - ISO date or datetime string (e.g., "2026-03-04" or "2026-03-04T11:00:00")
 * @param expectedDay - Expected day name (e.g., "Tuesday", "Wed")
 * @returns Validation result with actual vs expected day
 *
 * @example
 * validateDayOfWeek("2026-03-04", "Tuesday")
 * // { valid: false, actualDay: "wednesday", expectedDay: "tuesday", date: "2026-03-04",
 * //   mismatch: "2026-03-04 is wednesday, not tuesday" }
 *
 * validateDayOfWeek("2026-03-04", "Wednesday")
 * // { valid: true, actualDay: "wednesday", expectedDay: "wednesday", date: "2026-03-04" }
 */
export function validateDayOfWeek(
  dateStr: string,
  expectedDay: string,
): TemporalValidation {
  const match = dateStr.match(/^(\d{4}-\d{2}-\d{2})/);
  if (!match) {
    return {
      valid: false,
      actualDay: "unknown",
      expectedDay: expectedDay.toLowerCase(),
      date: dateStr,
      mismatch: `Cannot parse date from: ${dateStr}`,
    };
  }

  const dateOnly = match[1];
  const actualDay = getDayOfWeek(dateStr);
  const normalizedExpected = normalizeDayName(expectedDay);

  if (!normalizedExpected) {
    return {
      valid: false,
      actualDay,
      expectedDay: expectedDay.toLowerCase(),
      date: dateOnly,
      mismatch: `Unrecognized day name: ${expectedDay}`,
    };
  }

  const valid = actualDay === normalizedExpected;
  return {
    valid,
    actualDay,
    expectedDay: normalizedExpected,
    date: dateOnly,
    ...(valid ? {} : {
      mismatch: `${dateOnly} is ${actualDay}, not ${normalizedExpected}`,
    }),
  };
}

/**
 * Validate a calendar event's start date before creation.
 * If expectedDayOfWeek is provided (from user input or LLM parsing),
 * cross-checks it against the actual calendar date.
 *
 * Returns { ok: true } if valid, or { ok: false, message, suggestion } if mismatched.
 */
export function validateCalendarEntry(
  startDateStr: string,
  expectedDayOfWeek?: string,
): { ok: true } | { ok: false; message: string; suggestion: string } {
  if (!expectedDayOfWeek) return { ok: true };

  const result = validateDayOfWeek(startDateStr, expectedDayOfWeek);
  if (result.valid) return { ok: true };

  // Find the correct date for the expected day within ±3 days
  const suggestion = findCorrectDate(startDateStr, expectedDayOfWeek);

  return {
    ok: false,
    message: `Temporal mismatch: ${result.mismatch}`,
    suggestion,
  };
}

/**
 * Given a date and the intended day-of-week, find the nearest date
 * that actually falls on that day (within ±3 days).
 */
function findCorrectDate(dateStr: string, intendedDay: string): string {
  const target = normalizeDayName(intendedDay);
  if (!target) return `Could not resolve day name: ${intendedDay}`;

  const targetIndex = DAY_NAMES.indexOf(target);
  const base = parseDateSafe(dateStr);

  for (let offset = -3; offset <= 3; offset++) {
    const candidate = new Date(base);
    candidate.setDate(base.getDate() + offset);
    if (candidate.getDay() === targetIndex) {
      const yyyy = candidate.getFullYear();
      const mm = String(candidate.getMonth() + 1).padStart(2, "0");
      const dd = String(candidate.getDate()).padStart(2, "0");
      return `Did you mean ${target} ${yyyy}-${mm}-${dd}?`;
    }
  }

  return `No ${target} found within ±3 days of ${dateStr}`;
}

/**
 * Safe conversion to Google Tasks due date format.
 * Extracts YYYY-MM-DD from the string directly, avoiding the
 * UTC-midnight-to-local-time shift bug in toDueDate.
 */
export function toSafeDueDate(date: string | Date): string {
  if (typeof date === "string") {
    const match = date.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (match) {
      return `${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z`;
    }
  }
  // For Date objects or non-ISO strings, use local-time getters
  const d = typeof date === "string" ? new Date(date) : date;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T00:00:00.000Z`;
}
