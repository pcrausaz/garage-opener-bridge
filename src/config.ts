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
  DOOR_RELAY_ID: "door.relayId",
  DOOR_OUTPUT_ID: "door.outputId",
  DOOR_SENSOR_ID: "door.sensorId",
  DOOR_INTERIOR_CAMERA_ID: "door.interiorCameraId",
  DOOR_DRIVEWAY_CAMERA_ID: "door.drivewayCameraId",
  DOOR_TRAVEL_SECONDS: "door.travelSeconds",
  DOOR_VERIFY_AFTER_SECONDS: "door.verifyAfterSeconds",
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

export function validateMode(cfg: Config): void {
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
