import { join } from "node:path";
import { EventEmitter } from "node:events";
import { doorIdAt, doorSpecs, platesByDoor, type Config, type DoorSpec } from "./config.js";
import type { Logger } from "./logger.js";
import type { ProtectClient } from "./protect/types.js";
import { HttpProtectClient } from "./protect/client.js";
import { DEMO_PLATE, ProtectSimulator, SIM_IDS, SIM_IDS_2, type SimulatorOptions } from "./protect/simulator.js";
import { deviceMacs, discover, listDevices, pairingAsEnv, type DeviceKind, type DiscoveryResult, type DoorMapping } from "./discovery.js";
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
import { SnapshotCache } from "./camera/snapshots.js";
import { deviceMatches, normalizePlate, type ClassifiedEvent } from "./webhooks/classify.js";
import { VERSION } from "./version.js";
import { MembersService } from "./members.js";
import { iso, type CommandResult, type Door, type Health, type State } from "./types.js";

/**
 * One door and everything that is per door (ADR-0020): its state machine, hold-open, vehicle presence, alert
 * rules and plate rules, on a bus of its own so that nothing written for one door can hear another's events.
 */
export interface DoorUnit {
  readonly id: string;
  readonly spec: DoorSpec;
  readonly mapping: DoorMapping;
  readonly bus: Bus;
  readonly hold: HoldService;
  readonly vehicle: VehicleTracker;
  readonly notifier: Notifier;
  door: DoorService;
  alerts: AlertEngine;
  lpr: LprEngine | null;
}

/** One fully wired bridge: live mode has exactly one; mock mode has one per bearer token. */
export class Instance {
  /** The first door's bus, and where inbound Protect events arrive whichever door they are for. */
  readonly bus: Bus;
  readonly store: Store;
  readonly protect: ProtectClient;
  readonly sim: ProtectSimulator | null;
  readonly members: MembersService;
  readonly retention: AuditRetention;
  readonly snapshots: SnapshotCache;
  /** `changed` (member id) when a caller picks another default door; open event streams follow it. */
  readonly defaults: EventEmitter<{ changed: [string] }>;
  /**
   * Every open event stream listens on a door's bus and, when it follows the caller's default door, on
   * `defaults` too, so the cap on listeners is the cap on streams plus the bridge's own few per event.
   */
  private readonly maxListeners: number;
  /** Every door, `d1` first. Empty until start() completed. */
  units: DoorUnit[] = [];
  // The first door's parts. A one-door install has nothing else, which is why these keep their old names.
  readonly hold: HoldService;
  readonly vehicle: VehicleTracker;
  readonly notifier: Notifier;
  readonly webhook: OutboundWebhook | null;
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
  private pairingHintLogged = false;
  /** `sensor:<id>` / `camera:<id>` → MAC, from the last discovery; Alarm Manager names devices by MAC. */
  private macs = new Map<string, string>();
  private readonly specs: DoorSpec[];
  private readonly transports: NotificationTransport[];
  private readonly logger: Logger;
  private readonly log: Logger;

