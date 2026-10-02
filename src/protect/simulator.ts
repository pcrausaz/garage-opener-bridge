import { EventEmitter } from "node:events";
import { ProtectError, type ProtectCamera, type ProtectClient, type ProtectMetaInfo, type ProtectRelay, type ProtectSensor, type ProtectSnapshot } from "./types.js";
import { drawGarage } from "../mock/illustration.js";

export const SIM_IDS = {
  sensorId: "mock-sensor-0001",
  relayId: "mock-relay-0001",
  outputId: 0,
  interiorCameraId: "mock-cam-garage",
  drivewayCameraId: "mock-cam-driveway",
} as const;

/** The second door of a two-door simulator (`MOCK_DOORS=2`): the relay's other output, its own sensor, the same cameras. */
export const SIM_IDS_2 = {
  sensorId: "mock-sensor-0002",
  relayId: SIM_IDS.relayId,
  outputId: 1,
  interiorCameraId: SIM_IDS.interiorCameraId,
  drivewayCameraId: SIM_IDS.drivewayCameraId,
} as const;

/**
 * The one plate the simulator's LPR rules know when `LPR_KNOWN_PLATES` is unset (mock mode). The app's Simulate
 * panel offers exactly this plate, and `docs/app-review-notes.md` quotes it: if the three drift apart, "Known
 * plate seen" silently does nothing on the public demo bridge.
 */
export const DEMO_PLATE = "DEMO123";

export interface SimulatorOptions {
  travelMs?: number;
  /** Delay before the tilt sensor flips to "opened" after an opening pulse. */
  tiltMs?: number;
  batteryPercentage?: number;
  now?: () => number;
  /** `toggle` (default, like the USL-Relay on Protect 7.2.x, ADR-0010): activate flips the output; press on off→on. `pulse`: each activate is a press. */
  relayBehaviour?: "pulse" | "toggle";
  /** 1 (default) or 2: a second door on the relay's other output, with its own sensor. */
  doors?: number;
}

export type SimPhase = "closed" | "opening" | "open" | "closing" | "stopped";

/**
 * One simulated door. Physics: a pulse from rest starts travel; the tilt sensor flips to opened `tiltMs`
 * after an opening pulse and flips to closed only at the end of a full close. A pulse while moving stops the
 * door (like a real opener) and the press after that reverses the interrupted travel; `reverseNextClose`
 * simulates a safety-beam reversal on the next close.
 */
export class SimDoor {
  phase: SimPhase = "closed";
  isOpened = false;
  openStatusChangedAt: number;
  reverseNextClose = false;
  /** Which travel the last stop interrupted; a real opener reverses that direction on the next press. */
  stoppedFrom: "opening" | "closing" | null = null;
  activations = 0;
  outputState: "on" | "off" = "off";
  private timer: NodeJS.Timeout | null = null;
  /**
   * The tilt edge is tracked separately from the travel because a stop does not put the door back on the
   * floor: a door halted part-way up is tilted, so the sensor still reports `opened` at its usual lag even
   * though the travel was cut short. Folding the two together is what hid #5.
   */
  private tiltTimer: NodeJS.Timeout | null = null;
  /** Where the door is between floor (0) and fully up (1), for the drawn snapshot only. */
  private travel = { from: 0, to: 0, startedAt: 0, ms: 0 };

  constructor(private readonly travelMs: number, private readonly tiltMs: number, private readonly now: () => number, private readonly onSensor: (opened: boolean) => void) {
    this.openStatusChangedAt = this.now();
  }

  reset(): void {
    this.clearAllTimers();
    this.phase = "closed";
    this.stoppedFrom = null;
    this.setOpened(false);
    this.reverseNextClose = false;
    this.activations = 0;
    this.outputState = "off";
    this.travel = { from: 0, to: 0, startedAt: 0, ms: 0 };
  }

  /** Clears the travel timer only; the pending tilt edge survives a stop (see `tiltTimer`). */
  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  clearAllTimers() {
    this.clearTimer();
    if (this.tiltTimer) clearTimeout(this.tiltTimer);
    this.tiltTimer = null;
  }

  private setOpened(v: boolean) {
    if (this.isOpened !== v) {
      this.isOpened = v;
      this.openStatusChangedAt = this.now();
      this.onSensor(v);
    }
  }

