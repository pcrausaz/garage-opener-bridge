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
  logger: Logger;
  fetchImpl?: typeof fetch;
}

export function ntfyActions(alert: Alert, publicUrl: string | undefined, token: string | undefined): unknown[] {
  if (!publicUrl || !token) return [];
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const actions: unknown[] = [];
  for (const a of alert.actions) {
    if (a === "close-now") actions.push({ action: "http", label: "Close now", method: "POST", url: `${publicUrl}/v1/door/close?source=ntfy`, headers, clear: true });
    if (a === "hold-2h") actions.push({ action: "http", label: "Hold 2h", method: "POST", url: `${publicUrl}/v1/hold`, headers, body: JSON.stringify({ minutes: 120 }), clear: true });
    if (a === "undo") {
      const url = alert.autoActionId ? `${publicUrl}/v1/auto-actions/${encodeURIComponent(alert.autoActionId)}/undo` : `${publicUrl}/v1/door/${alert.rule === "lpr-auto-open" ? "close" : "open"}?source=undo`;
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
      actions: ntfyActions(alert, this.o.publicUrl, this.o.actionToken),
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