  constructor(
    readonly config: Config,
    logger: Logger,
    readonly mode: "live" | "mock",
    opts: { protect?: ProtectClient; storeFile?: string; transports?: NotificationTransport[]; label?: string; simulator?: Partial<SimulatorOptions> } = {},
  ) {
    this.logger = logger;
    this.log = logger.child({ component: "instance", label: opts.label ?? mode });
    this.maxListeners = config.sse.maxTotal + 8;
    this.bus = new Bus(this.maxListeners);
    this.defaults = new EventEmitter<{ changed: [string] }>();
    this.defaults.setMaxListeners(this.maxListeners);
    if (mode === "mock") {
      this.sim = opts.protect ? null : new ProtectSimulator({ travelMs: doorSpecs(config)[0]!.travelSeconds * 1000, doors: config.bridge.mockDoors, ...(opts.simulator ?? {}) });
      this.protect = opts.protect ?? this.sim!;
      this.store = new Store(opts.storeFile ?? ":memory:");
    } else {
      this.sim = null;
      this.protect =
        opts.protect ?? new HttpProtectClient({ baseUrl: config.protect.url!, apiKey: config.protect.apiKey!, tls: config.protect.tls, logger });
      this.store = new Store(opts.storeFile ?? join(config.dataDir, "bridge.db"));
    }
    this.specs = this.resolveSpecs();
    const multi = this.specs.length > 1;
    this.retention = new AuditRetention(this.store, config.audit.retentionDays, this.log);
    this.members = new MembersService(this.store);
    this.members.ensureAdmins(config.bridge.tokens, config.bridge.tokenNames);
    this.hold = new HoldService(this.store, this.bus);
    this.vehicle = new VehicleTracker(this.bus, config.alerts.vehicleGraceSeconds * 1000, mode === "mock" ? "mock" : "camera-heuristic");
    const transports: NotificationTransport[] = opts.transports ? [...opts.transports] : [];
    if (!opts.transports && config.ntfy.url && config.ntfy.topic) {
      transports.push(
        new NtfyTransport({ url: config.ntfy.url, topic: config.ntfy.topic, token: config.ntfy.token, publicUrl: config.publicUrl, actionToken: config.bridge.tokens[0], doorScoped: multi, logger }),
      );
    }
    this.webhook = !opts.transports && config.events.webhookUrl && config.events.webhookSecret ? new OutboundWebhook({ url: config.events.webhookUrl, secret: config.events.webhookSecret, logger }) : null;
    if (this.webhook) {
      transports.push(this.webhook);
      this.webhook.attach(this.bus, multi ? doorIdAt(0) : undefined);
    }
    this.transports = transports;
    this.notifier = this.notifierFor(this.specs[0]!, this.bus);
    this.snapshots = new SnapshotCache({
      protect: this.protect,
      isMoving: (cameraId) => this.units.some((u) => u.mapping.interiorCameraId === cameraId && u.door.machine().moving !== null),
      logger,
    });
  }

  /** The doors of this instance. A two-door simulator has a fixed mapping; everything else is the configuration. */
  private resolveSpecs(): DoorSpec[] {
    const c = this.config;
    const configured = doorSpecs(c);
    if (!this.sim || this.sim.doors.length < 2) return configured;
    const first = configured[0]!;
    return [SIM_IDS, SIM_IDS_2].map((ids, i) => {
      const named = i === 0 ? c.door : c.door2;
      return {
        id: doorIdAt(i),
        ...(named.name ? { name: named.name } : {}),
        ...ids,
        travelSeconds: (i === 0 ? undefined : named.travelSeconds) ?? first.travelSeconds,
        verifyAfterSeconds: (i === 0 ? undefined : named.verifyAfterSeconds) ?? first.verifyAfterSeconds,
      };
    });
  }

  /** Notifications name the door whenever the install has more than one. */
  private notifierFor(spec: DoorSpec, bus: Bus): Notifier {
    const named = this.specs.length > 1;
    return new Notifier(this.transports, bus, this.store, this.logger, { id: spec.id, ...(named ? { name: () => this.doorName(spec.id) } : {}) });
  }

