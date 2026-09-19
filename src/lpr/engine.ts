import { randomUUID } from "node:crypto";
import type { Logger } from "../logger.js";
import type { Bus } from "../events/bus.js";
import type { DoorService } from "../door/service.js";
import type { HoldService } from "../hold.js";
import type { Notifier } from "../notify/notifier.js";
import type { Store } from "../store/db.js";
import type { VehicleTracker } from "../alerts/vehicle.js";
import { iso, type AutoAction, type DoorCommand } from "../types.js";
import { normalizePlate } from "../webhooks/classify.js";

export interface LprOptions {
  knownPlates: string[];
  departGraceMinutes: number;
  undoSeconds: number;
  /** A plate sighting within this window counts as "the same sighting" (edge suppression). */
  sightingDedupeMs?: number;
  /** A plate seen this long after presence ended still counts as "leaving". */
  departWindowMs?: number;
  now?: () => number;
}

/**
 * License-plate rule engine (edge-triggered):
 *  - known plate seen on the driveway AND door CLOSED AND no vehicle inside → open
 *  - vehicle presence inside ends AND driveway sees the known plate → wait departGrace → close
 * A plate merely visible never changes state; only fresh sightings (after dedupe) do.
 * Every auto-action notifies and is undoable for `undoSeconds` (reverse command).
 */
export class LprEngine {
  private readonly known: Set<string>;
  private readonly now: () => number;
  private readonly log: Logger;
  private lastSighting = new Map<string, number>();
  private presenceEndedAt: number | null = null;
  private departTimer: NodeJS.Timeout | null = null;
  private undoable = new Map<string, AutoAction>();
  decisions: { rule: string; command: DoorCommand; at: number }[] = [];

  constructor(
    private readonly d: { bus: Bus; door: DoorService; hold: HoldService; notifier: Notifier; vehicle: VehicleTracker; store: Store; logger: Logger },
    private readonly o: LprOptions,
  ) {
    this.known = new Set(o.knownPlates.map(normalizePlate));
    this.now = o.now ?? Date.now;
    this.log = d.logger.child({ component: "lpr" });
  }

  start(): void {
    this.d.bus.on("vehicle", (v) => this.onPresence(v.present));
  }

  stop(): void {
    if (this.departTimer) clearTimeout(this.departTimer);
  }

  isKnown(plate: string): boolean {
    return this.known.has(normalizePlate(plate));
  }

  /** Fresh sighting = first time this plate is seen since `sightingDedupeMs`. */
  private isEdge(plate: string): boolean {
    const t = this.now();
    const last = this.lastSighting.get(plate);
    this.lastSighting.set(plate, t);
    return last === undefined || t - last > (this.o.sightingDedupeMs ?? 60_000);
  }

  /** Called for `plate` events from the driveway camera. */
  async onPlateSeen(rawPlate: string): Promise<void> {
    const plate = normalizePlate(rawPlate);
    const edge = this.isEdge(plate);
    if (!this.known.has(plate)) {
      this.log.debug({ plate }, "unknown plate");
      return;
    }
    if (!edge) return;
    const door = this.d.door.snapshot().door;
    const t = this.now();
    // departure: presence ended recently and the car shows up on the driveway
    if (this.presenceEndedAt !== null && t - this.presenceEndedAt <= (this.o.departWindowMs ?? 10 * 60_000) && door === "OPEN") {
      this.scheduleDepartClose();
      return;
    }
    // arrival
    if (door === "CLOSED" && !this.d.vehicle.isPresent() && !this.d.hold.isActive()) {
      await this.autoAction("lpr-auto-open", "open", `Known plate ${plate} arrived; opening the garage.`);
    }
  }

  private onPresence(present: boolean): void {
    if (present) {
      this.presenceEndedAt = null;
      if (this.departTimer) clearTimeout(this.departTimer);
      this.departTimer = null;
    } else {
      this.presenceEndedAt = this.now();
      // If the known plate was just seen on the driveway (car pulled out), treat it as leaving.
      const recent = [...this.lastSighting.entries()].some(([p, at]) => this.known.has(p) && this.now() - at <= (this.o.departWindowMs ?? 10 * 60_000));
      if (recent) this.scheduleDepartClose();
    }
  }

  private scheduleDepartClose(): void {
    if (this.departTimer) return;
    this.departTimer = setTimeout(() => {
      this.departTimer = null;
      this.presenceEndedAt = null;
      if (this.d.door.snapshot().door !== "OPEN" || this.d.vehicle.isPresent() || this.d.hold.isActive()) return;
      void this.autoAction("lpr-auto-close", "close", "The car left; closing the garage.");
    }, this.o.departGraceMinutes * 60_000);
    this.departTimer.unref?.();
  }

  private async autoAction(rule: "lpr-auto-open" | "lpr-auto-close", command: DoorCommand, body: string): Promise<void> {
    const at = this.now();
    this.decisions.push({ rule, command, at });
    const auditId = this.d.store.audit({ kind: "auto-action", source: rule, command, outcome: "ok" });
    const action: AutoAction = { id: randomUUID(), rule, command, at: iso(at), undoUntil: iso(at + this.o.undoSeconds * 1000), auditId };
    this.undoable.set(action.id, action);
    setTimeout(() => this.undoable.delete(action.id), this.o.undoSeconds * 1000).unref?.();
    this.d.bus.emit("auto-action", action);
    await this.d.notifier.alert(rule, command === "open" ? "Opening the garage" : "Closing the garage", body, ["undo"], { undoUntil: action.undoUntil });
    try {
      const fn = command === "open" ? this.d.door.open.bind(this.d.door) : this.d.door.close.bind(this.d.door);
      await fn({ source: rule, wait: false });
    } catch (err) {
      this.d.store.auditUpdate(auditId, { outcome: "failed", detail: (err as Error).message });
      this.log.warn({ err, rule }, "auto-action failed");
    }
  }

  /** Reverse an auto-action if still inside its undo window. */
  async undo(id: string): Promise<boolean> {
    const a = this.undoable.get(id);
    if (!a || Date.parse(a.undoUntil) < this.now()) return false;
    this.undoable.delete(id);
    this.d.store.auditUpdate(a.auditId, { outcome: "undone" });
    const reverse = a.command === "open" ? "close" : "open";
    try {
      await (reverse === "open" ? this.d.door.open({ source: "undo", wait: false }) : this.d.door.close({ source: "undo", wait: false }));
    } catch (err) {
      this.log.warn({ err }, "undo failed");
    }
    return true;
  }

  pendingUndo(): AutoAction[] {
    return [...this.undoable.values()];
  }
}
