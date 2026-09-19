import { describe, expect, it } from "vitest";
import { StuckOutputDetector } from "../../src/door/stuck.js";

describe("stuck relay output detector", () => {
  it("threshold is max(2 × pulseDuration, 3 s)", () => {
    expect(StuckOutputDetector.threshold(100)).toBe(3000);
    expect(StuckOutputDetector.threshold(1000)).toBe(3000);
    expect(StuckOutputDetector.threshold(2000)).toBe(4000);
    expect(StuckOutputDetector.threshold(null)).toBe(3000);
  });

  it("a single 'on' read or a normal pulse never counts as stuck", () => {
    const d = new StuckOutputDetector();
    expect(d.observe("on", 100, 0)).toEqual({ stuck: false, changed: false, onForMs: 0 });
    expect(d.observe("off", 100, 50).stuck).toBe(false);
    expect(d.observe("on", 100, 1000).stuck).toBe(false);
    expect(d.observe("on", 100, 3999).stuck).toBe(false); // 2999 ms on so far
    expect(d.isStuck()).toBe(false);
  });

  it("flags after the threshold across consecutive reads, once, and clears on off", () => {
    const d = new StuckOutputDetector();
    d.observe("on", 100, 0);
    expect(d.observe("on", 100, 3000)).toEqual({ stuck: true, changed: true, onForMs: 3000 });
    expect(d.observe("on", 100, 5000)).toEqual({ stuck: true, changed: false, onForMs: 5000 });
    expect(d.observe("off", 100, 5100)).toEqual({ stuck: false, changed: true, onForMs: 0 });
    expect(d.observe("off", 100, 5200).changed).toBe(false);
  });

  it("an 'off' read between two 'on' reads restarts the episode", () => {
    const d = new StuckOutputDetector();
    d.observe("on", 100, 0);
    d.observe("off", 100, 2000);
    d.observe("on", 100, 2500);
    expect(d.observe("on", 100, 5000).stuck).toBe(false); // only 2500 ms in this episode
    expect(d.observe("on", 100, 5500).stuck).toBe(true);
  });

  it("uses 2 × pulseDuration when the pulse is long", () => {
    const d = new StuckOutputDetector();
    d.observe("on", 2500, 0);
    expect(d.observe("on", 2500, 4000).stuck).toBe(false);
    expect(d.observe("on", 2500, 5000).stuck).toBe(true);
    d.reset();
    expect(d.isStuck()).toBe(false);
  });
});