  async start(): Promise<void> {
    const c = this.config;
    this.retention.start();
    const first = this.specs[0]!;
    const explicit: Partial<DoorMapping> = {
      relayId: first.relayId,
      outputId: first.outputId,
      sensorId: first.sensorId,
      interiorCameraId: first.interiorCameraId,
      drivewayCameraId: first.drivewayCameraId,
    };
    const saved = this.store.get<DoorMapping>("mapping");
    try {
      const meta = await this.protect.getMetaInfo();
      this.protectVersion = meta.applicationVersion;
      const devices = await listDevices(this.protect);
      this.macs = deviceMacs(devices);
      this.discovery = await discover(this.protect, saved, explicit, devices);
      this.protectOk = true;
      this.protectLastOk = Date.now();
    } catch (err) {
      this.protectError = (err as Error).message;
      this.log.error({ err }, "console unreachable at start");
      if (!saved && !(explicit.relayId && explicit.sensorId && explicit.outputId !== undefined)) throw new Error("cannot start: console unreachable and no door mapping configured");
    }
    this.logPairingHint();
    const mapping = this.discovery?.current ?? saved ?? (explicit as DoorMapping);
    if (!mapping?.relayId || !mapping.sensorId || mapping.outputId === undefined) {
      throw new Error("no door mapping: set DOOR_RELAY_ID, DOOR_OUTPUT_ID and DOOR_SENSOR_ID (see GET /v1/discovery)");
    }
    // Only `d1` is ever discovered or remembered. Every further door is exactly what the configuration says.
    const mappings = [mapping, ...this.specs.slice(1).map(specMapping)];
    assertDistinctDoors(mappings);
    this.store.set("mapping", mapping);
    if (this.discovery?.autoPaired) this.store.set("autoPaired", true);
    if (this.ready) return;
    // The demo plate is known at every simulated door: the Simulate panel offers it for whichever door is shown.
    const plates = platesByDoor(this.mode === "mock" && c.lpr.knownPlates.length === 0 ? this.specs.map((s) => `${DEMO_PLATE}:${s.id}`) : c.lpr.knownPlates);
    const units: DoorUnit[] = [];
    this.units = units;
    for (const [i, spec] of this.specs.entries()) units.push(await this.startUnit(spec, mappings[i]!, i, plates.get(spec.id) ?? []));
    this.door = units[0]!.door;
    this.alerts = units[0]!.alerts;
    this.lpr = units[0]!.lpr;
    this.bus.on("protect-event", (e) => void this.onProtectEvent(e));
    this.ready = true;
    this.startError = undefined;
    this.log.info({ mapping, mode: this.mode, lpr: !!this.lpr, ...(units.length > 1 ? { doors: units.map((u) => ({ id: u.id, name: this.doorName(u.id), ...u.mapping })) } : {}) }, "instance started");
  }

  private async startUnit(spec: DoorSpec, mapping: DoorMapping, index: number, knownPlates: string[]): Promise<DoorUnit> {
    const c = this.config;
    const multi = this.specs.length > 1;
    const logger = multi ? this.log.child({ door: spec.id }) : this.log;
    const bus = index === 0 ? this.bus : new Bus(this.maxListeners);
    if (index > 0) this.webhook?.attach(bus, spec.id);
    const unit = {
      id: spec.id,
      spec,
      mapping,
      bus,
      hold: index === 0 ? this.hold : new HoldService(this.store, bus, Date.now, spec.id),
      vehicle: index === 0 ? this.vehicle : new VehicleTracker(bus, c.alerts.vehicleGraceSeconds * 1000, this.mode === "mock" ? "mock" : "camera-heuristic"),
      notifier: index === 0 ? this.notifier : this.notifierFor(spec, bus),
      lpr: null,
    } as DoorUnit;
    unit.door = new LiveDoorService({
      protect: this.protect, store: this.store, bus, logger, config: c, mapping,
      doorId: spec.id, travelSeconds: spec.travelSeconds, verifyAfterSeconds: spec.verifyAfterSeconds,
      buildState: () => this.stateOf(unit),
    });
    let lastDoor: string | undefined;
    bus.on("state", (s) => {
      // One console, polled once per door: it is reachable for /healthz only when every door can reach it.
      // (This unit is not in `units` yet while it starts, so its own answer comes from the event.)
      this.protectOk = s.connectionOk && this.units.every((u) => u === unit || u.door.snapshot().connectionOk);
      if (s.connectionOk) this.protectLastOk = Date.now();
      // A picture taken before the door changed state shows the door as it was.
      if (s.door !== lastDoor && mapping.interiorCameraId) this.snapshots.invalidate(mapping.interiorCameraId);
      lastDoor = s.door;
    });
    await unit.door.start();
    unit.alerts = new AlertEngine(
      { bus, door: unit.door, hold: unit.hold, notifier: unit.notifier, vehicle: unit.vehicle, logger },
      { openTooLongMinutes: c.alerts.openTooLongMinutes, nightlyTime: c.alerts.nightlyTime, nightlyAutoclose: c.alerts.nightlyAutoclose, vehicleDoorOpenMinutes: c.alerts.vehicleDoorOpenMinutes, tz: c.tz },
    );
    unit.alerts.start();
    if (c.features.lpr || this.mode === "mock") {
      unit.lpr = new LprEngine(
        { bus, door: unit.door, hold: unit.hold, notifier: unit.notifier, vehicle: unit.vehicle, store: this.store, logger },
        { knownPlates, departGraceMinutes: c.lpr.departGraceMinutes, undoSeconds: c.lpr.undoSeconds, doorId: spec.id },
      );
      unit.lpr.start();
    }
    return unit;
  }

