import type { DoorCommand, DoorState } from "../types.js";

/** Pure door state machine. Sensor is the only source of truth; the relay is stateless. */
export interface DoorMachineState {
  door: DoorState;
  /** Last known raw sensor contact (null until first read). */
  isOpened: boolean | null;
  since: number;
  lastChangedAt: number | null;
  moving: { command: DoorCommand; target: "OPEN" | "CLOSED"; startedAt: number; deadline: number } | null;
}

export type DoorEvent =
  | { type: "sensor"; isOpened: boolean; at: number; changedAt?: number | null }
  | { type: "sensor-error"; at: number }
  | { type: "pulse"; command: DoorCommand; at: number; travelMs: number }
  | { type: "deadline"; at: number };

export function initialDoorState(at: number): DoorMachineState {
  return { door: "UNKNOWN", isOpened: null, since: at, lastChangedAt: null, moving: null };
}

export function restingState(isOpened: boolean): DoorState {
  return isOpened ? "OPEN" : "CLOSED";
}

export function targetFor(command: DoorCommand, isOpened: boolean | null): "OPEN" | "CLOSED" {
  if (command === "open") return "OPEN";
  if (command === "close") return "CLOSED";
  return isOpened ? "CLOSED" : "OPEN";
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
      const door = restingState(e.isOpened);
      if (s.isOpened === null || changed || s.door === "UNKNOWN") {
        // First read, external actuation (wall button / remote), or recovery from UNKNOWN.
        const since = s.door === door ? s.since : (changed && s.isOpened !== null ? e.at : (e.changedAt ?? e.at));
        return { door, isOpened: e.isOpened, since, lastChangedAt, moving: null };
      }
      if (s.door === "STUCK") return s; // unchanged contact while stuck stays stuck
      return { ...s, isOpened: e.isOpened, lastChangedAt };
    }
    case "sensor-error":
      if (s.moving) return s;
      return s.door === "UNKNOWN" ? s : { ...s, door: "UNKNOWN", since: e.at, moving: null };
    case "pulse": {
      const target = targetFor(e.command, s.isOpened);
      return {
        ...s,
        door: target === "OPEN" ? "OPENING" : "CLOSING",
        since: e.at,
        moving: { command: e.command, target, startedAt: e.at, deadline: e.at + e.travelMs },
      };
    }
    case "deadline": {
      if (!s.moving) return s;
      const reached = s.isOpened !== null && restingState(s.isOpened) === s.moving.target;
      return { ...s, door: reached ? s.moving.target : "STUCK", since: e.at, moving: null };
    }
  }
}

/** Whether a new command may be issued now. */
export function canCommand(s: DoorMachineState, command: DoorCommand): { ok: true; noop: boolean } | { ok: false; reason: "busy" | "unknown" } {
  if (s.moving) return { ok: false, reason: "busy" };
  if (s.door === "UNKNOWN" || s.isOpened === null) return { ok: false, reason: "unknown" };
  if (command === "toggle") return { ok: true, noop: false };
  const target = targetFor(command, s.isOpened);
  return { ok: true, noop: s.door === target };
}
