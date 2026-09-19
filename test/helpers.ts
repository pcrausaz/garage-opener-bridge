import { makeConfig, type ConfigInput } from "../src/config.js";
import { silentLogger } from "../src/logger.js";
import { Instance } from "../src/instance.js";
import type { NotificationTransport } from "../src/notify/transport.js";
import type { Alert } from "../src/types.js";

export class CaptureTransport implements NotificationTransport {
  readonly name = "capture";
  alerts: Alert[] = [];
  async notify(alert: Alert): Promise<void> {
    this.alerts.push(alert);
  }
  rules(): string[] {
    return this.alerts.map((a) => a.rule);
  }
}

export const mockConfig = (over: ConfigInput = {}) =>
  makeConfig({
    bridge: { mode: "mock", tokens: ["test-token-1"], webhookSecret: "0123456789abcdef", ...(over.bridge ?? {}) },
    door: { travelSeconds: 10, verifyAfterSeconds: 2, ...(over.door ?? {}) },
    alerts: { openTooLongMinutes: 15, nightlyTime: "22:00", vehicleDoorOpenMinutes: 5, vehicleGraceSeconds: 120, ...(over.alerts ?? {}) },
    lpr: { knownPlates: ["ABC123"], departGraceMinutes: 3, undoSeconds: 60, ...(over.lpr ?? {}) },
    features: over.features ?? { lpr: true },
    tz: over.tz ?? "UTC",
    ...Object.fromEntries(Object.entries(over).filter(([k]) => !["bridge", "door", "alerts", "lpr", "features", "tz"].includes(k))),
  });

export async function mockInstance(over: ConfigInput = {}) {
  const capture = new CaptureTransport();
  const inst = new Instance(mockConfig(over), silentLogger, "mock", { transports: [capture], label: "test" });
  await inst.start();
  return { inst, capture };
}

export const flush = () => new Promise<void>((r) => setImmediate(r));