  /**
   * Two door outputs and two garage sensors are never paired automatically. When the names pair up, say so
   * once, as settings ready to paste; whoever installs the second door decides.
   */
  private logPairingHint(): void {
    const suggested = this.discovery?.suggestedDoors;
    // A simulator is not an install, and a configured second door means the pairing has been written down.
    if (!suggested || this.pairingHintLogged || this.sim || this.specs.length > 1) return;
    this.pairingHintLogged = true;
    this.log[this.discovery?.current ? "info" : "warn"](
      { suggested: pairingAsEnv(suggested) },
      "the console shows two door outputs and two garage sensors; they are never paired automatically. Suggested pairing, by name — check it against the doors, then set it",
    );
  }

  async stop(): Promise<void> {
    this.retention.stop();
    for (const u of this.units) {
      await u.door.stop();
      u.alerts.stop();
      u.lpr?.stop();
      u.hold.stop();
      u.vehicle.stop();
    }
    this.hold.stop();
    this.vehicle.stop();
    await this.protect.close();
    this.store.close();
  }

  touch(): void {
    this.lastTouched = Date.now();
  }

  unit(id: string): DoorUnit | undefined {
    return this.units.find((u) => u.id === id);
  }

  /** The door the routes without a door id mean for this caller: the one they chose, else `d1`. */
  defaultUnit(memberId: string | undefined): DoorUnit {
    const chosen = memberId ? this.members.defaultDoor(memberId) : null;
    return (chosen ? this.unit(chosen) : undefined) ?? this.units[0]!;
  }

  setDefaultDoor(memberId: string, doorId: string): void {
    this.members.setDefaultDoor(memberId, doorId);
    this.defaults.emit("changed", memberId);
  }

  /** `DOOR_NAME` / `DOOR2_NAME`, else what the relay output is called on the console. */
  doorName(id: string): string {
    const u = this.unit(id);
    const spec = u?.spec ?? this.specs.find((s) => s.id === id);
    if (spec?.name) return spec.name;
    const output = (u?.door as DoorService | undefined)?.snapshot().relay.name;
    if (output && output !== "relay") return output;
    return id === doorIdAt(0) ? "Garage door" : `Garage door ${id.slice(1)}`;
  }

  /** Each door with the console's name for its interior camera, when the last discovery listed it (display only). */
  doorList(): Door[] {
    return this.units.map((u) => {
      const cameraId = u.mapping.interiorCameraId;
      const cameraName = cameraId ? this.discovery?.cameras.find((c) => c.id === cameraId)?.name : undefined;
      return { id: u.id, name: this.doorName(u.id), hasCamera: !!cameraId, ...(cameraName ? { cameraName } : {}), mapping: u.mapping };
    });
  }

