export type ProtectEventType = "opened" | "closed" | "vehicle-start" | "vehicle-end" | "plate" | "unknown";

export interface ClassifiedEvent {
  type: ProtectEventType;
  /** Device id or MAC as sent by Protect (may be undefined for GET pings). */
  device?: string;
  /** License plate for `plate` events. */
  plate?: string;
  at: number;
  alarmName?: string;
  source: "webhook" | "mock" | "poll";
}

const THUMB_KEYS = /thumbnail|image|snapshot|base64|jpeg|jpg|png|heatmap/i;

/** Remove anything that looks like a thumbnail before the payload is logged or stored. */
export function stripThumbnails(input: unknown, depth = 0): unknown {
  if (depth > 12) return "[depth]";
  if (Array.isArray(input)) return input.map((v) => stripThumbnails(v, depth + 1));
  if (input && typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (THUMB_KEYS.test(k)) {
        out[k] = "[stripped]";
        continue;
      }
      if (typeof v === "string" && (v.length > 2048 || /^data:image\//.test(v))) {
        out[k] = "[stripped]";
        continue;
      }
      out[k] = stripThumbnails(v, depth + 1);
    }
    return out;
  }
  if (typeof input === "string" && input.length > 2048) return "[stripped]";
  return input;
}

interface Trigger {
  key?: string;
  device?: string;
  value?: string;
  eventType?: string;
  [k: string]: unknown;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function classifyKey(key: string, hints: string): ProtectEventType {
  const k = key.toLowerCase();
  if (/(sensor|contact|door).*open|^open(ed)?$/.test(k)) return "opened";
  if (/(sensor|contact|door).*clos|^clos(ed)?$/.test(k)) return "closed";
  if (/plate|lpr|license/.test(k)) return "plate";
  if (/vehicle|car/.test(k)) return /end|ended|stop|finish|leave|left/.test(k + " " + hints) ? "vehicle-end" : "vehicle-start";
  return "unknown";
}

/**
 * Best-effort classification of a UniFi Protect Alarm Manager webhook. Real payloads (Protect 5+/7)
 * look like `{ alarm: { name, triggers: [{ key, device, value? }], eventPath, ... }, timestamp }`.
 * Unknown shapes degrade to `unknown` with the raw payload logged at debug by the caller.
 */
export function classifyAlarmPayload(payload: unknown, query: Record<string, unknown> = {}, now = Date.now()): ClassifiedEvent[] {
  const root = asRecord(payload) ?? {};
  const alarm = asRecord(root.alarm) ?? root;
  const ts = typeof root.timestamp === "number" ? root.timestamp : typeof alarm.timestamp === "number" ? (alarm.timestamp as number) : null;
  const at = ts === null ? now : ts < 1e12 ? ts * 1000 : ts;
  const alarmName = typeof alarm.name === "string" ? alarm.name : undefined;
  const hints = [alarmName ?? "", typeof alarm.eventType === "string" ? alarm.eventType : "", typeof query.event === "string" ? query.event : ""].join(" ").toLowerCase();

  const out: ClassifiedEvent[] = [];
  const triggers = Array.isArray(alarm.triggers) ? (alarm.triggers as Trigger[]) : [];
  for (const t of triggers) {
    const key = typeof t.key === "string" ? t.key : typeof t.eventType === "string" ? t.eventType : "";
    const type = classifyKey(key, hints + " " + (typeof t.eventType === "string" ? t.eventType : ""));
    const ev: ClassifiedEvent = { type, at, source: "webhook" };
    if (typeof t.device === "string") ev.device = t.device;
    if (alarmName) ev.alarmName = alarmName;
    if (type === "plate") {
      const plate = typeof t.value === "string" ? t.value : typeof t.plate === "string" ? (t.plate as string) : typeof t.licensePlate === "string" ? (t.licensePlate as string) : undefined;
      if (plate) ev.plate = normalizePlate(plate);
    }
    out.push(ev);
  }
  if (out.length === 0) {
    // GET pings / minimal setups: `?event=opened&device=…&plate=…`
    const qEvent = typeof query.event === "string" ? query.event : typeof root.event === "string" ? (root.event as string) : "";
    const type = qEvent ? classifyKey(qEvent, hints) : alarmName ? classifyKey(alarmName, hints) : "unknown";
    const ev: ClassifiedEvent = { type, at, source: "webhook" };
    const dev = typeof query.device === "string" ? query.device : typeof root.device === "string" ? (root.device as string) : undefined;
    if (dev) ev.device = dev;
    if (alarmName) ev.alarmName = alarmName;
    const plate = typeof query.plate === "string" ? query.plate : typeof root.plate === "string" ? (root.plate as string) : undefined;
    if (plate) ev.plate = normalizePlate(plate);
    out.push(ev);
  }
  return out;
}

export function normalizePlate(p: string): string {
  return p.replace(/[^a-z0-9]/gi, "").toUpperCase();
}

/** Compare a device reference (id or MAC) loosely: case-insensitive, colons ignored. */
export function deviceMatches(ref: string | undefined, ...candidates: (string | null | undefined)[]): boolean {
  if (!ref) return false;
  const n = ref.replace(/:/g, "").toLowerCase();
  return candidates.some((c) => c && c.replace(/:/g, "").toLowerCase() === n);
}
