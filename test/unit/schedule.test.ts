import { describe, expect, it } from "vitest";
import { msUntilNext } from "../../src/alerts/schedule.js";

describe("nightly schedule", () => {
  it("computes the next HH:MM in UTC", () => {
    const now = Date.UTC(2026, 8, 18, 21, 0, 0);
    expect(msUntilNext("22:00", "UTC", now)).toBe(3_600_000);
    expect(msUntilNext("20:00", "UTC", now)).toBe(23 * 3_600_000);
  });
  it("respects time zones", () => {
    const now = Date.UTC(2026, 8, 19, 2, 0, 0); // 21:00 in Chicago (CDT, UTC-5)
    expect(msUntilNext("22:00", "America/Chicago", now)).toBe(3_600_000);
    const paris = Date.UTC(2026, 8, 18, 19, 30, 0); // 21:30 CEST
    expect(msUntilNext("22:00", "Europe/Paris", paris)).toBe(30 * 60_000);
  });
});