  /**
   * Route a classified Protect event (webhook or mock) to the door, or doors, it is about. Alarm Manager
   * says which sensor or camera fired, by MAC rather than by id, so the device is matched against both the
   * configured id and the MAC the last discovery listed for it; a camera that two doors share feeds both.
   */
  async onProtectEvent(e: ClassifiedEvent): Promise<void> {
    // With one door an event that names no device can only be about that door. With more it cannot be routed.
    const anonymous = !e.device && this.units.length === 1;
    const matches = (u: DoorUnit, id: string | null | undefined, kind: DeviceKind) => anonymous || deviceMatches(e.device, id, this.discoveryMac(kind, id));
    const forDoors = (pick: (u: DoorUnit) => string | null | undefined, kind: DeviceKind) => this.units.filter((u) => matches(u, pick(u), kind));
    let targets: DoorUnit[] = [];
    switch (e.type) {
      case "opened":
      case "closed":
        targets = forDoors((u) => u.mapping.sensorId, "sensor");
        break;
      case "vehicle-start":
      case "vehicle-end":
        targets = forDoors((u) => u.mapping.interiorCameraId, "camera");
        break;
      case "plate":
        targets = forDoors((u) => u.mapping.drivewayCameraId, "camera");
        break;
    }
    this.store.audit({
      kind: e.source === "mock" ? "mock" : "webhook", source: e.source, outcome: "ok",
      detail: `${e.type}${e.device ? " " + e.device : ""}${e.plate ? " " + e.plate : ""}`,
      ...(targets.length === 1 ? { doorId: targets[0]!.id } : {}),
    });
    switch (e.type) {
      case "opened":
      case "closed":
        for (const u of targets) u.door.applySensorEvent(e.type === "opened", e.at);
        // "A door moved" without saying which: believe no edge, and ask the console about every door.
        if (!e.device && !anonymous) for (const u of this.units) void u.door.refresh();
        break;
      case "vehicle-start":
        for (const u of targets) u.vehicle.detectionStarted(e.at);
        break;
      case "vehicle-end":
        for (const u of targets) u.vehicle.detectionEnded(e.at);
        break;
      case "plate":
        if (e.plate) for (const u of targets) await u.lpr?.onPlateSeen(e.plate);
        break;
      default:
        this.log.debug({ e }, "unclassified protect event");
    }
  }

  /** The MAC the console listed for a device, so an event that names it by MAC finds the door it is about. */
  private discoveryMac(kind: DeviceKind, id: string | null | undefined): string | undefined {
    return id ? this.macs.get(`${kind}:${id}`) : undefined;
  }

  stateOf(unit: DoorUnit): State {
    const snap = unit.door.snapshot();
    const s: State = {
      ...snap,
      hold: unit.hold.get(),
      vehicle: unit.vehicle.get(),
      mode: this.mode,
      openTooLongMinutes: this.config.alerts.openTooLongMinutes,
      travelSeconds: unit.spec.travelSeconds,
    };
    return s;
  }

  /** The first door's state; `stateOf()` for any other. */
  state(): State {
    return this.stateOf(this.units[0]!);
  }

  health(): Health {
    const h: Health = { ok: this.ready, ready: this.ready, mode: this.mode, version: VERSION, protect: { ok: this.protectOk } };
    if (!this.ready && this.startError) h.lastError = this.startError;
    if (this.protectVersion) h.protect.applicationVersion = this.protectVersion;
    if (this.protectLastOk) h.protect.lastSuccessAt = iso(this.protectLastOk);
    if (!this.protectOk && this.protectError) h.protect.error = this.protectError;
    const warnings: string[] = [];
    if (this.ready && this.units.some((u) => u.door.snapshot().relay.outputStuck)) warnings.push("relay_output_stuck");
    if (warnings.length) h.warnings = warnings;
    return h;
  }

  /** `current` is the given door's mapping (the caller's default door); `doors` lists them all. */
  async discoveryNow(unit: DoorUnit | undefined = this.units[0]): Promise<DiscoveryResult> {
    const saved = this.store.get<DoorMapping>("mapping");
    const devices = await listDevices(this.protect);
    this.macs = deviceMacs(devices);
    this.discovery = await discover(this.protect, saved, {}, devices);
    this.discovery.autoPaired = this.store.get<boolean>("autoPaired") === true;
    this.discovery.doors = this.doorList();
    return unit && unit !== this.units[0] ? { ...this.discovery, current: unit.mapping } : this.discovery;
  }

