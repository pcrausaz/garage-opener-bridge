import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProtectSimulator, SIM_IDS } from "../../src/protect/simulator.js";

describe("protect simulator", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("opens and closes with travel time", async () => {
    const sim = new ProtectSimulator({ travelMs: 1000, tiltMs: 100, relayBehaviour: "pulse" });
    await sim.activateOutput(SIM_IDS.relayId, 0);
    expect(sim.isOpened).toBe(false);
    vi.advanceTimersByTime(150);
    expect(sim.isOpened).toBe(true);
    expect(sim.phase).toBe("opening");
    vi.advanceTimersByTime(1000);
    expect(sim.phase).toBe("open");
    await sim.activateOutput(SIM_IDS.relayId, 0);
    vi.advanceTimersByTime(999);
    expect(sim.isOpened).toBe(true);
    vi.advanceTimersByTime(1);
    expect(sim.isOpened).toBe(false);
    expect(sim.activations).toBe(2);
  });

  it("reverses on the next close when armed and stops on a pulse mid-travel", async () => {
    const sim = new ProtectSimulator({ travelMs: 1000, tiltMs: 100 });
    sim.pulse();
    vi.advanceTimersByTime(1100);
    sim.reverseNextClose = true;
    sim.pulse();
    vi.advanceTimersByTime(2000);
    expect(sim.isOpened).toBe(true);
    expect(sim.phase).toBe("open");
    sim.pulse();
    vi.advanceTimersByTime(300);
    sim.pulse();
    expect(sim.phase).toBe("stopped");
    sim.reset();
    expect(sim.phase).toBe("closed");
    expect(sim.isOpened).toBe(false);
  });

  it("rejects unknown devices", async () => {
    const sim = new ProtectSimulator();
    await expect(sim.activateOutput("nope", 0)).rejects.toThrow();
    await expect(sim.getSensor("nope")).rejects.toThrow();
    expect((await sim.getRelays())[0]?.outputs[0]?.type).toBe("garageDoor");
  });
});
