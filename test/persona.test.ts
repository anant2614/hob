import { describe, expect, it } from "vitest";
import { dateSection } from "../src/agent/persona";

describe("dateSection", () => {
  it("states the date in the owner's time zone", () => {
    expect(dateSection("UTC", new Date("2026-10-07T12:00:00Z"))).toBe("Today is Wednesday, 7 October 2026 (UTC).");
    expect(dateSection("Asia/Kolkata", new Date("2026-10-07T20:00:00Z"))).toBe(
      "Today is Thursday, 8 October 2026 (Asia/Kolkata)."
    );
  });

  it("falls back to UTC for an unknown time zone", () => {
    expect(dateSection("Nowhere/Special", new Date("2026-10-07T12:00:00Z"))).toBe(
      "Today is Wednesday, 7 October 2026 (UTC)."
    );
  });
});
