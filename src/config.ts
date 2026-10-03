import { readFileSync, existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const csv = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
const bool = z.union([z.boolean(), z.string()]).transform((v) => (typeof v === "boolean" ? v : /^(1|true|yes|on)$/i.test(v)));
const int = z.union([z.number(), z.string()]).transform((v) => (typeof v === "number" ? v : Number.parseInt(v, 10))).pipe(z.number().int());
const list = z.union([z.array(z.string()), z.string()]).transform((v) => (Array.isArray(v) ? v : csv(v)));

/** What identifies a door on the console. Every door needs its own garage-mounted sensor (ADR-0020). */
const doorMappingShape = {
  name: z.string().trim().min(1).max(48).optional(),
  relayId: z.string().optional(),
  outputId: int.optional(),
  sensorId: z.string().optional(),
  interiorCameraId: z.string().optional(),
  drivewayCameraId: z.string().optional(),
};

export const ConfigSchema = z.object({
  host: z.string().default("0.0.0.0"),
  port: int.default(8787),
  logLevel: z.string().default("info"),
  logPretty: bool.default(false),
  tz: z.string().default("UTC"),
  publicUrl: z.string().url().optional(),
  dataDir: z.string().default("./data"),
  validateResponses: bool.default(false),
  /** Trust `X-Forwarded-For` when the bridge sits behind a reverse proxy or tunnel. Without it every
   *  request appears to come from the proxy, so the per-IP limits on the unauthenticated routes
   *  (invite claim, Alarm Manager webhook) collapse into one shared bucket. Only enable when a proxy
   *  you control actually sets the header — otherwise a client can forge its own address. */
  trustProxy: bool.default(false),
  /** Print a single-use pairing invite at startup while no phone has joined (see src/pairing.ts). */
  pairingBanner: bool.default(true),
  /** mDNS advertising; defaults to true in live mode, false in mock. */
  bonjour: bool.optional(),
  /** Caps on concurrent `/v1/events` streams. Each stream holds a socket, five bus listeners and a
   *  heartbeat timer, so an authenticated client could otherwise exhaust the process by opening many. */
  sse: z.object({ maxPerToken: int.default(8), maxTotal: int.default(64) }).prefault({}),
  protect: z
    .object({
      url: z.string().url().optional(),
      apiKey: z.string().optional(),
      tls: z
        .string()
        .transform(normalizeTls)
        .pipe(z.string().regex(/^(insecure|system|fingerprint:[0-9a-f]{64})$/, {
          message: "PROTECT_TLS must be `insecure`, `system`, or `fingerprint:<64 hex sha256>` (colons/case ignored)",
        }))
        .default("insecure"),
    })
    .prefault({}),
  bridge: z
    .object({
      tokens: list.default([]),
      tokenNames: list.default([]),
      mode: z.enum(["live", "mock"]).default("live"),
      webhookSecret: z.string().min(16).optional(),
      mockTokenPrefix: z.string().default("demo-"),
      mockIdleMinutes: int.default(60),
      /** Doors the simulator has (mock mode): 2 adds a second relay output and its own sensor. */
      mockDoors: int.pipe(z.number().min(1).max(2)).default(1),
    })
    .prefault({}),
  /**
   * The first door, `d1`. Its timings are also the default for every other door. They stay optional here so
   * that `DOOR_TRAVEL_SECONDS` can be told apart from "nothing set": `doorSpecs()` applies `DOOR_TIMING_DEFAULTS`
   * after the YAML list, where a schema default would have beaten `doors[0].travelSeconds` and lost to it.
   */
  door: z
    .object({
      ...doorMappingShape,
      travelSeconds: int.optional(),
      verifyAfterSeconds: int.optional(),
    })
    .prefault({}),
  /** The second door, `d2` (`DOOR2_*`). Unlike `d1` it is never discovered: relay, output and sensor must all be named. */
  door2: z.object({ ...doorMappingShape, travelSeconds: int.optional(), verifyAfterSeconds: int.optional() }).prefault({}),
  /** YAML only: the whole list, `d1` first. `door` / `door2` (and so `DOOR_*` / `DOOR2_*`) override its first two entries. */
  doors: z.array(z.object({ ...doorMappingShape, travelSeconds: int.optional(), verifyAfterSeconds: int.optional() })).optional(),
  relay: z.object({ pulseMode: z.enum(["native", "emulated"]).default("emulated"), pulseMs: int.default(800), releaseMs: int.default(300) }).prefault({}),
  poll: z.object({ movingMs: int.default(2000), idleMs: int.default(15000) }).prefault({}),
  alerts: z
    .object({
      openTooLongMinutes: int.default(15),
      nightlyTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default("22:00"),
      nightlyAutoclose: bool.default(false),
      vehicleGraceSeconds: int.default(120),
      vehicleDoorOpenMinutes: int.default(5),
    })
    .prefault({}),
  /** `retentionDays: 0` keeps the audit log forever (the default); any positive value prunes daily. */
  audit: z.object({ retentionDays: int.default(0) }).prefault({}),
  features: z.object({ lpr: bool.default(false) }).prefault({}),
  lpr: z.object({ knownPlates: list.default([]), departGraceMinutes: int.default(3), undoSeconds: int.default(60) }).prefault({}),
  ntfy: z.object({ url: z.string().url().optional(), topic: z.string().optional(), token: z.string().optional() }).prefault({}),
  events: z.object({ webhookUrl: z.string().url().optional(), webhookSecret: z.string().optional() }).prefault({}),
});

export type Config = z.infer<typeof ConfigSchema>;
export type ConfigInput = z.input<typeof ConfigSchema>;

/** ENV name → dotted path in the config object. */
export const ENV_MAP: Record<string, string> = {
  HOST: "host",
  PORT: "port",
  LOG_LEVEL: "logLevel",
  LOG_PRETTY: "logPretty",
  TZ: "tz",
  PUBLIC_URL: "publicUrl",
  DATA_DIR: "dataDir",
  VALIDATE_RESPONSES: "validateResponses",
  TRUST_PROXY: "trustProxy",
  PAIRING_BANNER: "pairingBanner",
  SSE_MAX_PER_TOKEN: "sse.maxPerToken",
  SSE_MAX_TOTAL: "sse.maxTotal",
  PROTECT_URL: "protect.url",
  PROTECT_API_KEY: "protect.apiKey",
  PROTECT_TLS: "protect.tls",
  BRIDGE_TOKENS: "bridge.tokens",
  BRIDGE_TOKEN_NAMES: "bridge.tokenNames",
  BONJOUR: "bonjour",
  BRIDGE_MODE: "bridge.mode",
  WEBHOOK_SECRET: "bridge.webhookSecret",
  MOCK_TOKEN_PREFIX: "bridge.mockTokenPrefix",
  MOCK_IDLE_MINUTES: "bridge.mockIdleMinutes",
  MOCK_DOORS: "bridge.mockDoors",
  DOOR_NAME: "door.name",
  DOOR_RELAY_ID: "door.relayId",
  DOOR_OUTPUT_ID: "door.outputId",
  DOOR_SENSOR_ID: "door.sensorId",
  DOOR_INTERIOR_CAMERA_ID: "door.interiorCameraId",
  DOOR_DRIVEWAY_CAMERA_ID: "door.drivewayCameraId",
  DOOR_TRAVEL_SECONDS: "door.travelSeconds",
  DOOR_VERIFY_AFTER_SECONDS: "door.verifyAfterSeconds",
  DOOR2_NAME: "door2.name",
  DOOR2_RELAY_ID: "door2.relayId",
  DOOR2_OUTPUT_ID: "door2.outputId",
  DOOR2_SENSOR_ID: "door2.sensorId",
  DOOR2_INTERIOR_CAMERA_ID: "door2.interiorCameraId",
  DOOR2_DRIVEWAY_CAMERA_ID: "door2.drivewayCameraId",
  DOOR2_TRAVEL_SECONDS: "door2.travelSeconds",
  DOOR2_VERIFY_AFTER_SECONDS: "door2.verifyAfterSeconds",
  RELAY_PULSE_MODE: "relay.pulseMode",
  RELAY_PULSE_MS: "relay.pulseMs",
  RELAY_RELEASE_MS: "relay.releaseMs",
  POLL_MOVING_MS: "poll.movingMs",
  POLL_IDLE_MS: "poll.idleMs",
  ALERT_OPEN_TOO_LONG_MINUTES: "alerts.openTooLongMinutes",
  ALERT_NIGHTLY_TIME: "alerts.nightlyTime",
  ALERT_NIGHTLY_AUTOCLOSE: "alerts.nightlyAutoclose",
  ALERT_VEHICLE_GRACE_SECONDS: "alerts.vehicleGraceSeconds",
  ALERT_VEHICLE_DOOR_OPEN_MINUTES: "alerts.vehicleDoorOpenMinutes",
  AUDIT_RETENTION_DAYS: "audit.retentionDays",
  FEATURES_LPR: "features.lpr",
  LPR_KNOWN_PLATES: "lpr.knownPlates",
  LPR_DEPART_GRACE_MINUTES: "lpr.departGraceMinutes",
  LPR_UNDO_SECONDS: "lpr.undoSeconds",
  NTFY_URL: "ntfy.url",
  NTFY_TOPIC: "ntfy.topic",
  NTFY_TOKEN: "ntfy.token",
  EVENTS_WEBHOOK_URL: "events.webhookUrl",
  EVENTS_WEBHOOK_SECRET: "events.webhookSecret",
};

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]!;
    if (typeof cur[p] !== "object" || cur[p] === null) cur[p] = {};
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

