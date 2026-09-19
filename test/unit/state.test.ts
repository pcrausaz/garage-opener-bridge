import { describe, expect, it } from "vitest";
import { canCommand, initialDoorState, reduce, targetFor, type DoorMachineState } from "../../src/door/state.js";

const T = 1_000_000;
const closed = (): DoorMachineState => reduce(initialDoorState(T), { type: "sensor", isOpened: false, at: T, changedAt: T - 5000 });

describe("door state machine", () => {
  it("starts UNKNOWN and resolves from the first sensor read", () => {
    const s = initialDoorState(T);
    expect(s.door).toBe("UNKNOWN");
    expect(closed().door).toBe("CLOSED");
    expect(closed().since).toBe(T - 5000);
    expect(reduce(initialDoorState(T), { type: "sensor", isOpened: true, at: T }).door).toBe("OPEN");
  });

  it("open pulse → OPENING → OPEN at deadline when the sensor confirms", () => {
    let s = reduce(closed(), { type: "pulse", command: "open", at: T, travelMs: 15000 });
    expect(s.door).toBe("OPENING");
    expect(s.moving?.target).toBe("OPEN");
    s = reduce(s, { type: "sensor", isOpened: true, at: T + 1000 });
    expect(s.door).toBe("OPENING"); // stays until the deadline
    s = reduce(s, { type: "deadline", at: T + 15000 });
    expect(s.door).toBe("OPEN");
    expect(s.moving).toBeNull();
    expect(s.since).toBe(T + 15000);
  });

  it("goes STUCK when the sensor does not confirm by the deadline", () => {
    let s = reduce(closed(), { type: "pulse", command: "open", at: T, travelMs: 15000 });
    s = reduce(s, { type: "deadline", at: T + 15000 });
    expect(s.door).toBe("STUCK");
    // a later contact change recovers
    s = reduce(s, { type: "sensor", isOpened: true, at: T + 20000 });
    expect(s.door).toBe("OPEN");
  });

  it("STUCK stays STUCK while the contact is unchanged", () => {
    let s = reduce(closed(), { type: "pulse", command: "open", at: T, travelMs: 1000 });
    s = reduce(s, { type: "deadline", at: T + 1000 });
    expect(s.door).toBe("STUCK");
    expect(reduce(s, { type: "sensor", isOpened: false, at: T + 2000 }).door).toBe("STUCK");
  });

  it("external actuation (wall button) is tracked from sensor edges", () => {
    const s = reduce(closed(), { type: "sensor", isOpened: true, at: T + 60_000 });
    expect(s.door).toBe("OPEN");
    expect(s.since).toBe(T + 60_000);
    expect(s.lastChangedAt).toBe(T + 60_000);
  });

  it("sensor errors mark UNKNOWN unless moving", () => {
    expect(reduce(closed(), { type: "sensor-error", at: T }).door).toBe("UNKNOWN");
    const moving = reduce(closed(), { type: "pulse", command: "open", at: T, travelMs: 1000 });
    expect(reduce(moving, { type: "sensor-error", at: T }).door).toBe("OPENING");
  });

  it("canCommand: idempotent, single-flight, unknown", () => {
    expect(canCommand(closed(), "close")).toEqual({ ok: true, noop: true });
    expect(canCommand(closed(), "open")).toEqual({ ok: true, noop: false });
    expect(canCommand(closed(), "toggle")).toEqual({ ok: true, noop: false });
    const moving = reduce(closed(), { type: "pulse", command: "open", at: T, travelMs: 1000 });
    expect(canCommand(moving, "open")).toEqual({ ok: false, reason: "busy" });
    expect(canCommand(initialDoorState(T), "open")).toEqual({ ok: false, reason: "unknown" });
  });

  it("targetFor toggle depends on the contact", () => {
    expect(targetFor("toggle", false)).toBe("OPEN");
    expect(targetFor("toggle", true)).toBe("CLOSED");
    expect(targetFor("open", true)).toBe("OPEN");
  });
});
