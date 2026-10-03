import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doorSpecs, loadConfig, platesByDoor } from "../../src/config.js";

const mock = (env: Record<string, string> = {}, file?: string) => loadConfig({ BRIDGE_MODE: "mock", ...env }, file);

describe("doors in the configuration (ADR-0020)", () => {
  it("compatibility: a 0.5-style configuration is exactly one door, d1", () => {
    // Nothing door-related at all: d1 is discovered or restored from the saved mapping, as before.
    expect(doorSpecs(mock())).toEqual([{ id: "d1", travelSeconds: 15, verifyAfterSeconds: 3 }]);
    // The five DOOR_* settings a 0.5 install could have.
    const pinned = doorSpecs(mock({ DOOR_RELAY_ID: "r", DOOR_OUTPUT_ID: "0", DOOR_SENSOR_ID: "s", DOOR_INTERIOR_CAMERA_ID: "c1", DOOR_DRIVEWAY_CAMERA_ID: "c2", DOOR_TRAVEL_SECONDS: "20" }));
    expect(pinned).toEqual([{ id: "d1", relayId: "r", outputId: 0, sensorId: "s", interiorCameraId: "c1", drivewayCameraId: "c2", travelSeconds: 20, verifyAfterSeconds: 3 }]);
    expect(mock().bridge.mockDoors).toBe(1);
  });

  it("DOOR2_* adds d2, with its own name and timings that default to d1's", () => {
    const specs = doorSpecs(mock({ DOOR_NAME: "Left", DOOR_TRAVEL_SECONDS: "12", DOOR2_NAME: " Right ", DOOR2_RELAY_ID: "r", DOOR2_OUTPUT_ID: "1", DOOR2_SENSOR_ID: "s2", DOOR2_INTERIOR_CAMERA_ID: "cam" }));
    expect(specs.map((s) => s.id)).toEqual(["d1", "d2"]);
    expect(specs[0]).toMatchObject({ name: "Left", travelSeconds: 12 });
    expect(specs[1]).toEqual({ id: "d2", name: "Right", relayId: "r", outputId: 1, sensorId: "s2", interiorCameraId: "cam", travelSeconds: 12, verifyAfterSeconds: 3 });
    expect(doorSpecs(mock({ DOOR2_RELAY_ID: "r", DOOR2_OUTPUT_ID: "1", DOOR2_SENSOR_ID: "s2", DOOR2_TRAVEL_SECONDS: "25" }))[1]!.travelSeconds).toBe(25);
  });

  it("refuses a second door without its relay, output or its own sensor, naming what is missing", () => {
    expect(() => mock({ DOOR2_NAME: "Right" })).toThrow(/d2 is incomplete: set DOOR2_RELAY_ID, DOOR2_OUTPUT_ID, DOOR2_SENSOR_ID/);
    expect(() => mock({ DOOR2_RELAY_ID: "r", DOOR2_OUTPUT_ID: "1" })).toThrow(/set DOOR2_SENSOR_ID.*own garage-mounted sensor/);
  });

  it("refuses two doors on one sensor or on one relay output", () => {
    const d1 = { DOOR_RELAY_ID: "r", DOOR_OUTPUT_ID: "0", DOOR_SENSOR_ID: "s" };
    expect(() => mock({ ...d1, DOOR2_RELAY_ID: "r", DOOR2_OUTPUT_ID: "1", DOOR2_SENSOR_ID: "s" })).toThrow(/same sensor/);
    expect(() => mock({ ...d1, DOOR2_RELAY_ID: "r", DOOR2_OUTPUT_ID: "0", DOOR2_SENSOR_ID: "s2" })).toThrow(/same relay output/);
    // Two outputs on one relay and one output on each of two relays are the same case.
    expect(() => mock({ ...d1, DOOR2_RELAY_ID: "r", DOOR2_OUTPUT_ID: "1", DOOR2_SENSOR_ID: "s2" })).not.toThrow();
    expect(() => mock({ ...d1, DOOR2_RELAY_ID: "other", DOOR2_OUTPUT_ID: "0", DOOR2_SENSOR_ID: "s2" })).not.toThrow();
  });

  it("reads `doors:` from the YAML file, and lets DOOR_* / DOOR2_* override its first two entries", () => {
    const file = join(mkdtempSync(join(tmpdir(), "go-doors-")), "config.yaml");
    writeFileSync(
      file,
      [
        "bridge: { mode: mock }",
        "doors:",
        "  - { name: Left, relayId: r, outputId: 0, sensorId: s1, interiorCameraId: cam }",
        "  - { name: Right, relayId: r, outputId: 1, sensorId: s2, interiorCameraId: cam, travelSeconds: 22 }",
        "",
      ].join("\n"),
    );
    const specs = doorSpecs(mock({}, file));
    expect(specs).toEqual([
      { id: "d1", name: "Left", relayId: "r", outputId: 0, sensorId: "s1", interiorCameraId: "cam", travelSeconds: 15, verifyAfterSeconds: 3 },
      { id: "d2", name: "Right", relayId: "r", outputId: 1, sensorId: "s2", interiorCameraId: "cam", travelSeconds: 22, verifyAfterSeconds: 3 },
    ]);
    expect(doorSpecs(mock({ DOOR2_NAME: "Margo's side", DOOR_SENSOR_ID: "s9" }, file)).map((s) => [s.name, s.sensorId])).toEqual([["Left", "s9"], ["Margo's side", "s2"]]);
  });

  it("DOOR_TRAVEL_SECONDS wins over doors[0].travelSeconds in the file; the file wins over the defaults", () => {
    const file = join(mkdtempSync(join(tmpdir(), "go-doors-")), "config.yaml");
    writeFileSync(
      file,
      [
        "bridge: { mode: mock }",
        "doors:",
        "  - { relayId: r, outputId: 0, sensorId: s1, travelSeconds: 22, verifyAfterSeconds: 5 }",
        "  - { relayId: r, outputId: 1, sensorId: s2 }",
        "",
      ].join("\n"),
    );
    const timings = (env: Record<string, string>) => doorSpecs(mock(env, file)).map((s) => [s.travelSeconds, s.verifyAfterSeconds]);
    expect(timings({})).toEqual([[22, 5], [22, 5]]);
    expect(timings({ DOOR_TRAVEL_SECONDS: "9" })).toEqual([[9, 5], [9, 5]]);
    expect(timings({ DOOR_VERIFY_AFTER_SECONDS: "1", DOOR2_TRAVEL_SECONDS: "30" })).toEqual([[22, 1], [30, 1]]);
  });

  it("MOCK_DOORS is 1 or 2", () => {
    expect(mock({ MOCK_DOORS: "2" }).bridge.mockDoors).toBe(2);
    expect(() => mock({ MOCK_DOORS: "3" })).toThrow();
    expect(() => mock({ MOCK_DOORS: "0" })).toThrow();
  });

  it("a known plate may be tied to a door; an untied plate means d1, as before", () => {
    expect([...platesByDoor(["ABC 123", "xyz-9:d2", "QQQ111 : D2", ""])]).toEqual([["d1", ["ABC 123"]], ["d2", ["xyz-9", "QQQ111"]]]);
    expect(() => mock({ LPR_KNOWN_PLATES: "ABC123:d2" })).toThrow(/ties a plate to d2, but this install has 1 door/);
    expect(() => mock({ LPR_KNOWN_PLATES: "ABC123:d2", MOCK_DOORS: "2" })).not.toThrow();
    expect(() => mock({ LPR_KNOWN_PLATES: "ABC123:d2", DOOR2_RELAY_ID: "r", DOOR2_OUTPUT_ID: "1", DOOR2_SENSOR_ID: "s2" })).not.toThrow();
  });
});