  /** Reverse an auto-action, whichever door it was for; `null` when unknown or expired. */
  async undo(id: string): Promise<CommandResult | null> {
    for (const u of this.units) {
      const result = await u.lpr?.undo(id);
      if (result) return result;
    }
    return null;
  }

  /**
   * Mock-only controls. They act on one door (the first unless told otherwise). `reset` without `scoped`
   * resets the whole simulator, which is what it always did when there was one door.
   */
  async mockAction(action: string, body: { plate?: string } = {}, unit: DoorUnit = this.units[0]!, scoped = false): Promise<State> {
    if (this.mode !== "mock" || !this.sim) throw new Error("not mock");
    const at = Date.now();
    const simDoor = this.sim.doors[unit.mapping.outputId] ?? this.sim.doors[0]!;
    switch (action) {
      case "vehicle-arrived":
        // Straight to this door's tracker: through the shared interior camera it would arrive in both doors.
        this.store.audit({ doorId: unit.id, kind: "mock", source: "mock", outcome: "ok", detail: `vehicle-start ${unit.mapping.interiorCameraId ?? SIM_IDS.interiorCameraId}` });
        unit.vehicle.detectionStarted(at);
        break;
      case "vehicle-left":
        unit.vehicle.force(false, at);
        this.store.audit({ doorId: unit.id, kind: "mock", source: "mock", outcome: "ok", detail: "vehicle-left" });
        break;
      case "plate-seen": {
        if (!body.plate) throw new RangeError("plate is required");
        // Straight to this door's plate rules, like `vehicle-arrived`: the driveway camera both simulated doors
        // share would report the plate to both, and the answer would be the other door's.
        const plate = normalizePlate(body.plate);
        this.store.audit({ doorId: unit.id, kind: "mock", source: "mock", outcome: "ok", detail: `plate ${unit.mapping.drivewayCameraId ?? SIM_IDS.drivewayCameraId} ${plate}` });
        await unit.lpr?.onPlateSeen(plate);
        break;
      }
      case "reverse-next-close":
        simDoor.reverseNextClose = true;
        this.store.audit({ doorId: unit.id, kind: "mock", source: "mock", outcome: "ok", detail: "reverse-next-close armed" });
        break;
      case "reset": {
        if (scoped) simDoor.reset();
        else this.sim.reset();
        for (const u of scoped ? [unit] : this.units) {
          u.hold.clear("mock");
          u.vehicle.force(false, at);
          // settle(), not refresh(): a reset during travel must also drop the in-flight command, or the door
          // stays OPENING and the abandoned deadline declares it STUCK on an already-closed simulator.
          await u.door.settle();
        }
        this.store.audit({ ...(scoped ? { doorId: unit.id } : {}), kind: "mock", source: "mock", outcome: "ok", detail: "reset" });
        break;
      }
      default:
        throw new RangeError(`unknown mock action ${action}`);
    }
    return this.stateOf(unit);
  }
}

function specMapping(spec: DoorSpec): DoorMapping {
  // validateDoors() already refused a second door without its relay, output and sensor.
  return { relayId: spec.relayId!, outputId: spec.outputId!, sensorId: spec.sensorId!, interiorCameraId: spec.interiorCameraId ?? null, drivewayCameraId: spec.drivewayCameraId ?? null };
}

/** `d1` may come from discovery or the saved mapping, so the configuration check cannot see every clash. */
function assertDistinctDoors(mappings: DoorMapping[]): void {
  for (let i = 0; i < mappings.length; i++) {
    for (let j = i + 1; j < mappings.length; j++) {
      const a = mappings[i]!;
      const b = mappings[j]!;
      if (a.sensorId === b.sensorId) throw new Error(`doors ${doorIdAt(i)} and ${doorIdAt(j)} use the same sensor ${a.sensorId}: every door needs its own`);
      if (a.relayId === b.relayId && a.outputId === b.outputId) throw new Error(`doors ${doorIdAt(i)} and ${doorIdAt(j)} use the same relay output: one output moves one door`);
    }
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
