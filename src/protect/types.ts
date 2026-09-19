/**
 * Types derived from live fixtures in test/fixtures/protect (Protect 7.2.105).
 * Only fields the bridge uses are typed strictly; everything else is passed through.
 */
export interface ProtectBattery {
  percentage: number | null;
  isLow: boolean;
}

export interface ProtectWireless {
  signalState?: { signalQuality: number | null; signalStrength: number | null };
  batteryStatus?: ProtectBattery;
  bridge?: string;
}

export interface ProtectSensor {
  id: string;
  modelKey: "sensor";
  name: string;
  type: string;
  state: "CONNECTED" | "DISCONNECTED" | string;
  mountType: "garage" | "door" | "window" | "leak" | "none" | string;
  isOpened: boolean;
  openStatusChangedAt: number | null;
  batteryStatus: ProtectBattery;
  wirelessConnectionState?: ProtectWireless;
  mac?: string;
  [k: string]: unknown;
}

export interface ProtectRelayOutput {
  id: number;
  name: string | null;
  type: "garageDoor" | string | null;
  delay: number | null;
  pulseDuration: number | null;
  state: "on" | "off" | string;
  rebootState: string;
}

export interface ProtectRelay {
  id: string;
  modelKey: "relay";
  name: string;
  type: string;
  state: "CONNECTED" | "DISCONNECTED" | string;
  outputs: ProtectRelayOutput[];
  inputs?: unknown[];
  wirelessConnectionState?: ProtectWireless;
  mac?: string;
  [k: string]: unknown;
}

export interface ProtectCamera {
  id: string;
  modelKey: "camera";
  name: string;
  state: string;
  smartDetectSettings?: { objectTypes?: string[]; audioTypes?: string[] };
  featureFlags?: { smartDetectTypes?: string[] };
  mac?: string;
  [k: string]: unknown;
}

export interface ProtectMetaInfo {
  applicationVersion: string;
}

export interface ProtectClient {
  getMetaInfo(): Promise<ProtectMetaInfo>;
  getSensors(): Promise<ProtectSensor[]>;
  getSensor(id: string): Promise<ProtectSensor>;
  getRelays(): Promise<ProtectRelay[]>;
  getRelay(id: string): Promise<ProtectRelay>;
  getCameras(): Promise<ProtectCamera[]>;
  /** POST /relays/{id}/outputs/{outputId}/activate — response shape unknown, treated as opaque. */
  activateOutput(relayId: string, outputId: number): Promise<unknown>;
  close(): Promise<void>;
}

export class ProtectError extends Error {
  constructor(message: string, public readonly status?: number, cause?: unknown) {
    super(message, { cause });
    this.name = "ProtectError";
  }
}
