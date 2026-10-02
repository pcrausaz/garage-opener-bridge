import type { ProtectClient } from "./protect/types.js";
import type { Door } from "./types.js";

export interface DoorMapping {
  relayId: string;
  outputId: number;
  sensorId: string;
  interiorCameraId: string | null;
  drivewayCameraId: string | null;
}

export interface DiscoveryResult {
  relays: { id: string; name: string; connected: boolean; outputs: { id: number; name: string | null; type: string | null; pulseDurationMs: number | null }[] }[];
  sensors: { id: string; name: string; mountType: string; isOpened: boolean; connected: boolean }[];
  cameras: { id: string; name: string; smartDetectTypes: string[] }[];
  suggested: DoorMapping | null;
  current: DoorMapping | null;
  autoPaired: boolean;
  /** Two door outputs and two garage sensors whose names pair up; logged and shown, never applied. */
  suggestedDoors: DoorMapping[] | null;
  /** Every configured door, `d1` first (filled in by the instance, which knows them). */
  doors?: Door[];
}

type Devices = Pick<DiscoveryResult, "relays" | "sensors" | "cameras">;

function candidates(d: Devices) {
  const outputs = d.relays.flatMap((r) => r.outputs.map((o) => ({ relayId: r.id, ...o })));
  const pulseOutputs = outputs.filter((o) => o.type === "garageDoor");
  return { outputs: pulseOutputs.length > 0 ? pulseOutputs : outputs.filter((o) => o.name), sensors: d.sensors.filter((s) => s.mountType === "garage") };
}

const pickCamera = (d: Devices, re: RegExp) => d.cameras.find((c) => re.test(c.name) && c.smartDetectTypes.includes("vehicle"))?.id ?? null;

export function suggestMapping(d: Devices): DoorMapping | null {
  const { outputs, sensors } = candidates(d);
  if (outputs.length !== 1 || sensors.length !== 1) return null;
  return {
    relayId: outputs[0]!.relayId,
    outputId: outputs[0]!.id,
    sensorId: sensors[0]!.id,
    interiorCameraId: pickCamera(d, /garage/i),
    drivewayCameraId: pickCamera(d, /driveway|drive/i),
  };
}

/** Words every door, sensor and relay name has; they say nothing about which is which. */
const GENERIC = new Set(["garage", "door", "doors", "sensor", "state", "relay", "output", "the", "mock"]);
const nameWords = (name: string | null) => new Set((name ?? "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w && !GENERIC.has(w)));

/**
 * Two door outputs and two garage sensors: which sensor watches which door? Only the names can say ("Left
 * Door" / "Left Door State"), so this pairs them by the distinguishing words they share and answers `null`
 * when the names do not decide it. It is a suggestion to be written down as `DOOR_*` / `DOOR2_*` and is never
 * applied: a wrong guess here is a wrong-door bug (ADR-0020). Both doors are offered the same cameras.
 */
export function suggestPairing(d: Devices): DoorMapping[] | null {
  const { outputs, sensors } = candidates(d);
  if (outputs.length !== 2 || sensors.length !== 2) return null;
  const shared = (o: number, s: number) => {
    const a = nameWords(outputs[o]!.name);
    return [...nameWords(sensors[s]!.name)].filter((w) => a.has(w)).length;
  };
  const straight = shared(0, 0) + shared(1, 1);
  const crossed = shared(0, 1) + shared(1, 0);
  if (straight === crossed) return null;
  const order = straight > crossed ? [0, 1] : [1, 0];
  return outputs.map((o, i) => ({
    relayId: o.relayId,
    outputId: o.id,
    sensorId: sensors[order[i]!]!.id,
    interiorCameraId: pickCamera(d, /garage/i),
    drivewayCameraId: pickCamera(d, /driveway|drive/i),
  }));
}

/** The pairing as settings ready to paste, for the log line that asks for it to be written down. */
export function pairingAsEnv(doors: DoorMapping[]): string[] {
  return doors.flatMap((m, i) => {
    const p = i === 0 ? "DOOR" : `DOOR${i + 1}`;
    return [`${p}_RELAY_ID=${m.relayId}`, `${p}_OUTPUT_ID=${m.outputId}`, `${p}_SENSOR_ID=${m.sensorId}`];
  });
}

export async function discover(protect: ProtectClient, current: DoorMapping | null, explicit: Partial<DoorMapping>): Promise<DiscoveryResult> {
  const [relays, sensors, cameras] = await Promise.all([protect.getRelays(), protect.getSensors(), protect.getCameras()]);
  const base = {
    relays: relays.map((r) => ({
      id: r.id,
      name: r.name,
      connected: r.state === "CONNECTED",
      outputs: r.outputs.map((o) => ({ id: o.id, name: o.name, type: o.type, pulseDurationMs: o.pulseDuration })),
    })),
    sensors: sensors.map((s) => ({ id: s.id, name: s.name, mountType: s.mountType, isOpened: s.isOpened, connected: s.state === "CONNECTED" })),
    cameras: cameras.map((c) => ({ id: c.id, name: c.name, smartDetectTypes: c.smartDetectSettings?.objectTypes ?? c.featureFlags?.smartDetectTypes ?? [] })),
  };
  const suggested = suggestMapping(base);
  let resolved = current;
  let autoPaired = false;
  if (!resolved) {
    if (explicit.relayId && explicit.outputId !== undefined && explicit.sensorId) {
      resolved = {
        relayId: explicit.relayId,
        outputId: explicit.outputId,
        sensorId: explicit.sensorId,
        interiorCameraId: explicit.interiorCameraId ?? suggested?.interiorCameraId ?? null,
        drivewayCameraId: explicit.drivewayCameraId ?? suggested?.drivewayCameraId ?? null,
      };
    } else if (suggested) {
      resolved = { ...suggested, interiorCameraId: explicit.interiorCameraId ?? suggested.interiorCameraId, drivewayCameraId: explicit.drivewayCameraId ?? suggested.drivewayCameraId };
      autoPaired = true;
    }
  }
  return { ...base, suggested, current: resolved, autoPaired, suggestedDoors: suggestPairing(base) };
}
