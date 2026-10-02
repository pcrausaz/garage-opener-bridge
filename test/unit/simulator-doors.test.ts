import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProtectSimulator, SIM_IDS, SIM_IDS_2 } from "../../src/protect/simulator.js";

describe("simulator with two doors (MOCK_DOORS=2)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("one door by default: output 1 is not a door and there is one sensor", async () => {
    const sim = new ProtectSimulator();
    expect((await sim.getSensors()).map((s) => s.name)).toEqual(["Garage Door State (mock)"]);
    expect((await sim.getRelays())[0]!.outputs[1]).toMatchObject({ id: 1, name: null, type: null });
    await expect(sim.activateOutput(SIM_IDS.relayId, 1)).rejects.toThrow("not found");
    await expect(sim.getSensor(SIM_IDS_2.sensorId)).rejects.toThrow("not found");
  });

  it("two doors: a second garageDoor output and its own sensor, moving independently", async () => {
    const sim = new ProtectSimulator({ doors: 2, travelMs: 1000, tiltMs: 100, relayBehaviour: "pulse" });
    expect((await sim.getRelays())[0]!.outputs.map((o) => [o.id, o.type])).toEqual([[0, "garageDoor"], [1, "garageDoor"]]);
    expect((await sim.getSensors()).map((s) => s.id)).toEqual([SIM_IDS.sensorId, SIM_IDS_2.sensorId]);

    await sim.activateOutput(SIM_IDS_2.relayId, SIM_IDS_2.outputId);
    vi.advanceTimersByTime(1100);
    expect((await sim.getSensor(SIM_IDS_2.sensorId)).isOpened).toBe(true);
    expect((await sim.getSensor(SIM_IDS.sensorId)).isOpened).toBe(false);
    expect(sim.phase).toBe("closed"); // the legacy fields are the first door's
    expect(sim.doors[1]!.phase).toBe("open");
    expect([sim.activations, sim.doors[1]!.activations]).toEqual([0, 1]);

    sim.doors[1]!.reverseNextClose = true;
    expect(sim.reverseNextClose).toBe(false);
    sim.reset();
    expect(sim.doors.map((d) => d.phase)).toEqual(["closed", "closed"]);
  });

  it("toggle relay: each output keeps its own on/off state", async () => {
    const sim = new ProtectSimulator({ doors: 2 });
    await sim.activateOutput(SIM_IDS.relayId, 1);
    expect((await sim.getRelay(SIM_IDS.relayId)).outputs.map((o) => o.state)).toEqual(["off", "on"]);
    expect(sim.doors.map((d) => d.phase)).toEqual(["closed", "opening"]);
  });
});
