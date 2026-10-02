import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProtectSimulator, SIM_IDS } from "../../src/protect/simulator.js";
import { ILLUSTRATION_SIZE, drawGarage } from "../../src/mock/illustration.js";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("mock camera snapshot (ADR-0021)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("the snapshot is a drawing that follows the door: closed, part-way and open all differ", async () => {
    const sim = new ProtectSimulator({ travelMs: 1000, tiltMs: 100, relayBehaviour: "pulse" });
    const shot = async () => (await sim.getCameraSnapshot(SIM_IDS.interiorCameraId)).body;
    const closed = await shot();
    expect((await sim.getCameraSnapshot(SIM_IDS.interiorCameraId)).contentType).toBe("image/png");
    expect(closed.subarray(0, 8)).toEqual(PNG_MAGIC);
    expect(closed.readUInt32BE(16)).toBe(ILLUSTRATION_SIZE.width);
    expect(closed.readUInt32BE(20)).toBe(ILLUSTRATION_SIZE.height);
    expect(closed.length).toBeLessThan(4000); // a drawing, not a photograph
    expect(await shot()).toEqual(closed); // deterministic

    sim.pulse();
    vi.advanceTimersByTime(500);
    const halfway = await shot();
    expect(sim.doors[0]!.position()).toBeCloseTo(0.5, 1);
    vi.advanceTimersByTime(600);
    const open = await shot();
    expect(sim.doors[0]!.position()).toBe(1);
    expect(halfway).not.toEqual(closed);
    expect(open).not.toEqual(closed);
    expect(open).not.toEqual(halfway);

    // A stop freezes the picture where the door is.
    sim.pulse();
    vi.advanceTimersByTime(250);
    sim.pulse();
    expect(sim.phase).toBe("stopped");
    const at = sim.doors[0]!.position();
    vi.advanceTimersByTime(5000);
    expect(sim.doors[0]!.position()).toBe(at);
    await expect(sim.getCameraSnapshot("nope")).rejects.toMatchObject({ status: 404 });
  });

  it("a shared camera shows both doors, each at its own height", () => {
    expect(drawGarage([0, 0])).not.toEqual(drawGarage([0, 1]));
    expect(drawGarage([0, 1])).not.toEqual(drawGarage([1, 0]));
  });
});
