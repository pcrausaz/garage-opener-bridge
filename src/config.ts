import { readFileSync, existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const csv = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
const bool = z.union([z.boolean(), z.string()]).transform((v) => (typeof v === "boolean" ? v : /^(1|true|yes|on)$/i.test(v)));
const int = z.union([z.number(), z.string()]).transform((v) => (typeof v === "number" ? v : Number.parseInt(v, 10))).pipe(z.number().int());
const list = z.union([z.array(z.string()), z.string()]).transform((v) => (Array.isArray(v) ? v : csv(v)));

export const ConfigSchema = z.object({
  host: z.string().default("0.0.0.0"),
  port: int.default(8787),
  logLevel: z.string().default("info"),
  logPretty: bool.default(false),
  tz: z.string().default("UTC"),
  publicUrl: z.string().url().optional(),
  dataDir: z.string().default("./data"),
  validateResponses: bool.default(false),
  protect: z
    .object({
      url: z.string().url().optional(),
      apiKey: z.string().optional(),
      tls: z.string().regex(/^(insecure|system|fingerprint:[0-9a-fA-F:]{64,95})$/).default("insecure"),
    })
    .prefault({}),
  bridge: z
    .object({
      tokens: list.default([]),
      mode: z.enum(["live", "mock"]).default("live"),
      webhookSecret: z.string().min(16).optional(),
      mockTokenPrefix: z.string().default("demo-"),
      mockIdleMinutes: int.default(60),
    })
    .prefault({}),
  door: z
    .object({
      relayId: z.string().optional(),
      outputId: int.optional(),
      sensorId: z.string().optional(),
      interiorCameraId: z.string().optional(),
      drivewayCameraId: z.string().optional(),
      travelSeconds: int.default(15),
      verifyAfterSeconds: int.default(3),
    })
    .prefault({}),
  relay: z.object({ pulseMode: z.enum(["native", "emulated"]).default("native"), pulseMs: int.default(500) }).prefault({}),
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
  PROTECT_URL: "protect.url",
  PROTECT_API_KEY: "protect.apiKey",
  PROTECT_TLS: "protect.tls",
  BRIDGE_TOKENS: "bridge.tokens",
  BRIDGE_MODE: "bridge.mode",
  WEBHOOK_SECRET: "bridge.webhookSecret",
  MOCK_TOKEN_PREFIX: "bridge.mockTokenPrefix",
  MOCK_IDLE_MINUTES: "bridge.mockIdleMinutes",
  DOOR_RELAY_ID: "door.relayId",
  DOOR_OUTPUT_ID: "door.outputId",
  DOOR_SENSOR_ID: "door.sensorId",
  DOOR_INTERIOR_CAMERA_ID: "door.interiorCameraId",
  DOOR_DRIVEWAY_CAMERA_ID: "door.drivewayCameraId",
  DOOR_TRAVEL_SECONDS: "door.travelSeconds",
  DOOR_VERIFY_AFTER_SECONDS: "door.verifyAfterSeconds",
  RELAY_PULSE_MODE: "relay.pulseMode",
  RELAY_PULSE_MS: "relay.pulseMs",
  POLL_MOVING_MS: "poll.movingMs",
  POLL_IDLE_MS: "poll.idleMs",
  ALERT_OPEN_TOO_LONG_MINUTES: "alerts.openTooLongMinutes",
  ALERT_NIGHTLY_TIME: "alerts.nightlyTime",
  ALERT_NIGHTLY_AUTOCLOSE: "alerts.nightlyAutoclose",
  ALERT_VEHICLE_GRACE_SECONDS: "alerts.vehicleGraceSeconds",
  ALERT_VEHICLE_DOOR_OPEN_MINUTES: "alerts.vehicleDoorOpenMinutes",
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
  const cfg = ConfigSchema.parse(raw);
  validateMode(cfg);
  return cfg;
}

export function validateMode(cfg: Config): void {
  if (cfg.bridge.mode === "live") {
    if (!cfg.protect.url || !cfg.protect.apiKey) throw new Error("live mode requires PROTECT_URL and PROTECT_API_KEY");
    if (cfg.bridge.tokens.length === 0) throw new Error("live mode requires at least one BRIDGE_TOKENS entry");
    for (const t of cfg.bridge.tokens) if (t.length < 8) throw new Error("bridge tokens must be at least 8 characters");
  }
  if (cfg.events.webhookUrl && !cfg.events.webhookSecret) throw new Error("EVENTS_WEBHOOK_SECRET is required with EVENTS_WEBHOOK_URL");
}

/** Build a config for tests / mock without touching process.env. */
export function makeConfig(input: ConfigInput = {}): Config {
  const cfg = ConfigSchema.parse(input);
  validateMode(cfg);
  return cfg;
}
