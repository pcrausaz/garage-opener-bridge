/**
 * Detects a relay pulse output whose contact is held ("on") instead of pulsing. A USL-Relay output stuck
 * on makes the opener ignore further presses; only the relay record on the console shows it.
 * Stuck = output observed "on" on consecutive reads for longer than max(2 × pulseDuration, 3 s).
 */
export interface StuckObservation {
  stuck: boolean;
  /** True on the read where `stuck` flipped (either direction). */
  changed: boolean;
  onForMs: number;
}

export class StuckOutputDetector {
  private onSince: number | null = null;
  private stuck = false;

  constructor(private readonly minStuckMs = 3000) {}

  static threshold(pulseDurationMs: number | null | undefined, minStuckMs = 3000): number {
    return Math.max(2 * (pulseDurationMs ?? 0), minStuckMs);
  }

  isStuck(): boolean {
    return this.stuck;
  }

  observe(outputState: string | null | undefined, pulseDurationMs: number | null | undefined, at: number): StuckObservation {
    const on = outputState === "on";
    const was = this.stuck;
    if (!on) {
      this.onSince = null;
      this.stuck = false;
      return { stuck: false, changed: was, onForMs: 0 };
    }
    if (this.onSince === null) {
      this.onSince = at; // first "on" read starts the episode; never stuck on a single read
      return { stuck: this.stuck, changed: false, onForMs: 0 };
    }
    const onForMs = at - this.onSince;
    if (onForMs >= StuckOutputDetector.threshold(pulseDurationMs, this.minStuckMs)) this.stuck = true;
    return { stuck: this.stuck, changed: this.stuck !== was, onForMs };
  }

  reset(): void {
    this.onSince = null;
    this.stuck = false;
  }
}
