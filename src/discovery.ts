import type { ProtectClient } from "./protect/types.js";

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
}

export function suggestMapping(d: Pick<DiscoveryResult, "relays" | "sensors" | "cameras">): DoorMapping | null {
  const outputs = d.relays.flatMap((r) => r.outputs.map((o) => ({ relayId: r.id, ...o })));
  const pulseOutputs = outputs.filter((o) => o.type === "garageDoor");
  const candidates = pulseOutputs.length > 0 ? pulseOutputs : outputs.filter((o) => o.name);
  const garageSensors = d.sensors.filter((s) => s.mountType === "garage");
  if (candidates.length !== 1 || garageSensors.length !== 1) return null;
  const pick = (re: RegExp) => d.cameras.find((c) => re.test(c.name) && c.smartDetectTypes.includes("vehicle"))?.id ?? null;
  return {
    relayId: candidates[0]!.relayId,
    outputId: candidates[0]!.id,
    sensorId: garageSensors[0]!.id,
    interiorCameraId: pick(/garage/i),
    drivewayCameraId: pick(/driveway|drive/i),
  };
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
  return { ...base, suggested, current: resolved, autoPaired };
}
