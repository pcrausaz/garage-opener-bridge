import type { Logger } from "../logger.js";
import type { Config } from "../config.js";
import type { ProtectClient, ProtectRelay, ProtectSensor } from "../protect/types.js";
import type { Store } from "../store/db.js";
import type { Bus } from "../events/bus.js";
import type { DoorMapping } from "../discovery.js";
import { canCommand, initialDoorState, reduce, type DoorMachineState } from "./state.js";
import { StuckOutputDetector } from "./stuck.js";
import { iso, type CommandAccepted, type CommandResult, type DoorCommand, type DoorState, type State } from "../types.js";

export class DoorBusyError extends Error {
  code = "door_busy" as const;
}
export class DoorUnknownError extends Error {
  code = "protect_unavailable" as const;
}

export interface DoorSnapshot {
  door: DoorState;
  isOpened: boolean;
  since: string;
  lastChangedAt?: string;
  connectionOk: boolean;
  sensor: { id: string; name: string; connected: boolean; isOpened: boolean; openStatusChangedAt?: string; battery: { percentage: number | null; isLow: boolean }; signalQuality: number | null };
  relay: { id: string; outputId: number; name: string; connected: boolean; pulseMode: "native" | "emulated"; pulseDurationMs: number | null; outputStuck: boolean };
  updatedAt: string;
}

export interface CommandOptions {
  source: string;
  wait?: boolean;
}