/** Accepts the usual copy-paste variants of a certificate fingerprint. */
export function normalizeTls(v: string): string {
  // Tolerate quotes and trailing inline comments pasted from .env-style files.
  const t = v.replace(/\s+#.*$/, "").trim().replace(/^["']|["']$/g, "");
  if (t === "insecure" || t === "system") return t;
  const m = /^(?:fingerprint:)?(?:sha-?256(?:\s+fingerprint)?\s*[:=]\s*)?([0-9a-fA-F:\s]+)$/i.exec(t);
  if (!m) return t;
  const hex = m[1]!.replace(/[:\s]/g, "").toLowerCase();
  return hex.length === 64 ? `fingerprint:${hex}` : t;
}

function redact(name: string, value: string): string {
  return /KEY|TOKEN|SECRET/.test(name) ? `${value.slice(0, 3)}…(${value.length} chars)` : value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, configFile?: string): Config {
  const raw: Record<string, unknown> = {};
  const file = configFile ?? env.CONFIG_FILE;
  if (file && existsSync(file)) {
    const parsed = parseYaml(readFileSync(file, "utf8")) as Record<string, unknown> | null;
    if (parsed && typeof parsed === "object") Object.assign(raw, structuredClone(parsed));
  }
  for (const [name, path] of Object.entries(ENV_MAP)) {
    const v = env[name];
    if (v !== undefined && v !== "") setPath(raw, path, v);
  }
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map((i) => {
      const path = i.path.join(".");
      const envName = Object.entries(ENV_MAP).find(([, p]) => p === path)?.[0];
      const got = envName && env[envName] !== undefined ? ` (got ${JSON.stringify(redact(envName, env[envName]!))})` : "";
      return `${envName ?? path}: ${i.message}${got}`;
    });
    throw new Error(`Invalid bridge configuration:\n  ${lines.join("\n  ")}`);
  }
  const cfg = result.data;
  validateMode(cfg);
  return cfg;
}

