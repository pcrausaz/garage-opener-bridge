import { describe, expect, it } from "vitest";
import { discover, pairingAsEnv, suggestMapping, suggestPairing } from "../../src/discovery.js";
import { ProtectSimulator, SIM_IDS, SIM_IDS_2 } from "../../src/protect/simulator.js";

const devices = (outputs: [string, string], sensors: [string, string]) => ({
  relays: [{ id: "r", name: "Garage Relay", connected: true, outputs: outputs.map((name, id) => ({ id, name, type: "garageDoor", pulseDurationMs: 100 })) }],
  sensors: sensors.map((name, i) => ({ id: `s${i}`, name, mountType: "garage", isOpened: false, connected: true })),
  cameras: [{ id: "cam", name: "Garage", smartDetectTypes: ["vehicle"] }],
});

describe("two door outputs and two garage sensors (ADR-0020)", () => {
  it("are never auto-paired: the single-door suggestion stays empty", () => {
    expect(suggestMapping(devices(["Left Door", "Right Door"], ["Left Door State", "Right Door State"]))).toBeNull();
  });

  it("suggests a pairing from the names, in output order, sharing the cameras", () => {
    const d = devices(["Left Door", "Right Door"], ["Left Door State", "Right Door State"]);
    expect(suggestPairing(d)).toEqual([
      { relayId: "r", outputId: 0, sensorId: "s0", interiorCameraId: "cam", drivewayCameraId: null },
      { relayId: "r", outputId: 1, sensorId: "s1", interiorCameraId: "cam", drivewayCameraId: null },
    ]);
  });

  it("follows the names, not the order the console lists the sensors in", () => {
    const d = devices(["Pascal's Door", "Margo's Door"], ["Garage Sensor Margo's", "Garage Sensor Pascal's"]);
    expect(suggestPairing(d)!.map((m) => [m.outputId, m.sensorId])).toEqual([[0, "s1"], [1, "s0"]]);
  });

  it("suggests nothing when the names do not decide it", () => {
    expect(suggestPairing(devices(["Garage Door", "Garage Door 2"], ["Sensor A", "Sensor B"]))).toBeNull();
    expect(suggestPairing(devices(["Door", "Door"], ["Garage Door State", "Garage Door State"]))).toBeNull();
  });

  it("is only for exactly two of each", () => {
    const one = devices(["Left Door", "Right Door"], ["Left Door State", "Right Door State"]);
    one.sensors.pop();
    expect(suggestPairing(one)).toBeNull();
  });

  it("is written out as settings to paste", () => {
    const d = devices(["Left Door", "Right Door"], ["Left Door State", "Right Door State"]);
    expect(pairingAsEnv(suggestPairing(d)!)).toEqual(["DOOR_RELAY_ID=r", "DOOR_OUTPUT_ID=0", "DOOR_SENSOR_ID=s0", "DOOR2_RELAY_ID=r", "DOOR2_OUTPUT_ID=1", "DOOR2_SENSOR_ID=s1"]);
  });

  it("discover() on a two-door console resolves nothing by itself and carries the suggestion", async () => {
    const sim = new ProtectSimulator({ doors: 2 });
    const d = await discover(sim, null, {});
    expect(d.suggested).toBeNull();
    expect(d.current).toBeNull();
    expect(d.autoPaired).toBe(false);
    expect(d.suggestedDoors!.map((m) => [m.outputId, m.sensorId])).toEqual([[SIM_IDS.outputId, SIM_IDS.sensorId], [SIM_IDS_2.outputId, SIM_IDS_2.sensorId]]);
    await sim.close();
  });

  it("discover() on a one-door console has no pairing to suggest", async () => {
    const sim = new ProtectSimulator();
    expect((await discover(sim, null, {})).suggestedDoors).toBeNull();
    await sim.close();
  });
});
