import { describe, expect, it } from "vitest";
import { canCommand, initialDoorState, nextPress, reduce, targetFor, type DoorMachineState } from "../../src/door/state.js";

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
    expect(targetFor("toggle", { isOpened: false, door: "CLOSED", stoppedFrom: null })).toBe("OPEN");
    expect(targetFor("toggle", { isOpened: true, door: "OPEN", stoppedFrom: null })).toBe("CLOSED");
    expect(targetFor("open", { isOpened: true, door: "OPEN", stoppedFrom: null })).toBe("OPEN");
  });

  describe("stop (ADR-0015)", () => {
    const opening = () => reduce(closed(), { type: "pulse", command: "open", at: T, travelMs: 15000 });
    // Mid-close: the tilt contact still reads "opened" the whole way down until the door is fully shut.
    const closing = () => {
      const open = reduce(closed(), { type: "sensor", isOpened: true, at: T });
      return reduce(open, { type: "pulse", command: "close", at: T + 1000, travelMs: 15000 });
    };

    it("stops a travelling door and remembers which travel it interrupted", () => {
      const s = reduce(opening(), { type: "stop", at: T + 3000 });
      expect(s.door).toBe("STOPPED");
      expect(s.moving).toBeNull();
      expect(s.stoppedFrom).toBe("OPENING");
      expect(s.since).toBe(T + 3000);
    });

    it("is a no-op when the door is not moving", () => {
      expect(reduce(closed(), { type: "stop", at: T })).toEqual(closed());
      expect(canCommand(closed(), "stop")).toEqual({ ok: false, reason: "not_moving" });
      expect(canCommand(opening(), "stop")).toEqual({ ok: true, noop: false });
    });

    it("the next press reverses the interrupted travel, in both directions", () => {
      const afterOpening = reduce(opening(), { type: "stop", at: T + 3000 });
      expect(nextPress(afterOpening)).toBe("close");
      expect(reduce(afterOpening, { type: "pulse", command: "toggle", at: T + 9000, travelMs: 15000 }).door).toBe("CLOSING");

      // The contact says "opened" here too, so without stoppedFrom this would also predict CLOSING.
      const afterClosing = reduce(closing(), { type: "stop", at: T + 4000 });
      expect(afterClosing.stoppedFrom).toBe("CLOSING");
      expect(nextPress(afterClosing)).toBe("open");
      expect(reduce(afterClosing, { type: "pulse", command: "toggle", at: T + 9000, travelMs: 15000 }).door).toBe("OPENING");
    });

    it("refuses the direction one press does not go, and allows the other", () => {
      const afterClosing = reduce(closing(), { type: "stop", at: T + 4000 });
      expect(canCommand(afterClosing, "close")).toEqual({ ok: false, reason: "direction" });
      expect(canCommand(afterClosing, "open")).toEqual({ ok: true, noop: false });

      const afterOpening = reduce(opening(), { type: "stop", at: T + 3000 });
      expect(canCommand(afterOpening, "open")).toEqual({ ok: false, reason: "direction" });
      expect(canCommand(afterOpening, "close")).toEqual({ ok: true, noop: false });
      // never a no-op: the door is genuinely neither open nor closed
      expect(canCommand(afterOpening, "close")).not.toMatchObject({ noop: true });
    });

    it("holds STOPPED against the polls that keep reporting the same contact", () => {
      let s = reduce(opening(), { type: "stop", at: T + 3000 });
      s = reduce(s, { type: "sensor", isOpened: true, at: T + 5000 });
      s = reduce(s, { type: "sensor", isOpened: true, at: T + 20000 });
      expect(s.door).toBe("STOPPED");
      expect(s.since).toBe(T + 3000);
    });

    it("gives up STOPPED only once the contact has been seen opened first (#5)", () => {
      // Stopped on the way up before the tilt edge: the contact still reads closed, and that is the
      // sensor lagging the press, not the door sitting on the floor. It must stay part-way.
      let s = reduce(opening(), { type: "stop", at: T + 3000 });
      expect(s.sawOpenSinceStop).toBe(false);
      s = reduce(s, { type: "sensor", isOpened: false, at: T + 30000 });
      expect(s.door).toBe("STOPPED");
      expect(s.stoppedFrom).toBe("OPENING");

      // The edge arrives: the door is off the floor, still part-way.
      s = reduce(s, { type: "sensor", isOpened: true, at: T + 40000 });
      expect(s.door).toBe("STOPPED");
      expect(s.sawOpenSinceStop).toBe(true);

      // Now a closed contact really does mean it reached the floor.
      s = reduce(s, { type: "sensor", isOpened: false, at: T + 60000 });
      expect(s.door).toBe("CLOSED");
      expect(s.stoppedFrom).toBeNull();
    });

    it("a door stopped mid-close is closed by the very next closed contact", () => {
      // Here the contact already reads opened at the stop, so nothing is being waited for.
      let s = reduce(closing(), { type: "stop", at: T + 4000 });
      expect(s.sawOpenSinceStop).toBe(true);
      s = reduce(s, { type: "sensor", isOpened: false, at: T + 20000 });
      expect(s.door).toBe("CLOSED");
    });

    it("a console outage drops the part-way state rather than guessing", () => {
      const s = reduce(reduce(opening(), { type: "stop", at: T + 3000 }), { type: "sensor-error", at: T + 9000 });
      expect(s.door).toBe("UNKNOWN");
      expect(s.stoppedFrom).toBeNull();
      expect(canCommand(s, "stop")).toEqual({ ok: false, reason: "not_moving" });
    });

    it("nextPress describes every state the app can be shown", () => {
      expect(nextPress(initialDoorState(T))).toBeNull();
      expect(nextPress(closed())).toBe("open");
      expect(nextPress(reduce(closed(), { type: "sensor", isOpened: true, at: T }))).toBe("close");
      expect(nextPress(opening())).toBe("stop");
      expect(nextPress(closing())).toBe("stop");
    });
  });
});