/** Admin tokens open the door, so they are held to a generated-secret standard, not a password one. */
export const MIN_TOKEN_LENGTH = 24;

/** Rejected outright: these are what people actually type when a field says "token". */
const WEAK_TOKENS = new Set(["changeme", "password", "secret", "token", "garage", "admin", "bridge", "test", "demo"]);

export function assertStrongToken(token: string, label = "BRIDGE_TOKENS"): void {
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error(`${label} entries must be at least ${MIN_TOKEN_LENGTH} characters (generate one with \`openssl rand -hex 24\`)`);
  }
  const lower = token.toLowerCase();
  if (WEAK_TOKENS.has(lower) || [...WEAK_TOKENS].some((w) => lower.startsWith(w) && /^[a-z]+[0-9]*$/.test(lower))) {
    throw new Error(`${label} contains a guessable value; generate one with \`openssl rand -hex 24\``);
  }
  if (new Set(token).size < 5) throw new Error(`${label} contains a low-entropy value; generate one with \`openssl rand -hex 24\``);
}

/** Hosts where a self-signed console certificate is a fact of life rather than a red flag. */
export function isLanHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".lan") || h.endsWith(".internal") || h.endsWith(".home.arpa")) return true;
  if (/^127\./.test(h) || h === "::1") return true;
  if (/^10\./.test(h) || /^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h)) return true; // ULA / link-local
  return false;
}

