import type { DoorCommand, DoorState } from "../types.js";

/** What one relay press does from here. The relay emulates a wall button, so the opener decides. */
export type NextPress = "open" | "close" | "stop";

/** Pure door state machine. Sensor is the only source of truth; the relay is stateless. */
export interface DoorMachineState {
  door: DoorState;
  /** Last known raw sensor contact (null until first read). */
  isOpened: boolean | null;
  since: number;
  lastChangedAt: number | null;
  moving: { command: DoorCommand; target: "OPEN" | "CLOSED"; startedAt: number; deadline: number } | null;
  /**
   * The travel a `stop` interrupted, set only while `door === "STOPPED"`. The tilt sensor reads `isOpened`
   * for anything that is not fully closed, so a part-way door is indistinguishable from an open one: this is
   * remembered, never observed, and is lost on restart (the door then reads as plain OPEN). It exists because
   * the opener reverses after a stop — without it the machine would predict the wrong direction and either
   * declare a healthy door STUCK or, worse, let an unattended `close` open it.
   */
  stoppedFrom: "OPENING" | "CLOSING" | null;
  /**
   * Whether the contact has read *opened* at any point since the stop (seeded with the reading at the stop
   * itself). While STOPPED this is what makes a closed contact mean something: the tilt sensor's edge lands
   * 7–9 s into a ~15 s travel (ARCHITECTURE §5), so a door stopped on the way up is usually still reading
   * *closed* simply because the sensor has not caught up. Only a closed contact that follows an opened one
   * is evidence the door actually reached the floor. Without this the machine threw the part-way state — and
   * `stoppedFrom` with it — one poll after setting it, and the next press drove the door the wrong way (#5).
   */
  sawOpenSinceStop: boolean;
}

export type DoorEvent =
  | { type: "sensor"; isOpened: boolean; at: number; changedAt?: number | null }
  | { type: "sensor-error"; at: number }
  | { type: "pulse"; command: DoorCommand; at: number; travelMs: number }
  | { type: "stop"; at: number }
  | { type: "deadline"; at: number };

export function initialDoorState(at: number): DoorMachineState {
  return { door: "UNKNOWN", isOpened: null, since: at, lastChangedAt: null, moving: null, stoppedFrom: null, sawOpenSinceStop: false };
}

export function restingState(isOpened: boolean): DoorState {
  return isOpened ? "OPEN" : "CLOSED";
}

/** Where a press from `s` sends the door. From STOPPED the opener reverses the travel it interrupted. */
export function targetFor(command: DoorCommand, s: Pick<DoorMachineState, "isOpened" | "door" | "stoppedFrom">): "OPEN" | "CLOSED" {
  if (command === "open") return "OPEN";
  if (command === "close") return "CLOSED";
  if (s.door === "STOPPED" && s.stoppedFrom) return s.stoppedFrom === "OPENING" ? "CLOSED" : "OPEN";
  return s.isOpened ? "CLOSED" : "OPEN";
}

/** What a single press does right now; `null` while the door state is unknown. */
export function nextPress(s: DoorMachineState): NextPress | null {
  if (s.moving) return "stop";
  if (s.door === "UNKNOWN" || s.isOpened === null) return null;
  return targetFor("toggle", s) === "OPEN" ? "open" : "close";
}

export function reduce(s: DoorMachineState, e: DoorEvent): DoorMachineState {
  switch (e.type) {
    case "sensor": {
      const changed = s.isOpened !== e.isOpened;
      const lastChangedAt = e.changedAt ?? (changed ? e.at : s.lastChangedAt);
      if (s.moving) {
        // While moving we only record the contact; the deadline decides.
        return { ...s, isOpened: e.isOpened, lastChangedAt };
      }
      if (s.door === "STOPPED") {
        // A closed contact retires the part-way state only once the sensor has been seen reading *opened*;
        // before that it is just the edge lagging the press, not the door sitting on the floor (#5).
        if (!e.isOpened && s.sawOpenSinceStop) {
          return { ...s, door: "CLOSED", isOpened: false, since: e.at, lastChangedAt, stoppedFrom: null, sawOpenSinceStop: false };
        }
        return { ...s, isOpened: e.isOpened, lastChangedAt, sawOpenSinceStop: s.sawOpenSinceStop || e.isOpened };
      }
      const door = restingState(e.isOpened);
      if (s.isOpened === null || changed || s.door === "UNKNOWN") {
        // First read, external actuation (wall button / remote), or recovery from UNKNOWN.
        const since = s.door === door ? s.since : (changed && s.isOpened !== null ? e.at : (e.changedAt ?? e.at));
        return { ...s, door, isOpened: e.isOpened, since, lastChangedAt, moving: null, stoppedFrom: null, sawOpenSinceStop: false };
      }
      if (s.door === "STUCK") return s; // unchanged contact while stuck stays stuck
      return { ...s, isOpened: e.isOpened, lastChangedAt };
    }
    case "sensor-error":
      if (s.moving) return s;
      return s.door === "UNKNOWN" ? s : { ...s, door: "UNKNOWN", since: e.at, moving: null, stoppedFrom: null, sawOpenSinceStop: false };
    case "pulse": {
      const target = targetFor(e.command, s);
      return {
        ...s,
        door: target === "OPEN" ? "OPENING" : "CLOSING",
        since: e.at,
        moving: { command: e.command, target, startedAt: e.at, deadline: e.at + e.travelMs },
        stoppedFrom: null,
        sawOpenSinceStop: false,
      };
    }
    case "stop": {
      if (!s.moving) return s;
      // Seed from the contact as it reads right now: true for a door stopped mid-close (or mid-open after the
      // edge), false for one stopped on the way up before the sensor caught up.
      return { ...s, door: "STOPPED", since: e.at, moving: null, stoppedFrom: s.moving.target === "OPEN" ? "OPENING" : "CLOSING", sawOpenSinceStop: s.isOpened === true };
    }
    case "deadline": {
      if (!s.moving) return s;
      const reached = s.isOpened !== null && restingState(s.isOpened) === s.moving.target;
      return { ...s, door: reached ? s.moving.target : "STUCK", since: e.at, moving: null, stoppedFrom: null, sawOpenSinceStop: false };
    }
  }
}

export type CommandRefusal = "busy" | "unknown" | "not_moving" | "direction";

/** Whether a new command may be issued now. */
export function canCommand(s: DoorMachineState, command: DoorCommand): { ok: true; noop: boolean } | { ok: false; reason: CommandRefusal } {
  if (command === "stop") {
    // The one command allowed mid-travel: it is the press that stops the door. Outside travel the same
    // press would *move* the door, so it is refused rather than quietly acted on.
    return s.moving ? { ok: true, noop: false } : { ok: false, reason: "not_moving" };
  }
  if (s.moving) return { ok: false, reason: "busy" };
  if (s.door === "UNKNOWN" || s.isOpened === null) return { ok: false, reason: "unknown" };
  if (command === "toggle") return { ok: true, noop: false };
  const target = targetFor(command, s);
  if (s.door === "STOPPED") {
    // One press reverses the interrupted travel. Asking for the other direction would take a full travel
    // plus a second press, so the caller is told no instead of having the door moved the wrong way.
    return targetFor("toggle", s) === target ? { ok: true, noop: false } : { ok: false, reason: "direction" };
  }
  return { ok: true, noop: s.door === target };
}
