/**
 * Unit tests for queue types (src/queue/types.ts).
 * Covers state constants and display name mapping.
 */

import { describe, it, expect } from "vitest";
import { QUEUE_STATES, stateDisplayName } from "../src/queue/types.js";

describe("QUEUE_STATES", () => {
  it("has all six workflow states", () => {
    expect(QUEUE_STATES).toHaveLength(6);
  });

  it("states are in position order", () => {
    for (let i = 0; i < QUEUE_STATES.length; i++) {
      expect(QUEUE_STATES[i].position).toBe(i);
    }
  });

  it("includes expected queue states", () => {
    const states = QUEUE_STATES.map((s) => s.queueState);
    expect(states).toEqual([
      "triage",
      "backlog",
      "todo",
      "in_progress",
      "done",
      "cancelled",
    ]);
  });
});

describe("stateDisplayName", () => {
  it("maps known states to display names", () => {
    expect(stateDisplayName("triage")).toBe("Triage");
    expect(stateDisplayName("backlog")).toBe("Backlog");
    expect(stateDisplayName("todo")).toBe("Todo");
    expect(stateDisplayName("in_progress")).toBe("In Progress");
    expect(stateDisplayName("done")).toBe("Done");
    expect(stateDisplayName("cancelled")).toBe("Cancelled");
  });

  it("returns raw state for unknown states", () => {
    expect(stateDisplayName("unknown" as any)).toBe("unknown");
  });
});
