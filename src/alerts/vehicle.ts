import type { Bus } from "../events/bus.js";
import { iso, type VehiclePresence } from "../types.js";

/**
 * Heuristic vehicle-presence tracker for the interior garage camera:
 * present = a vehicle detection started and no "ended" was seen for `graceMs`.
 * This is a heuristic until LPR; documented as such in the State payload.
 */
export class VehicleTracker {
  private present = false;
  private since: number | null = null;
  private endTimer: NodeJS.Timeout | null = null;
  readonly source: "camera-heuristic" | "mock";

  constructor(private readonly bus: Bus, private readonly graceMs: number, source: "camera-heuristic" | "mock" = "camera-heuristic", private readonly now: () => number = Date.now) {
    this.source = source;
  }

  get(): VehiclePresence {
    const v: VehiclePresence = { present: this.present, source: this.source, note: "Heuristic from interior camera vehicle detections until LPR" };
    if (this.since) v.since = iso(this.since);
    return v;
  }

  isPresent(): boolean {
    return this.present;
  }

  detectionStarted(at = this.now()): void {
    if (this.endTimer) clearTimeout(this.endTimer);
    this.endTimer = null;
    if (!this.present) {
      this.present = true;
      this.since = at;
      this.bus.emit("vehicle", this.get());
    }
  }

  detectionEnded(at = this.now()): void {
    if (!this.present) return;
    if (this.endTimer) clearTimeout(this.endTimer);
    this.endTimer = setTimeout(() => {
      this.endTimer = null;
      this.present = false;
      this.since = at;
      this.bus.emit("vehicle", this.get());
    }, this.graceMs);
    this.endTimer.unref?.();
  }

  /** Mock helper: immediate presence change without grace. */
  force(present: boolean, at = this.now()): void {
    if (this.endTimer) clearTimeout(this.endTimer);
    this.endTimer = null;
    if (this.present !== present) {
      this.present = present;
      this.since = at;
      this.bus.emit("vehicle", this.get());
    }
  }

  stop(): void {
    if (this.endTimer) clearTimeout(this.endTimer);
  }
}
