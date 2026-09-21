import { join } from "node:path";
import type { Config } from "./config.js";
import type { Logger } from "./logger.js";
import type { ProtectClient } from "./protect/types.js";
import { HttpProtectClient } from "./protect/client.js";
import { DEMO_PLATE, ProtectSimulator, SIM_IDS, type SimulatorOptions } from "./protect/simulator.js";
import { discover, type DiscoveryResult, type DoorMapping } from "./discovery.js";
import { Store } from "./store/db.js";
import { AuditRetention } from "./store/retention.js";
import { Bus } from "./events/bus.js";
import { LiveDoorService, type DoorService } from "./door/service.js";
import { HoldService } from "./hold.js";
import { VehicleTracker } from "./alerts/vehicle.js";
import { AlertEngine } from "./alerts/engine.js";
import { LprEngine } from "./lpr/engine.js";
import { Notifier } from "./notify/notifier.js";
import { NtfyTransport } from "./notify/ntfy.js";
import { OutboundWebhook } from "./notify/webhook.js";
import type { NotificationTransport } from "./notify/transport.js";
import { deviceMatches, type ClassifiedEvent } from "./webhooks/classify.js";
import { VERSION } from "./version.js";
import { MembersService } from "./members.js";
import { iso, type Health, type State } from "./types.js";

/** One fully wired bridge: live mode has exactly one; mock mode has one per bearer token. */
export class Instance {
  readonly bus = new Bus();
  readonly store: Store;
  readonly protect: ProtectClient;
  readonly sim: ProtectSimulator | null;
  readonly hold: HoldService;
  readonly vehicle: VehicleTracker;
  readonly notifier: Notifier;
  readonly webhook: OutboundWebhook | null;
  readonly members: MembersService;
  readonly retention: AuditRetention;
  door!: DoorService;
  alerts!: AlertEngine;
  lpr: LprEngine | null = null;
  discovery: DiscoveryResult | null = null;
  lastTouched = Date.now();
  private protectOk = false;
  private protectVersion: string | undefined;
  private protectError: string | undefined;
  /** True once start() completed; API routes answer 503 before that. */
  ready = false;
  startError: string | undefined;
  private protectLastOk: number | undefined;
  private readonly log: Logger;

  constructor(
    readonly config: Config,
    logger: Logger,
    readonly mode: "live" | "mock",
    opts: { protect?: ProtectClient; storeFile?: string; transports?: NotificationTransport[]; label?: string; simulator?: Partial<SimulatorOptions> } = {},
  ) {
    this.log = logger.child({ component: "instance", label: opts.label ?? mode });
    if (mode === "mock") {
      this.sim = opts.protect ? null : new ProtectSimulator({ travelMs: config.door.travelSeconds * 1000, ...(opts.simulator ?? {}) });
      this.protect = opts.protect ?? this.sim!;
      this.store = new Store(opts.storeFile ?? ":memory:");
    } else {
      this.sim = null;
      this.protect =
        opts.protect ?? new HttpProtectClient({ baseUrl: config.protect.url!, apiKey: config.protect.apiKey!, tls: config.protect.tls, logger });
      this.store = new Store(opts.storeFile ?? join(config.dataDir, "bridge.db"));
    }
    this.retention = new AuditRetention(this.store, config.audit.retentionDays, this.log);
    this.members = new MembersService(this.store);
    this.members.ensureAdmins(config.bridge.tokens, config.bridge.tokenNames);
    this.hold = new HoldService(this.store, this.bus);
    this.vehicle = new VehicleTracker(this.bus, config.alerts.vehicleGraceSeconds * 1000, mode === "mock" ? "mock" : "camera-heuristic");
    const transports: NotificationTransport[] = opts.transports ? [...opts.transports] : [];
    if (!opts.transports && config.ntfy.url && config.ntfy.topic) {
      transports.push(
        new NtfyTransport({ url: config.ntfy.url, topic: config.ntfy.topic, token: config.ntfy.token, publicUrl: config.publicUrl, actionToken: config.bridge.tokens[0], logger }),
      );
    }
    this.webhook = !opts.transports && config.events.webhookUrl && config.events.webhookSecret ? new OutboundWebhook({ url: config.events.webhookUrl, secret: config.events.webhookSecret, logger }) : null;
    if (this.webhook) {
      transports.push(this.webhook);
      this.webhook.attach(this.bus);
    }
    this.notifier = new Notifier(transports, this.bus, this.store, logger);
  }

