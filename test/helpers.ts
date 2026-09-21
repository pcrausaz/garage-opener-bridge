import { makeConfig, type ConfigInput } from "../src/config.js";
import { silentLogger } from "../src/logger.js";
import { Instance } from "../src/instance.js";
import type { NotificationTransport } from "../src/notify/transport.js";
import type { Alert } from "../src/types.js";
import { DEMO_PLATE } from "../src/protect/simulator.js";

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
    // The plate the public demo bridge knows (src/protect/simulator.ts DEMO_PLATE); keep these in step.
    lpr: { knownPlates: [DEMO_PLATE], departGraceMinutes: 3, undoSeconds: 60, ...(over.lpr ?? {}) },
    // default mode (emulated, toggling simulator) with short contact timings to keep suites fast
    relay: { pulseMs: 50, releaseMs: 20, ...(over.relay ?? {}) },
    features: over.features ?? { lpr: true },
    tz: over.tz ?? "UTC",
    ...Object.fromEntries(Object.entries(over).filter(([k]) => !["bridge", "door", "alerts", "lpr", "features", "tz", "relay"].includes(k))),
  });

export interface MockInstanceOptions {
  /** Suites driven by fake timers cannot await the emulated press sequence's real sleeps; they use a
   *  truly pulsing simulator with native mode instead (relay mechanics are covered by relay-toggle.test.ts). */
  nativePulse?: boolean;
}

export async function mockInstance(over: ConfigInput = {}, o: MockInstanceOptions = {}) {
  const capture = new CaptureTransport();
  const cfg = mockConfig(o.nativePulse ? { ...over, relay: { pulseMode: "native", ...(over.relay ?? {}) } } : over);
  const inst = new Instance(cfg, silentLogger, "mock", { transports: [capture], label: "test", simulator: o.nativePulse ? { relayBehaviour: "pulse" } : {} });
  await inst.start();
  return { inst, capture };
}

export const flush = () => new Promise<void>((r) => setImmediate(r));
