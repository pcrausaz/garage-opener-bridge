import { randomUUID } from "node:crypto";
import type { Logger } from "../logger.js";
import type { Bus } from "../events/bus.js";
import type { Store } from "../store/db.js";
import type { Alert, AlertAction, AlertRule } from "../types.js";
import type { NotificationTransport } from "./transport.js";

export class Notifier {
  constructor(private readonly transports: NotificationTransport[], private readonly bus: Bus, private readonly store: Store, private readonly log: Logger) {}

  async alert(rule: AlertRule, title: string, body: string, actions: AlertAction[], extra: Partial<Alert> = {}): Promise<Alert> {
    const alert: Alert = { id: randomUUID(), rule, title, body, createdAt: new Date().toISOString(), actions, ...extra };
    this.store.audit({ kind: "alert", source: rule, outcome: "notified", detail: title });
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
