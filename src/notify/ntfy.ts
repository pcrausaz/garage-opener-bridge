import type { Logger } from "../logger.js";
import type { Alert } from "../types.js";
import type { NotificationTransport } from "./transport.js";

export interface NtfyOptions {
  url: string; // e.g. https://ntfy.sh or self-hosted
  topic: string;
  token?: string;
  /** Public bridge URL + a bearer token, used for actionable buttons. */
  publicUrl?: string;
  actionToken?: string;
  /** More than one door: action buttons address the alert's door instead of the token's default door. */
  doorScoped?: boolean;
  logger: Logger;
  fetchImpl?: typeof fetch;
}

/**
 * With one door the buttons call the routes they always have. With more, `/v1/door/close` would mean "the
 * default door of whoever owns the action token" — not necessarily the door the alert is about — so the
 * buttons name the door.
 */
export function ntfyActions(alert: Alert, publicUrl: string | undefined, token: string | undefined, doorScoped = false): unknown[] {
  if (!publicUrl || !token) return [];
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const actions: unknown[] = [];
  const scoped = doorScoped && alert.doorId ? `${publicUrl}/v1/doors/${encodeURIComponent(alert.doorId)}` : null;
  for (const a of alert.actions) {
    if (a === "close-now") actions.push({ action: "http", label: "Close now", method: "POST", url: scoped ? `${scoped}/close?source=ntfy` : `${publicUrl}/v1/door/close?source=ntfy`, headers, clear: true });
    if (a === "hold-2h") actions.push({ action: "http", label: "Hold 2h", method: scoped ? "PUT" : "POST", url: scoped ? `${scoped}/hold` : `${publicUrl}/v1/hold`, headers, body: JSON.stringify({ minutes: 120 }), clear: true });
    if (a === "undo") {
      const reverse = alert.rule === "lpr-auto-open" ? "close" : "open";
      const url = alert.autoActionId ? `${publicUrl}/v1/auto-actions/${encodeURIComponent(alert.autoActionId)}/undo` : scoped ? `${scoped}/${reverse}?source=undo` : `${publicUrl}/v1/door/${reverse}?source=undo`;
      actions.push({ action: "http", label: "Undo", method: "POST", url, headers, clear: true });
    }
  }
  return actions.slice(0, 3); // ntfy allows at most 3 actions
}

export class NtfyTransport implements NotificationTransport {
  readonly name = "ntfy";
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly o: NtfyOptions) {
    this.fetchImpl = o.fetchImpl ?? fetch;
  }
  async notify(alert: Alert): Promise<void> {
    const body = {
      topic: this.o.topic,
      title: alert.title,
      message: alert.body,
      priority: alert.rule === "open-too-long" || alert.rule === "nightly-check" ? 4 : 3,
      tags: ["door", alert.rule],
      actions: ntfyActions(alert, this.o.publicUrl, this.o.actionToken, this.o.doorScoped),
    };
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.o.token) headers.authorization = `Bearer ${this.o.token}`;
    const res = await this.fetchImpl(this.o.url.replace(/\/+$/, ""), { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) {
      this.o.logger.warn({ status: res.status }, "ntfy publish failed");
      throw new Error(`ntfy ${res.status}`);
    }
  }
}