  /** How far up the door is right now, 0 (on the floor) to 1 (fully open). */
  position(): number {
    const t = this.travel;
    if (t.ms <= 0) return t.to;
    const f = Math.min(1, Math.max(0, (this.now() - t.startedAt) / t.ms));
    return t.from + (t.to - t.from) * f;
  }

  private moveTo(to: number, ms: number): void {
    this.travel = { from: this.position(), to, startedAt: this.now(), ms };
  }

  /** Physical button press. */
  pulse(): void {
    this.activations++;
    switch (this.phase) {
      case "closed":
        this.phase = "opening";
        this.moveTo(1, this.travelMs);
        // The door leaves the floor immediately; the sensor only says so `tiltMs` later, and keeps that
        // appointment even if the travel is stopped in the meantime.
        if (!this.tiltTimer) this.tiltTimer = setTimeout(() => {
          this.tiltTimer = null;
          this.setOpened(true);
        }, this.tiltMs);
        this.timer = setTimeout(() => {
          this.phase = "open";
          this.timer = null;
        }, this.travelMs);
        break;
      case "stopped":
        // A real opener reverses the travel it interrupted: stopped while opening → this press closes;
        // stopped while closing → this press opens. The bridge predicts the same thing (door/state.ts).
        if (this.stoppedFrom === "closing") {
          this.stoppedFrom = null;
          this.phase = "opening";
          this.moveTo(1, this.travelMs / 2);
          this.timer = setTimeout(() => {
            this.phase = "open";
            this.timer = null;
          }, this.travelMs / 2);
          break;
        }
        this.stoppedFrom = null;
      // falls through: from a stop during an opening travel the next press closes, like an open door
      case "open":
        if (this.reverseNextClose) {
          this.reverseNextClose = false;
          this.phase = "closing";
          this.moveTo(this.position() / 2, this.travelMs / 2);
          this.timer = setTimeout(() => {
            // safety beam: reverse to open, sensor never reports closed
            this.phase = "opening";
            this.moveTo(1, this.travelMs / 2);
            this.timer = setTimeout(() => {
              this.phase = "open";
              this.timer = null;
            }, this.travelMs / 2);
          }, this.travelMs / 2);
        } else {
          this.phase = "closing";
          this.moveTo(0, this.travelMs);
          this.timer = setTimeout(() => {
            this.phase = "closed";
            this.setOpened(false);
            this.timer = null;
          }, this.travelMs);
        }
        break;
      case "opening":
      case "closing":
        this.clearTimer();
        this.stoppedFrom = this.phase;
        this.phase = "stopped";
        this.moveTo(this.position(), 0);
        break;
    }
  }
}

/**
 * In-memory Protect console: one relay, one garage sensor per door, two cameras. It has one door unless
 * `doors: 2` asks for the relay's second output to be a door too. The door-level fields and `pulse()` on this
 * class are the first door's, which is all a one-door simulator ever was.
 */
export class ProtectSimulator extends EventEmitter implements ProtectClient {
  battery: number;
  readonly relayBehaviour: "pulse" | "toggle";
  readonly doors: SimDoor[];
  private readonly now: () => number;

  constructor(opts: SimulatorOptions = {}) {
    super();
    const travelMs = opts.travelMs ?? 15000;
    const tiltMs = opts.tiltMs ?? Math.min(1000, travelMs / 5);
    this.battery = opts.batteryPercentage ?? 76;
    this.now = opts.now ?? Date.now;
    this.relayBehaviour = opts.relayBehaviour ?? "toggle";
    this.doors = Array.from({ length: opts.doors === 2 ? 2 : 1 }, (_, i) => new SimDoor(travelMs, tiltMs, this.now, (v) => this.emit("sensor", v, i)));
  }

  private get first(): SimDoor {
    return this.doors[0]!;
  }
  get phase(): SimPhase {
    return this.first.phase;
  }
  get isOpened(): boolean {
    return this.first.isOpened;
  }
  get openStatusChangedAt(): number {
    return this.first.openStatusChangedAt;
  }
  get stoppedFrom(): "opening" | "closing" | null {
    return this.first.stoppedFrom;
  }
  get activations(): number {
    return this.first.activations;
  }
  get outputState(): "on" | "off" {
    return this.first.outputState;
  }
  get reverseNextClose(): boolean {
    return this.first.reverseNextClose;
  }
  set reverseNextClose(v: boolean) {
    this.first.reverseNextClose = v;
  }