  async start(): Promise<void> {
    const c = this.config;
    this.retention.start();
    const explicit: Partial<DoorMapping> = {
      relayId: c.door.relayId,
      outputId: c.door.outputId,
      sensorId: c.door.sensorId,
      interiorCameraId: c.door.interiorCameraId,
      drivewayCameraId: c.door.drivewayCameraId,
    };
    const saved = this.store.get<DoorMapping>("mapping");
    try {
      const meta = await this.protect.getMetaInfo();
      this.protectVersion = meta.applicationVersion;
      this.discovery = await discover(this.protect, saved, explicit);
      this.protectOk = true;
      this.protectLastOk = Date.now();
    } catch (err) {
      this.protectError = (err as Error).message;
      this.log.error({ err }, "console unreachable at start");
      if (!saved && !(explicit.relayId && explicit.sensorId && explicit.outputId !== undefined)) throw new Error("cannot start: console unreachable and no door mapping configured");
    }
    const mapping = this.discovery?.current ?? saved ?? (explicit as DoorMapping);
    if (!mapping?.relayId || !mapping.sensorId || mapping.outputId === undefined) {
      throw new Error("no door mapping: set DOOR_RELAY_ID, DOOR_OUTPUT_ID and DOOR_SENSOR_ID (see GET /v1/discovery)");
    }
    this.store.set("mapping", mapping);
    if (this.discovery?.autoPaired) this.store.set("autoPaired", true);
    if (this.ready) return;
    this.door = new LiveDoorService({ protect: this.protect, store: this.store, bus: this.bus, logger: this.log, config: c, mapping, buildState: () => this.state() });
    this.bus.on("state", (s) => {
      this.protectOk = s.connectionOk;
      if (s.connectionOk) this.protectLastOk = Date.now();
    });
    await this.door.start();
    this.alerts = new AlertEngine(
      { bus: this.bus, door: this.door, hold: this.hold, notifier: this.notifier, vehicle: this.vehicle, logger: this.log },
      { openTooLongMinutes: c.alerts.openTooLongMinutes, nightlyTime: c.alerts.nightlyTime, nightlyAutoclose: c.alerts.nightlyAutoclose, vehicleDoorOpenMinutes: c.alerts.vehicleDoorOpenMinutes, tz: c.tz },
    );
    this.alerts.start();
    if (c.features.lpr || this.mode === "mock") {
      this.lpr = new LprEngine(
        { bus: this.bus, door: this.door, hold: this.hold, notifier: this.notifier, vehicle: this.vehicle, store: this.store, logger: this.log },
        { knownPlates: this.mode === "mock" && c.lpr.knownPlates.length === 0 ? [DEMO_PLATE] : c.lpr.knownPlates, departGraceMinutes: c.lpr.departGraceMinutes, undoSeconds: c.lpr.undoSeconds },
      );
      this.lpr.start();
    }
    this.bus.on("protect-event", (e) => void this.onProtectEvent(e));
    this.ready = true;
    this.startError = undefined;
    this.log.info({ mapping, mode: this.mode, lpr: !!this.lpr }, "instance started");
  }

  async stop(): Promise<void> {
    this.retention.stop();
    await (this.door as DoorService | undefined)?.stop();
    this.alerts?.stop();
    this.lpr?.stop();
    this.hold.stop();
    this.vehicle.stop();
    await this.protect.close();
    this.store.close();
  }

  touch(): void {
    this.lastTouched = Date.now();
  }

  /** Route a classified Protect event (webhook or mock) to the right component. */
  async onProtectEvent(e: ClassifiedEvent): Promise<void> {
    const m = this.door.mapping;
    const sensorMatch = !e.device || deviceMatches(e.device, m.sensorId, this.discoveryMac("sensor", m.sensorId));
    const interior = !e.device || deviceMatches(e.device, m.interiorCameraId, this.discoveryMac("camera", m.interiorCameraId));
    const driveway = !e.device || deviceMatches(e.device, m.drivewayCameraId, this.discoveryMac("camera", m.drivewayCameraId));
    this.store.audit({ kind: e.source === "mock" ? "mock" : "webhook", source: e.source, outcome: "ok", detail: `${e.type}${e.device ? " " + e.device : ""}${e.plate ? " " + e.plate : ""}` });
    switch (e.type) {
      case "opened":
      case "closed":
        if (sensorMatch) this.door.applySensorEvent(e.type === "opened", e.at);
        break;
      case "vehicle-start":
        if (interior) this.vehicle.detectionStarted(e.at);
        break;
      case "vehicle-end":
        if (interior) this.vehicle.detectionEnded(e.at);
        break;
      case "plate":
        if (driveway && e.plate && this.lpr) await this.lpr.onPlateSeen(e.plate);
        break;
      default:
        this.log.debug({ e }, "unclassified protect event");
    }
  }