/** One configured door: its id, what the configuration names explicitly, and its timings. */
export interface DoorSpec {
  /** `d1`, `d2`, … by position. Stable for an install because the configuration is (ADR-0020). */
  id: string;
  name?: string;
  relayId?: string;
  outputId?: number;
  sensorId?: string;
  interiorCameraId?: string;
  drivewayCameraId?: string;
  travelSeconds: number;
  verifyAfterSeconds: number;
}

export const doorIdAt = (index: number): string => `d${index + 1}`;

/** What a door's timings are when nothing names them: 15 s of travel, then 3 s before the sensor is believed. */
export const DOOR_TIMING_DEFAULTS = { travelSeconds: 15, verifyAfterSeconds: 3 } as const;

const MAPPING_KEYS = ["name", "relayId", "outputId", "sensorId", "interiorCameraId", "drivewayCameraId"] as const;

/**
 * The doors this configuration describes. A 0.5-style configuration (`DOOR_*` only, or nothing at all) is
 * exactly one door, `d1`, which may still be discovered or restored from the saved mapping. Any further door
 * is only ever what was written down.
 */
export function doorSpecs(cfg: Config): DoorSpec[] {
  const listed = cfg.doors ?? [];
  const door2Set = MAPPING_KEYS.some((k) => cfg.door2[k] !== undefined);
  const count = Math.max(1, listed.length, door2Set ? 2 : 1);
  const specs: DoorSpec[] = [];
  for (let i = 0; i < count; i++) {
    const base = listed[i] ?? {};
    const over = i === 0 ? cfg.door : i === 1 ? cfg.door2 : {};
    // Precedence: this door's own `DOOR*_` setting, then its YAML entry, then `d1`'s settings (`DOOR_*` over
    // `doors[0]`), then the defaults. An env setting is never shadowed by a YAML value, as documented.
    const d1Travel = cfg.door.travelSeconds ?? listed[0]?.travelSeconds ?? DOOR_TIMING_DEFAULTS.travelSeconds;
    const d1Verify = cfg.door.verifyAfterSeconds ?? listed[0]?.verifyAfterSeconds ?? DOOR_TIMING_DEFAULTS.verifyAfterSeconds;
    const spec: DoorSpec = {
      id: doorIdAt(i),
      travelSeconds: (i === 1 ? cfg.door2.travelSeconds : undefined) ?? (i > 0 ? base.travelSeconds : undefined) ?? d1Travel,
      verifyAfterSeconds: (i === 1 ? cfg.door2.verifyAfterSeconds : undefined) ?? (i > 0 ? base.verifyAfterSeconds : undefined) ?? d1Verify,
    };
    for (const k of MAPPING_KEYS) {
      const v = (over as Partial<DoorSpec>)[k] ?? base[k];
      if (v !== undefined) (spec as unknown as Record<string, unknown>)[k] = v;
    }
    specs.push(spec);
  }
  return specs;
}

/** `LPR_KNOWN_PLATES` entries: `ABC123` belongs to `d1` as before, `ABC123:d2` to the named door. */
export function platesByDoor(entries: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const entry of entries) {
    const m = /^(.*):\s*(d[1-9]\d*)\s*$/i.exec(entry);
    const doorId = m ? m[2]!.toLowerCase() : doorIdAt(0);
    const plate = (m ? m[1]! : entry).trim();
    if (!plate) continue;
    out.set(doorId, [...(out.get(doorId) ?? []), plate]);
  }
  return out;
}

