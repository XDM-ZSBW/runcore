/**
 * Tests for the temporal validation layer (ts_temporal_mismatch_01).
 *
 * Core bug: new Date('2026-03-04') parses as UTC midnight.
 * In US timezones (behind UTC), getDay() shifts backward by 1,
 * returning Tuesday (2) instead of Wednesday (3).
 *
 * The temporal layer uses local-time constructors to avoid this.
 */

import { describe, it, expect } from "vitest";
import {
  parseDateSafe,
  getDayOfWeek,
  getDayOfWeekIndex,
  validateDayOfWeek,
  validateCalendarEntry,
  toSafeDueDate,
} from "../src/google/temporal.js";

// ---------------------------------------------------------------------------
// parseDateSafe
// ---------------------------------------------------------------------------

describe("parseDateSafe", () => {
  it("parses YYYY-MM-DD without UTC shift", () => {
    const d = parseDateSafe("2026-03-04");
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(2); // 0-indexed: March = 2
    expect(d.getDate()).toBe(4);
  });

  it("parses ISO datetime strings using only the date portion", () => {
    const d = parseDateSafe("2026-03-04T11:30:00Z");
    expect(d.getDate()).toBe(4);
  });

  it("throws on unparseable strings", () => {
    expect(() => parseDateSafe("not-a-date")).toThrow("Cannot parse date");
  });
});

// ---------------------------------------------------------------------------
// getDayOfWeek — the original bug
// ---------------------------------------------------------------------------

describe("getDayOfWeek", () => {
  it("March 4, 2026 is Wednesday (not Tuesday)", () => {
    // This is the exact case that triggered ts_temporal_mismatch_01
    expect(getDayOfWeek("2026-03-04")).toBe("wednesday");
  });

  it("returns correct days for known dates", () => {
    // 2026-01-01 is Thursday
    expect(getDayOfWeek("2026-01-01")).toBe("thursday");
    // 2026-02-28 is Saturday
    expect(getDayOfWeek("2026-02-28")).toBe("saturday");
    // 2026-12-25 is Friday
    expect(getDayOfWeek("2026-12-25")).toBe("friday");
  });

  it("handles ISO datetime strings correctly", () => {
    expect(getDayOfWeek("2026-03-04T00:00:00.000Z")).toBe("wednesday");
    expect(getDayOfWeek("2026-03-04T23:59:59Z")).toBe("wednesday");
  });
});

// ---------------------------------------------------------------------------
// getDayOfWeekIndex
// ---------------------------------------------------------------------------

describe("getDayOfWeekIndex", () => {
  it("returns 3 (Wednesday) for 2026-03-04", () => {
    expect(getDayOfWeekIndex("2026-03-04")).toBe(3);
  });

  it("returns 0 for a known Sunday", () => {
    // 2026-03-01 is Sunday
    expect(getDayOfWeekIndex("2026-03-01")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// validateDayOfWeek
// ---------------------------------------------------------------------------

describe("validateDayOfWeek", () => {
  it("detects the March 4 mismatch", () => {
    const result = validateDayOfWeek("2026-03-04", "Tuesday");
    expect(result.valid).toBe(false);
    expect(result.actualDay).toBe("wednesday");
    expect(result.expectedDay).toBe("tuesday");
    expect(result.mismatch).toContain("wednesday, not tuesday");
  });

  it("validates correct day-of-week", () => {
    const result = validateDayOfWeek("2026-03-04", "Wednesday");
    expect(result.valid).toBe(true);
    expect(result.actualDay).toBe("wednesday");
    expect(result.mismatch).toBeUndefined();
  });

  it("accepts abbreviated day names", () => {
    expect(validateDayOfWeek("2026-03-04", "Wed").valid).toBe(true);
    expect(validateDayOfWeek("2026-03-04", "wed").valid).toBe(true);
    expect(validateDayOfWeek("2026-03-04", "Tue").valid).toBe(false);
  });

  it("rejects unrecognized day names", () => {
    const result = validateDayOfWeek("2026-03-04", "Xday");
    expect(result.valid).toBe(false);
    expect(result.mismatch).toContain("Unrecognized day name");
  });

  it("rejects unparseable dates", () => {
    const result = validateDayOfWeek("garbage", "Monday");
    expect(result.valid).toBe(false);
    expect(result.mismatch).toContain("Cannot parse date");
  });
});

// ---------------------------------------------------------------------------
// validateCalendarEntry
// ---------------------------------------------------------------------------

describe("validateCalendarEntry", () => {
  it("passes when no expectedDayOfWeek is provided", () => {
    const result = validateCalendarEntry("2026-03-04");
    expect(result.ok).toBe(true);
  });

  it("passes when day-of-week matches", () => {
    const result = validateCalendarEntry("2026-03-04", "Wednesday");
    expect(result.ok).toBe(true);
  });

  it("rejects mismatched day-of-week with suggestion", () => {
    const result = validateCalendarEntry("2026-03-04", "Tuesday");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("Temporal mismatch");
      expect(result.suggestion).toContain("tuesday");
      expect(result.suggestion).toContain("2026-03-03"); // nearest Tuesday
    }
  });
});

// ---------------------------------------------------------------------------
// toSafeDueDate
// ---------------------------------------------------------------------------

describe("toSafeDueDate", () => {
  it("extracts date from ISO string without shift", () => {
    expect(toSafeDueDate("2026-03-04")).toBe("2026-03-04T00:00:00.000Z");
    expect(toSafeDueDate("2026-03-04T15:30:00Z")).toBe("2026-03-04T00:00:00.000Z");
  });

  it("handles Date objects using local getters", () => {
    const d = new Date(2026, 2, 4); // local March 4
    const result = toSafeDueDate(d);
    expect(result).toBe("2026-03-04T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// Regression: demonstrate the original bug would fail
// ---------------------------------------------------------------------------

describe("regression: UTC midnight shift", () => {
  it("demonstrates the original bug path", () => {
    // This is what the OLD code did (and it was WRONG in US timezones):
    const buggyDate = new Date("2026-03-04"); // UTC midnight
    const buggyDay = buggyDate.getDay(); // local timezone → can be Tuesday

    // The FIXED code:
    const fixedDay = getDayOfWeekIndex("2026-03-04"); // always Wednesday

    // In UTC+ timezones, buggyDay might equal fixedDay.
    // In UTC- timezones (US), buggyDay === 2 (Tuesday), fixedDay === 3 (Wednesday).
    // Either way, the fixed path must always return 3.
    expect(fixedDay).toBe(3);
  });
});
