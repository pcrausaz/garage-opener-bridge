import type { Logger } from "../logger.js";
import type { Bus } from "../events/bus.js";
import type { DoorService } from "../door/service.js";
import type { HoldService } from "../hold.js";
import type { Notifier } from "../notify/notifier.js";
import type { VehicleTracker } from "./vehicle.js";
import { msUntilNext } from "./schedule.js";
import type { AlertAction } from "../types.js";

/** Door states the alert rules treat as "open": fully open, and stopped part-way (ADR-0015). */
const OPEN_ISH = new Set(["OPEN", "STOPPED"]);

export interface AlertEngineOptions {
  openTooLongMinutes: number;
  nightlyTime: string;
  nightlyAutoclose: boolean;
  vehicleDoorOpenMinutes: number;
  tz: string;
  now?: () => number;
}

/**
 * Rules (all respect the hold-open flag):
 * 1. door open longer than N min → alert [close-now, hold-2h, ignore]
 * 2. nightly check at HH:MM → open and no hold → alert (auto-close opt-in)
 * 3. vehicle heuristic: car inside & door open > M min; car left & door open > M min → alert
 */
export class AlertEngine {
  private openTimer: NodeJS.Timeout | null = null;
  private nightlyTimer: NodeJS.Timeout | null = null;
  private vehicleTimer: NodeJS.Timeout | null = null;
  private openEpisode = 0;
  private readonly now: () => number;
  private readonly log: Logger;
  fired: { rule: string; at: number }[] = [];

  constructor(
    private readonly d: { bus: Bus; door: DoorService; hold: HoldService; notifier: Notifier; vehicle: VehicleTracker; logger: Logger },
    private readonly o: AlertEngineOptions,
  ) {
    this.now = o.now ?? Date.now;
    this.log = d.logger.child({ component: "alerts" });
  }

  start(): void {
    this.d.bus.on("state", (s) => this.onDoor(s.door));
    this.d.bus.on("hold", (h) => {
      if (!h.active) this.onDoor(this.d.door.snapshot().door, true);
      else this.clearTimers(false);
    });
    this.d.bus.on("vehicle", (v) => this.onVehicle(v.present));
    this.onDoor(this.d.door.snapshot().door);
    this.scheduleNightly();
  }

  stop(): void {
    this.clearTimers(true);
  }

  private clearTimers(includeNightly: boolean): void {
    if (this.openTimer) clearTimeout(this.openTimer);
    if (this.vehicleTimer) clearTimeout(this.vehicleTimer);
    this.openTimer = null;
    this.vehicleTimer = null;
    if (includeNightly && this.nightlyTimer) {
      clearTimeout(this.nightlyTimer);
      this.nightlyTimer = null;
    }
  }

  /**
   * Offer "Close now" only when one press actually closes the door. A door stopped mid-close reverses on the
   * next press, so the button would answer 409 `door_direction` — better not to show it at all.
   */
  private actions(): AlertAction[] {
    const canClose = this.d.door.snapshot().nextPress !== "open";
    return canClose ? ["close-now", "hold-2h", "ignore"] : ["hold-2h", "ignore"];
  }

  /** A door stopped part-way is open — less open, but open all night just the same, so the rules arm for it. */
  private isOpen(): boolean {
    return OPEN_ISH.has(this.d.door.snapshot().door);
  }