function validateDoors(cfg: Config): void {
  const specs = doorSpecs(cfg);
  const env = (i: number, key: string) => (i === 0 ? `DOOR_${key}` : i === 1 ? `DOOR2_${key}` : `doors[${i}].${key}`);
  // The two-door simulator has a fixed mapping, so there DOOR2_NAME alone is a complete second door.
  const simulated = cfg.bridge.mode === "mock" && cfg.bridge.mockDoors > 1;
  specs.forEach((d, i) => {
    if (i === 0 || simulated) return; // d1 may be discovered or restored from the saved mapping
    const missing = [d.relayId === undefined && env(i, "RELAY_ID"), d.outputId === undefined && env(i, "OUTPUT_ID"), d.sensorId === undefined && env(i, "SENSOR_ID")].filter(Boolean);
    if (missing.length) {
      throw new Error(
        `door ${d.id} is incomplete: set ${missing.join(", ")}. A second door is never guessed: it needs its relay output and its own garage-mounted sensor written down (GET /v1/discovery lists the ids).`,
      );
    }
  });
  for (let i = 0; i < specs.length; i++) {
    for (let j = i + 1; j < specs.length; j++) {
      const a = specs[i]!;
      const b = specs[j]!;
      if (a.sensorId !== undefined && a.sensorId === b.sensorId) throw new Error(`doors ${a.id} and ${b.id} name the same sensor (${env(j, "SENSOR_ID")}): every door needs its own`);
      if (a.relayId !== undefined && a.relayId === b.relayId && a.outputId !== undefined && a.outputId === b.outputId) {
        throw new Error(`doors ${a.id} and ${b.id} name the same relay output (${env(j, "OUTPUT_ID")}): one output moves one door`);
      }
    }
  }
  const doorCount = cfg.bridge.mode === "mock" ? Math.max(specs.length, cfg.bridge.mockDoors) : specs.length;
  for (const doorId of platesByDoor(cfg.lpr.knownPlates).keys()) {
    if (Number(doorId.slice(1)) > doorCount) throw new Error(`LPR_KNOWN_PLATES ties a plate to ${doorId}, but this install has ${doorCount} door${doorCount === 1 ? "" : "s"}`);
  }
}

export function validateMode(cfg: Config): void {
  validateDoors(cfg);
  if (cfg.bridge.mode === "live") {
    if (!cfg.protect.url || !cfg.protect.apiKey) throw new Error("live mode requires PROTECT_URL and PROTECT_API_KEY");
    if (cfg.bridge.tokens.length === 0) throw new Error("live mode requires at least one BRIDGE_TOKENS entry");
    for (const t of cfg.bridge.tokens) assertStrongToken(t);
    // `insecure` skips certificate verification entirely. On a LAN that is the pragmatic default for the
    // console's self-signed cert; across the internet it hands the Protect API key to any MITM.
    if (cfg.protect.tls === "insecure") {
      const host = (() => {
        try {
          return new URL(cfg.protect.url).hostname;
        } catch {
          return "";
        }
      })();
      if (host && !isLanHost(host)) {
        throw new Error(
          `PROTECT_TLS=insecure is refused for the non-LAN host ${host}: the Protect API key would be exposed to anyone on the path. ` +
            "Use PROTECT_TLS=fingerprint:<sha256> (see https://garageopener.app/self-hosting#certs) or PROTECT_TLS=system.",
        );
      }
    }
  }
  if (cfg.events.webhookUrl && !cfg.events.webhookSecret) throw new Error("EVENTS_WEBHOOK_SECRET is required with EVENTS_WEBHOOK_URL");
}

/** Build a config for tests / mock without touching process.env. */
export function makeConfig(input: ConfigInput = {}): Config {
  const cfg = ConfigSchema.parse(input);
  validateMode(cfg);
  return cfg;
}
