import type { Store } from "./store/db.js";
import type { Bus } from "./events/bus.js";
import { iso, type Hold } from "./types.js";

interface StoredHold {
  until: number;
  minutes: number;
  setAt: number;
}

export class HoldService {
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly store: Store, private readonly bus: Bus, private readonly now: () => number = Date.now) {
    this.arm();
  }

  private stored(): StoredHold | null {
    const h = this.store.get<StoredHold>("hold");
    if (h && h.until > this.now()) return h;
    if (h) this.store.delete("hold");
    return null;
  }

  get(): Hold {
    const h = this.stored();
    return h ? { active: true, until: iso(h.until), minutes: h.minutes, setAt: iso(h.setAt) } : { active: false };
  }

  isActive(): boolean {
    return this.stored() !== null;
  }

  set(minutes: number, source = "app"): Hold {
    const setAt = this.now();
    this.store.set("hold", { until: setAt + minutes * 60_000, minutes, setAt } satisfies StoredHold);
    this.store.audit({ kind: "hold", source, outcome: "ok", detail: `${minutes} min` });
    const h = this.get();
    this.bus.emit("hold", h);
    this.arm();
    return h;
  }

  clear(source = "app"): void {
    const had = this.stored();
    this.store.delete("hold");
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (had) {
      this.store.audit({ kind: "hold", source, outcome: "ok", detail: "cleared" });
      this.bus.emit("hold", { active: false });
    }
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    const h = this.stored();
    if (!h) return;
    this.timer = setTimeout(() => {
      this.store.delete("hold");
      this.bus.emit("hold", { active: false });
    }, h.until - this.now());
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
  }
}
