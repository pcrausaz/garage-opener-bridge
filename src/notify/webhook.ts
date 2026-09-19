import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Logger } from "../logger.js";
import type { Bus } from "../events/bus.js";
import type { Alert } from "../types.js";
import type { NotificationTransport, OutboundEvent } from "./transport.js";

export function sign(secret: string, rawBody: string): string {
  return "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
}

export function verify(secret: string, rawBody: string, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = Buffer.from(sign(secret, rawBody));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export interface WebhookOptions {
  url: string;
  secret: string;
  logger: Logger;
  fetchImpl?: typeof fetch;
  retries?: number;
}

/** Outbound HMAC-signed events (n8n or any subscriber). Also usable as an alert transport. */
export class OutboundWebhook implements NotificationTransport {
  readonly name = "webhook";
  private readonly fetchImpl: typeof fetch;
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly o: WebhookOptions) {
    this.fetchImpl = o.fetchImpl ?? fetch;
  }

  attach(bus: Bus): void {
    bus.on("state", (s) => void this.send("door.state", s));
    bus.on("command", (c) => void this.send("door.command", c));
    bus.on("hold", (h) => void this.send("hold", h));
    bus.on("vehicle", (v) => void this.send("vehicle", v));
    bus.on("auto-action", (a) => void this.send("auto-action", a));
  }

  notify(alert: Alert): Promise<void> {
    return this.send("alert", alert);
  }

  send(type: OutboundEvent["type"], data: unknown): Promise<void> {
    const ev: OutboundEvent = { id: randomUUID(), type, at: new Date().toISOString(), data };
    const raw = JSON.stringify(ev);
    const run = async () => {
      const retries = this.o.retries ?? 2;
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          const res = await this.fetchImpl(this.o.url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-garage-signature": sign(this.o.secret, raw), "x-garage-event": type, "x-garage-delivery": ev.id },
            body: raw,
          });
          if (res.ok) return;
          this.o.logger.warn({ status: res.status, type, attempt }, "event webhook rejected");
        } catch (err) {
          this.o.logger.warn({ err, type, attempt }, "event webhook failed");
        }
        if (attempt < retries) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    };
    this.queue = this.queue.then(run, run);
    return this.queue;
  }
}