  private onDoor(door: string, fromHoldExpiry = false): void {
    if (!OPEN_ISH.has(door)) {
      if (this.openTimer) clearTimeout(this.openTimer);
      if (this.vehicleTimer) clearTimeout(this.vehicleTimer);
      this.openTimer = null;
      this.vehicleTimer = null;
      this.openEpisode++;
      return;
    }
    if (this.openTimer && !fromHoldExpiry) return; // already armed for this episode
    if (this.d.hold.isActive()) return;
    const episode = ++this.openEpisode;
    const since = Date.parse(this.d.door.snapshot().since);
    const due = fromHoldExpiry ? this.o.openTooLongMinutes * 60_000 : Math.max(0, since + this.o.openTooLongMinutes * 60_000 - this.now());
    if (this.openTimer) clearTimeout(this.openTimer);
    this.openTimer = setTimeout(() => {
      this.openTimer = null;
      if (episode !== this.openEpisode || !this.isOpen() || this.d.hold.isActive()) return;
      this.fire("open-too-long");
      const partly = this.d.door.snapshot().door === "STOPPED";
      void this.d.notifier.alert(
        "open-too-long",
        partly ? "Garage door still part-way open" : "Garage door still open",
        `The garage door has been ${partly ? "stopped part-way" : "open"} for ${this.o.openTooLongMinutes} minutes.`,
        this.actions(),
      );
    }, due);
    this.openTimer.unref?.();
    // rule 3 (vehicle inside & door open)
    if (this.d.vehicle.isPresent()) this.armVehicle("vehicle-inside-door-open");
  }

  private onVehicle(present: boolean): void {
    if (!this.isOpen()) return;
    this.armVehicle(present ? "vehicle-inside-door-open" : "vehicle-left-door-open");
  }

  private armVehicle(rule: "vehicle-inside-door-open" | "vehicle-left-door-open"): void {
    if (this.vehicleTimer) clearTimeout(this.vehicleTimer);
    const wantPresent = rule === "vehicle-inside-door-open";
    this.vehicleTimer = setTimeout(() => {
      this.vehicleTimer = null;
      if (!this.isOpen() || this.d.hold.isActive() || this.d.vehicle.isPresent() !== wantPresent) return;
      this.fire(rule);
      void this.d.notifier.alert(
        rule,
        wantPresent ? "Car is inside and the door is open" : "Car left and the door is still open",
        wantPresent
          ? `A vehicle has been inside the garage with the door open for ${this.o.vehicleDoorOpenMinutes} minutes (camera heuristic).`
          : `The vehicle left ${this.o.vehicleDoorOpenMinutes} minutes ago and the door is still open (camera heuristic).`,
        this.actions(),
      );
    }, this.o.vehicleDoorOpenMinutes * 60_000);
    this.vehicleTimer.unref?.();
  }

  private scheduleNightly(): void {
    if (this.nightlyTimer) clearTimeout(this.nightlyTimer);
    const ms = msUntilNext(this.o.nightlyTime, this.o.tz, this.now());
    this.nightlyTimer = setTimeout(() => {
      void this.runNightly().finally(() => this.scheduleNightly());
    }, ms);
    this.nightlyTimer.unref?.();
  }

  async runNightly(): Promise<void> {
    if (!this.isOpen() || this.d.hold.isActive()) return;
    this.fire("nightly-check");
    // A door stopped part-way is never closed unattended: one press reverses the travel it interrupted, so a
    // door stopped mid-close would be *opened* wide at 22:00 by an auto-close. Tell the owner instead (ADR-0015).
    if (this.d.door.snapshot().door === "STOPPED") {
      await this.d.notifier.alert(
        "nightly-check",
        "Garage door is part-way open tonight",
        "The nightly check found the garage door stopped part-way. It is not closed automatically: from here one press reverses the travel that was stopped.",
        this.actions(),
      );
      return;
    }
    if (this.o.nightlyAutoclose) {
      await this.d.notifier.alert("nightly-check", "Closing the garage for the night", "The door was open at the nightly check; closing it now.", ["undo", "ignore"]);
      try {
        await this.d.door.close({ source: "nightly-autoclose", wait: false });
      } catch (err) {
        this.log.warn({ err }, "nightly autoclose failed");
      }
    } else {
      await this.d.notifier.alert("nightly-check", "Garage door is open tonight", "The nightly check found the garage door open.", ["close-now", "hold-2h", "ignore"]);
    }
  }

  private fire(rule: string): void {
    this.fired.push({ rule, at: this.now() });
    this.log.info({ rule }, "alert rule fired");
  }
}