  private discoveryMac(_kind: "sensor" | "camera", _id: string | null | undefined): string | undefined {
    return undefined; // fixtures strip MACs; live discovery could map id→mac here in a later revision
  }

  state(): State {
    const snap = this.door.snapshot();
    const s: State = {
      ...snap,
      hold: this.hold.get(),
      vehicle: this.vehicle.get(),
      mode: this.mode,
      openTooLongMinutes: this.config.alerts.openTooLongMinutes,
      travelSeconds: this.config.door.travelSeconds,
    };
    return s;
  }

  health(): Health {
    const h: Health = { ok: this.ready, ready: this.ready, mode: this.mode, version: VERSION, protect: { ok: this.protectOk } };
    if (!this.ready && this.startError) h.lastError = this.startError;
    if (this.protectVersion) h.protect.applicationVersion = this.protectVersion;
    if (this.protectLastOk) h.protect.lastSuccessAt = iso(this.protectLastOk);
    if (!this.protectOk && this.protectError) h.protect.error = this.protectError;
    const warnings: string[] = [];
    if (this.ready && this.door.snapshot().relay.outputStuck) warnings.push("relay_output_stuck");
    if (warnings.length) h.warnings = warnings;
    return h;
  }

  async discoveryNow(): Promise<DiscoveryResult> {
    const saved = this.store.get<DoorMapping>("mapping");
    this.discovery = await discover(this.protect, saved, {});
    this.discovery.autoPaired = this.store.get<boolean>("autoPaired") === true;
    return this.discovery;
  }

  /** Mock-only controls. */
  async mockAction(action: string, body: { plate?: string } = {}): Promise<State> {
    if (this.mode !== "mock" || !this.sim) throw new Error("not mock");
    const at = Date.now();
    switch (action) {
      case "vehicle-arrived":
        await this.onProtectEvent({ type: "vehicle-start", device: SIM_IDS.interiorCameraId, at, source: "mock" });
        break;
      case "vehicle-left":
        this.vehicle.force(false, at);
        this.store.audit({ kind: "mock", source: "mock", outcome: "ok", detail: "vehicle-left" });
        break;
      case "plate-seen":
        if (!body.plate) throw new RangeError("plate is required");
        await this.onProtectEvent({ type: "plate", device: SIM_IDS.drivewayCameraId, plate: body.plate, at, source: "mock" });
        break;
      case "reverse-next-close":
        this.sim.reverseNextClose = true;
        this.store.audit({ kind: "mock", source: "mock", outcome: "ok", detail: "reverse-next-close armed" });
        break;
      case "reset":
        this.sim.reset();
        this.hold.clear("mock");
        this.vehicle.force(false, at);
        // settle(), not refresh(): a reset during travel must also drop the in-flight command, or the door
        // stays OPENING and the abandoned deadline declares it STUCK on an already-closed simulator.
        await this.door.settle();
        this.store.audit({ kind: "mock", source: "mock", outcome: "ok", detail: "reset" });
        break;
      default:
        throw new RangeError(`unknown mock action ${action}`);
    }
    return this.state();
  }
}

export interface RetryOptions {
  baseMs?: number;
  maxMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Stop retrying when this returns true (used on shutdown). */
  stopped?: () => boolean;
}

/**
 * Start an instance with exponential backoff (2 s → 60 s cap) until it succeeds. Failures are logged at
 * warn and exposed through `instance.startError` / `/healthz`. Never throws.
 */
export async function startWithRetry(instance: Instance, logger: Logger, o: RetryOptions = {}): Promise<void> {
  const base = o.baseMs ?? 2000;
  const max = o.maxMs ?? 60_000;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let delay = base;
  for (let attempt = 1; ; attempt++) {
    if (o.stopped?.()) return;
    try {
      await instance.start();
      return;
    } catch (err) {
      const message = (err as Error).message;
      instance.startError = message;
      logger.warn({ attempt, retryInMs: delay, error: message }, "bridge startup failed; retrying");
      await sleep(delay);
      delay = Math.min(delay * 2, max);
    }
  }
}
