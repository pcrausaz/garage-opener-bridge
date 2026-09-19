import { describe, expect, it } from "vitest";
import { discover, suggestMapping } from "../../src/discovery.js";
import { ProtectSimulator, SIM_IDS } from "../../src/protect/simulator.js";
import { loadFixture } from "../protect-mock-server.js";
import type { ProtectCamera, ProtectRelay, ProtectSensor } from "../../src/protect/types.js";

describe("discovery", () => {
  it("auto-pairs the single pulse output with the single garage sensor from live fixtures", () => {
    const relays = loadFixture<ProtectRelay[]>("relays.json");
    const sensors = loadFixture<ProtectSensor[]>("sensors.json");
    const cameras = loadFixture<ProtectCamera[]>("cameras.json");
    const m = suggestMapping({
      relays: relays.map((r) => ({ id: r.id, name: r.name, connected: true, outputs: r.outputs.map((o) => ({ id: o.id, name: o.name, type: o.type, pulseDurationMs: o.pulseDuration })) })),
      sensors: sensors.map((s) => ({ id: s.id, name: s.name, mountType: s.mountType, isOpened: s.isOpened, connected: true })),
      cameras: cameras.map((c) => ({ id: c.id, name: c.name, smartDetectTypes: c.smartDetectSettings?.objectTypes ?? [] })),
    });
    expect(m).toEqual({
      relayId: "6aa43ec903253903e401d542",
      outputId: 0,
      sensorId: "6609938d012d0803e408748d",
      interiorCameraId: "650b2b3c03738b03e4013954",
      drivewayCameraId: "64dd4c4303e52b03e4008041",
    });
  });

  it("requires explicit mapping when ambiguous", () => {
    const base = { relays: [{ id: "r", name: "r", connected: true, outputs: [{ id: 0, name: "a", type: "garageDoor", pulseDurationMs: 100 }, { id: 1, name: "b", type: "garageDoor", pulseDurationMs: 100 }] }], sensors: [{ id: "s", name: "s", mountType: "garage", isOpened: false, connected: true }], cameras: [] };
    expect(suggestMapping(base)).toBeNull();
  });

  it("discover() honours saved and explicit mappings", async () => {
    const sim = new ProtectSimulator();
    const auto = await discover(sim, null, {});
    expect(auto.autoPaired).toBe(true);
    expect(auto.current?.relayId).toBe(SIM_IDS.relayId);
    const explicit = await discover(sim, null, { relayId: "x", outputId: 1, sensorId: "y" });
    expect(explicit.autoPaired).toBe(false);
    expect(explicit.current).toMatchObject({ relayId: "x", outputId: 1, sensorId: "y", interiorCameraId: SIM_IDS.interiorCameraId });
    const saved = await discover(sim, { relayId: "s", outputId: 0, sensorId: "t", interiorCameraId: null, drivewayCameraId: null }, {});
    expect(saved.current?.relayId).toBe("s");
  });
});