  /** Puts every door back on the floor. */
  reset(): void {
    for (const d of this.doors) d.reset();
  }

  /** Physical button press on the first door. */
  pulse(): void {
    this.first.pulse();
  }

  private sensor(i: number): ProtectSensor {
    const d = this.doors[i]!;
    const two = this.doors.length > 1;
    return {
      id: i === 0 ? SIM_IDS.sensorId : SIM_IDS_2.sensorId,
      modelKey: "sensor",
      name: two ? `${i === 0 ? "Left" : "Right"} Door State (mock)` : "Garage Door State (mock)",
      type: "UFP-SENSE",
      state: "CONNECTED",
      mountType: "garage",
      isOpened: d.isOpened,
      openStatusChangedAt: d.openStatusChangedAt,
      batteryStatus: { percentage: this.battery, isLow: this.battery < 15 },
      wirelessConnectionState: { signalState: { signalQuality: 80, signalStrength: -58 } },
    };
  }

  private relay(): ProtectRelay {
    const two = this.doors[1];
    return {
      id: SIM_IDS.relayId,
      modelKey: "relay",
      name: "Garage Relay (mock)",
      type: "USL-Relay-US",
      state: "CONNECTED",
      outputs: [
        { id: 0, name: two ? "Left Door" : "Garage Door", type: "garageDoor", delay: null, pulseDuration: 100, state: this.first.outputState, rebootState: "restore" },
        two
          ? { id: 1, name: "Right Door", type: "garageDoor", delay: null, pulseDuration: 100, state: two.outputState, rebootState: "restore" }
          : { id: 1, name: null, type: null, delay: null, pulseDuration: null, state: "off", rebootState: "off" },
      ],
    };
  }

  async getMetaInfo(): Promise<ProtectMetaInfo> {
    return { applicationVersion: "7.2.105-mock" };
  }
  async getSensors(): Promise<ProtectSensor[]> {
    return this.doors.map((_, i) => this.sensor(i));
  }
  async getSensor(id: string): Promise<ProtectSensor> {
    const i = [SIM_IDS.sensorId, SIM_IDS_2.sensorId].indexOf(id as typeof SIM_IDS.sensorId);
    if (i < 0 || !this.doors[i]) throw new Error("not found");
    return this.sensor(i);
  }
  async getRelays(): Promise<ProtectRelay[]> {
    return [this.relay()];
  }
  async getRelay(id: string): Promise<ProtectRelay> {
    if (id !== SIM_IDS.relayId) throw new Error("not found");
    return this.relay();
  }
  async getCameras(): Promise<ProtectCamera[]> {
    return [
      { id: SIM_IDS.interiorCameraId, modelKey: "camera", name: "Garage (mock)", state: "CONNECTED", smartDetectSettings: { objectTypes: ["person", "vehicle"] } },
      { id: SIM_IDS.drivewayCameraId, modelKey: "camera", name: "Driveway (mock)", state: "CONNECTED", smartDetectSettings: { objectTypes: ["person", "vehicle"] } },
    ];
  }
  /** A drawn garage, never a photograph: every simulated door at the height it is at right now. */
  async getCameraSnapshot(id: string): Promise<ProtectSnapshot> {
    if (id !== SIM_IDS.interiorCameraId && id !== SIM_IDS.drivewayCameraId) throw new ProtectError("camera not found", 404);
    return { contentType: "image/png", body: drawGarage(this.doors.map((d) => d.position())) };
  }
  async activateOutput(relayId: string, outputId: number): Promise<unknown> {
    const door = relayId === SIM_IDS.relayId ? this.doors[outputId] : undefined;
    if (!door) throw new Error("not found");
    if (this.relayBehaviour === "toggle") {
      const press = door.outputState === "off";
      door.outputState = press ? "on" : "off";
      if (press) door.pulse();
    } else {
      door.pulse();
    }
    return {};
  }
  async close(): Promise<void> {
    for (const d of this.doors) d.clearAllTimers();
  }
}
