import { randomUUID } from "node:crypto";
import type { Logger } from "../logger.js";
import type { Bus } from "../events/bus.js";
import type { Store } from "../store/db.js";
import type { Alert, AlertAction, AlertRule } from "../types.js";
import type { NotificationTransport } from "./transport.js";

/** Which door a notifier speaks for. `name` is given only when the install has more than one door. */
export interface NotifierDoor {
  id: string;
  name?: () => string;
}

export class Notifier {
  constructor(
    private readonly transports: NotificationTransport[],
    private readonly bus: Bus,
    private readonly store: Store,
    private readonly log: Logger,
    private readonly door: NotifierDoor = { id: "d1" },
  ) {}

  async alert(rule: AlertRule, title: string, body: string, actions: AlertAction[], extra: Partial<Alert> = {}): Promise<Alert> {
    // With one door "the garage door" is unambiguous; with two, every alert says which (ADR-0020).
    const named = this.door.name ? `${this.door.name()}: ${title}` : title;
    const alert: Alert = { id: randomUUID(), rule, title: named, body, createdAt: new Date().toISOString(), actions, ...extra, doorId: this.door.id };
    this.store.audit({ doorId: this.door.id, kind: "alert", source: rule, outcome: "notified", detail: named });
    this.bus.emit("alert", alert);
    await Promise.all(
      this.transports.map((t) =>
        t.notify(alert).catch((err) => {
          this.log.warn({ err, transport: t.name, rule }, "alert transport failed");
        }),
      ),
    );
    return alert;
  }
}
