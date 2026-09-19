import { describe, expect, it } from "vitest";
import { RateGate, normalizeFingerprint } from "../../src/protect/client.js";

describe("protect rate gate", () => {
  it("never lets more than N calls through per second", async () => {
    let t = 0;
    const gate = new RateGate(3, () => t);
    const origSetTimeout = globalThis.setTimeout;
    // advance fake time instead of sleeping
    globalThis.setTimeout = ((fn: () => void, ms: number) => {
      t += ms;
      fn();
      return 0 as unknown as NodeJS.Timeout;
    }) as unknown as typeof setTimeout;
    try {
      const stamps: number[] = [];
      for (let i = 0; i < 7; i++) {
        await gate.wait();
        stamps.push(t);
      }
      for (const s of stamps) expect(stamps.filter((x) => x >= s && x < s + 1000).length).toBeLessThanOrEqual(3);
    } finally {
      globalThis.setTimeout = origSetTimeout;
    }
  });
  it("normalizes fingerprints", () => {
    expect(normalizeFingerprint("fingerprint:ab:cd:EF")).toBe("ABCDEF");
  });
});
