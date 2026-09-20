import { EventEmitter } from "node:events";
import type { ProtectCamera, ProtectClient, ProtectMetaInfo, ProtectRelay, ProtectSensor } from "./types.js";

export const SIM_IDS = {
  sensorId: "mock-sensor-0001",
  relayId: "mock-relay-0001",
  outputId: 0,
  interiorCameraId: "mock-cam-garage",
  drivewayCameraId: "mock-cam-driveway",
} as const;

export interface SimulatorOptions {
  travelMs?: number;
  /** Delay before the tilt sensor flips to "opened" after an opening pulse. */
  tiltMs?: number;
  batteryPercentage?: number;
  now?: () => number;
  /** `toggle` (default, like the USL-Relay on Protect 7.2.x, ADR-0010): activate flips the output; press on off→on. `pulse`: each activate is a press. */
  relayBehaviour?: "pulse" | "toggle";
}

export type SimPhase = "closed" | "opening" | "open" | "closing" | "stopped";

/**
 * In-memory Protect console. Door physics: a pulse from rest starts travel; the tilt sensor flips to
 * opened `tiltMs` after an opening pulse and flips to closed only at the end of a full close. A pulse
 * while moving stops the door (like a real opener); `reverseNextClose` simulates a safety-beam
 * reversal on the next close.
 */
export class ProtectSimulator extends EventEmitter implements ProtectClient {
  phase: SimPhase = "closed";
  isOpened = false;
  openStatusChangedAt: number;
  battery: number;
  reverseNextClose = false;
  activations = 0;
  outputState: "on" | "off" = "off";
  readonly relayBehaviour: "pulse" | "toggle";
  private timer: NodeJS.Timeout | null = null;
  private readonly travelMs: number;
  private readonly tiltMs: number;
  private readonly now: () => number;

  constructor(opts: SimulatorOptions = {}) {
    super();
    this.travelMs = opts.travelMs ?? 15000;
    this.tiltMs = opts.tiltMs ?? Math.min(1000, this.travelMs / 5);
    this.battery = opts.batteryPercentage ?? 76;
    this.now = opts.now ?? Date.now;
    this.relayBehaviour = opts.relayBehaviour ?? "toggle";
    this.openStatusChangedAt = this.now();
  }

  reset(): void {
    this.clearTimer();
    this.phase = "closed";
    this.setOpened(false);
    this.reverseNextClose = false;
    this.activations = 0;
    this.outputState = "off";
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private setOpened(v: boolean) {
    if (this.isOpened !== v) {
      this.isOpened = v;
      this.openStatusChangedAt = this.now();
      this.emit("sensor", v);
    }
  }

  /** Physical button press. */
  pulse(): void {
    this.activations++;
    switch (this.phase) {
      case "closed":
        this.phase = "opening";
        this.timer = setTimeout(() => {
          this.setOpened(true);
          this.timer = setTimeout(() => {
            this.phase = "open";
            this.timer = null;
          }, Math.max(0, this.travelMs - this.tiltMs));
        }, this.tiltMs);
        break;
      case "open":
      case "stopped":
        if (this.reverseNextClose) {
          this.reverseNextClose = false;
          this.phase = "closing";
          this.timer = setTimeout(() => {
            // safety beam: reverse to open, sensor never reports closed
            this.phase = "opening";
            this.timer = setTimeout(() => {
              this.phase = "open";
              this.timer = null;
            }, this.travelMs / 2);
          }, this.travelMs / 2);
        } else {
          this.phase = "closing";
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
        this.phase = "stopped";
        break;
    }
  }

  private sensor(): ProtectSensor {
    return {
      id: SIM_IDS.sensorId,
      modelKey: "sensor",
      name: "Garage Door State (mock)",
      type: "UFP-SENSE",
      state: "CONNECTED",
      mountType: "garage",
      isOpened: this.isOpened,
      openStatusChangedAt: this.openStatusChangedAt,
      batteryStatus: { percentage: this.battery, isLow: this.battery < 15 },
      wirelessConnectionState: { signalState: { signalQuality: 80, signalStrength: -58 } },
    };
  }

  private relay(): ProtectRelay {
    return {
      id: SIM_IDS.relayId,
      modelKey: "relay",
      name: "Garage Relay (mock)",
      type: "USL-Relay-US",
      state: "CONNECTED",
      outputs: [
        { id: 0, name: "Garage Door", type: "garageDoor", delay: null, pulseDuration: 100, state: this.outputState, rebootState: "restore" },
        { id: 1, name: null, type: null, delay: null, pulseDuration: null, state: "off", rebootState: "off" },
      ],
    };
  }

  async getMetaInfo(): Promise<ProtectMetaInfo> {
    return { applicationVersion: "7.2.105-mock" };
  }
  async getSensors(): Promise<ProtectSensor[]> {
    return [this.sensor()];
  }
  async getSensor(id: string): Promise<ProtectSensor> {
    if (id !== SIM_IDS.sensorId) throw new Error("not found");
    return this.sensor();
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
  async activateOutput(relayId: string, outputId: number): Promise<unknown> {
    if (relayId !== SIM_IDS.relayId || outputId !== SIM_IDS.outputId) throw new Error("not found");
    if (this.relayBehaviour === "toggle") {
      const press = this.outputState === "off";
      this.outputState = press ? "on" : "off";
      if (press) this.pulse();
    } else {
      this.pulse();
    }
    return {};
  }
  async close(): Promise<void> {
    this.clearTimer();
  }
}