/** Interface kept minimal so a HomeKit (hap-nodejs) adapter can sit on top in v2. */
export interface DoorService {
  readonly mapping: DoorMapping;
  snapshot(): DoorSnapshot;
  machine(): DoorMachineState;
  open(opts: CommandOptions): Promise<CommandResult | CommandAccepted>;
  close(opts: CommandOptions): Promise<CommandResult | CommandAccepted>;
  toggle(opts: CommandOptions): Promise<CommandResult | CommandAccepted>;
  /** External sensor edge (Alarm Manager webhook). */
  applySensorEvent(isOpened: boolean, at: number): void;
  refresh(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface LiveDoorServiceDeps {
  protect: ProtectClient;
  store: Store;
  bus: Bus;
  logger: Logger;
  config: Config;
  mapping: DoorMapping;
  now?: () => number;
  /** Builds the full API State (hold, vehicle, …) for bus emission. */
  buildState: () => State;
}

export class LiveDoorService implements DoorService {
  readonly mapping: DoorMapping;
  private state: DoorMachineState;
  private sensor: ProtectSensor | null = null;
  private relay: ProtectRelay | null = null;
  private readonly stuck = new StuckOutputDetector();
  private connectionOk = false;
  private failures = 0;
  private pollTimer: NodeJS.Timeout | null = null;
  private deadlineTimer: NodeJS.Timeout | null = null;
  private inflight: Promise<CommandResult> | null = null;
  private busy = false;
  private running = false;
  private polling: Promise<void> | null = null;
  private readonly log: Logger;
  private readonly now: () => number;

  constructor(private readonly d: LiveDoorServiceDeps) {
    this.mapping = d.mapping;
    this.now = d.now ?? Date.now;
    this.log = d.logger.child({ component: "door" });
    this.state = initialDoorState(this.now());
  }

  machine(): DoorMachineState {
    return this.state;
  }

  snapshot(): DoorSnapshot {
    const s = this.sensor;
    const r = this.relay;
    const out = r?.outputs.find((o) => o.id === this.mapping.outputId);
    const snap: DoorSnapshot = {
      door: this.state.door,
      isOpened: this.state.isOpened ?? false,
      since: iso(this.state.since),
      connectionOk: this.connectionOk,
      sensor: {
        id: this.mapping.sensorId,
        name: s?.name ?? "sensor",
        connected: s?.state === "CONNECTED",
        isOpened: s?.isOpened ?? false,
        battery: { percentage: s?.batteryStatus?.percentage ?? null, isLow: s?.batteryStatus?.isLow ?? false },
        signalQuality: s?.wirelessConnectionState?.signalState?.signalQuality ?? null,
      },
      relay: {
        id: this.mapping.relayId,
        outputId: this.mapping.outputId,
        name: out?.name ?? r?.name ?? "relay",
        connected: r?.state === "CONNECTED",
        pulseMode: this.d.config.relay.pulseMode,
        pulseDurationMs: out?.pulseDuration ?? null,
        outputStuck: this.stuck.isStuck(),
      },
      updatedAt: iso(this.now()),
    };
    if (this.state.lastChangedAt) snap.lastChangedAt = iso(this.state.lastChangedAt);
    if (s?.openStatusChangedAt) snap.sensor.openStatusChangedAt = iso(s.openStatusChangedAt);
    return snap;
  }

  private setState(next: DoorMachineState): void {
    const prev = this.state;
    this.state = next;
    if (!this.running && prev.door !== "UNKNOWN") return;
    if (prev.door !== next.door || prev.isOpened !== next.isOpened || prev.since !== next.since) {
      this.log.info({ from: prev.door, to: next.door, isOpened: next.isOpened }, "door state");
      this.emitState();
    }
  }

  private emitState(): void {
    this.d.bus.emit("state", this.d.buildState());
  }

  async refresh(): Promise<void> {
    const at = this.now();
    try {
      const sensor = await this.d.protect.getSensor(this.mapping.sensorId);
      this.sensor = sensor;
      this.failures = 0;
      const wasOk = this.connectionOk;
      this.connectionOk = true;
      this.setState(reduce(this.state, { type: "sensor", isOpened: sensor.isOpened, at, changedAt: sensor.openStatusChangedAt }));
      if (!wasOk) this.emitState();
    } catch (err) {
      this.failures++;
      this.log.warn({ err, failures: this.failures }, "sensor read failed");
      if (this.failures >= 3) {
        this.connectionOk = false;
        this.setState(reduce(this.state, { type: "sensor-error", at }));
        this.emitState();
      }
    }
  }

  /** Re-reads the relay record (connected, pulseDuration, output state) and runs the stuck-output detector. */
  private async refreshRelay(): Promise<void> {
    try {
      const prev = this.relay;
      this.relay = await this.d.protect.getRelay(this.mapping.relayId);
      const out = this.relay.outputs.find((o) => o.id === this.mapping.outputId);
      const obs = this.stuck.observe(out?.state, out?.pulseDuration, this.now());
      if (obs.changed) {
        if (obs.stuck) this.log.warn({ relayId: this.mapping.relayId, outputId: this.mapping.outputId, onForMs: obs.onForMs }, "relay output stuck on; commands refused until it releases");
        else this.log.info({ relayId: this.mapping.relayId, outputId: this.mapping.outputId }, "relay output released");
        this.emitState();
      } else if (prev) {
        const pout = prev.outputs.find((o) => o.id === this.mapping.outputId);
        if (pout?.pulseDuration !== out?.pulseDuration || prev.state !== this.relay.state) this.emitState();
      }
    } catch (err) {
      this.log.warn({ err }, "relay read failed");
    }
  }

  async start(): Promise<void> {
    this.running = true;
    await this.refreshRelay();
    await this.refresh();
    this.schedulePoll();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    this.pollTimer = null;
    this.deadlineTimer = null;
    this.busy = false;
    if (this.polling) await this.polling.catch(() => undefined);
  }

  private schedulePoll(): void {
    if (!this.running) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    const ms = this.state.moving ? this.d.config.poll.movingMs : this.d.config.poll.idleMs;
    this.pollTimer = setTimeout(() => {
      this.polling = Promise.all([this.refresh(), this.refreshRelay()])
        .then(() => undefined)
        .finally(() => {
          this.polling = null;
          this.schedulePoll();
        });
    }, ms);
    this.pollTimer.unref?.();
  }

  applySensorEvent(isOpened: boolean, at: number): void {
    if (this.sensor) this.sensor = { ...this.sensor, isOpened, openStatusChangedAt: at };
    this.setState(reduce(this.state, { type: "sensor", isOpened, at }));
    // confirm shortly after via the console
    if (this.running) {
      if (this.pollTimer) clearTimeout(this.pollTimer);
      this.pollTimer = setTimeout(() => {
        this.refresh().finally(() => this.schedulePoll());
      }, 500);
      this.pollTimer.unref?.();
    }
  }

  open(opts: CommandOptions) {
    return this.command("open", opts);
  }
  close(opts: CommandOptions) {
    return this.command("close", opts);
  }
  toggle(opts: CommandOptions) {
    return this.command("toggle", opts);
  }

  private async command(command: DoorCommand, opts: CommandOptions): Promise<CommandResult | CommandAccepted> {
    const wait = opts.wait ?? true;
    const startedAt = this.now();
    const from = this.state.door;
    const check = this.busy ? ({ ok: false, reason: "busy" } as const) : canCommand(this.state, command);
    if (!check.ok) {
      const outcome = check.reason === "busy" ? "rejected" : "failed";
      this.d.store.audit({ kind: "command", source: opts.source, command, from, outcome, detail: check.reason });
      if (check.reason === "busy") throw new DoorBusyError("door is moving");
      throw new DoorUnknownError("door state unknown (console unreachable)");
    }
    if (check.noop) {
      const auditId = this.d.store.audit({ kind: "command", source: opts.source, command, from, to: from, outcome: "noop" });
      const result: CommandResult = { ok: true, command, from, to: from, pulsed: false, verified: true, auditId, startedAt: iso(startedAt), finishedAt: iso(this.now()) };
      this.d.bus.emit("command", result);
      return result;
    }
    // Native mode: a held-on output is a fault (or the wrong mode) and a single activate would only toggle it off.
    // Emulated mode: the press sequence starts by releasing it, so the command proceeds.
    if (this.stuck.isStuck() && this.d.config.relay.pulseMode === "native") {
      const auditId = this.d.store.audit({
        kind: "command", source: opts.source, command, from, to: from, outcome: "failed",
        detail: "relay_output_stuck: output held on after activate; set RELAY_PULSE_MODE=emulated",
      });
      const result: CommandResult = { ok: false, command, from, to: from, pulsed: false, verified: false, auditId, startedAt: iso(startedAt), finishedAt: iso(this.now()), error: "relay_output_stuck" };
      this.d.bus.emit("command", result);
      return result;
    }
    const auditId = this.d.store.audit({ kind: "command", source: opts.source, command, from, outcome: "ok", detail: "pulsing" });
    const travelMs = (this.d.config.door.travelSeconds + this.d.config.door.verifyAfterSeconds) * 1000;
    this.busy = true;
    try {
      await this.pulse();
    } catch (err) {
      this.busy = false;
      this.d.store.auditUpdate(auditId, { outcome: "failed", detail: (err as Error).message });
      throw new DoorUnknownError(`relay activation failed: ${(err as Error).message}`);
    }
    const pulsedAt = this.now();
    this.setState(reduce(this.state, { type: "pulse", command, at: pulsedAt, travelMs }));
    this.schedulePoll();
    const done = new Promise<CommandResult>((resolve) => {
      this.deadlineTimer = setTimeout(async () => {
        this.deadlineTimer = null;
        this.busy = false;
        if (!this.running) return;
        await Promise.all([this.refresh(), this.refreshRelay()]);
        if (!this.running) return;
        const at = this.now();
        this.setState(reduce(this.state, { type: "deadline", at }));
        const to = this.state.door;
        const ok = to !== "STUCK";
        this.d.store.auditUpdate(auditId, { to, outcome: ok ? "ok" : "failed", detail: ok ? "verified" : "sensor did not confirm" });
        const result: CommandResult = { ok, command, from, to, pulsed: true, verified: true, auditId, startedAt: iso(startedAt), finishedAt: iso(at) };
        if (!ok) result.error = "verification_failed";
        this.inflight = null;
        this.d.bus.emit("command", result);
        this.schedulePoll();
        resolve(result);
      }, travelMs);
    });
    this.inflight = done;
    if (wait) return done;
    const accepted: CommandAccepted = { accepted: true, command, auditId, expectedBy: iso(startedAt + travelMs) };
    return accepted;
  }

  /**
   * native: one activate (hardware that really pulses).
   * emulated: the USL-Relay on Protect 7.2.x toggles the output on each activate, so a press is
   * on → wait pulseMs → off, preceded by a release if the output is already on, and followed by a
   * corrective activate if it is still on afterwards (ADR-0010).
   */
  private async pulse(): Promise<void> {
    const { relayId, outputId } = this.mapping;
    const activate = () => this.d.protect.activateOutput(relayId, outputId);
    if (this.d.config.relay.pulseMode === "native") {
      await activate();
      return;
    }
    const { pulseMs, releaseMs } = this.d.config.relay;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const readOutput = async () => {
      this.relay = await this.d.protect.getRelay(relayId);
      return this.relay.outputs.find((o) => o.id === outputId)?.state ?? "unknown";
    };
    const sequence: string[] = [];
    let state = await readOutput();
    sequence.push(`read=${state}`);
    if (state === "on") {
      await activate();
      sequence.push("activate(release)");
      await sleep(releaseMs);
    }
    await activate();
    sequence.push("activate(on)");
    await sleep(pulseMs);
    await activate();
    sequence.push("activate(off)");
    state = await readOutput();
    sequence.push(`read=${state}`);
    if (state === "on") {
      await activate();
      sequence.push("activate(corrective)");
      state = await readOutput();
      sequence.push(`read=${state}`);
    }
    this.log.info({ sequence, pulseMs, releaseMs, finalOutputState: state }, "emulated pulse");
    if (state !== "on") this.stuck.reset();
  }
}
