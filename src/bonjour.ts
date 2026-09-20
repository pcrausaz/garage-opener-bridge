import { randomUUID } from "node:crypto";
import { networkInterfaces } from "node:os";
import Bonjour from "bonjour-service";
import type { Logger } from "./logger.js";
import type { Store } from "./store/db.js";

export const SERVICE_TYPE = "garage-opener";

export function installId(store: Store): string {
  let id = store.get<string>("installId");
  if (!id) {
    id = randomUUID();
    store.set("installId", id);
  }
  return id;
}

/** First non-internal IPv4 address, for the advertised URL when PUBLIC_URL is not set. */
export function lanAddress(): string | undefined {
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list ?? []) if (i.family === "IPv4" && !i.internal) return i.address;
  }
  return undefined;
}

/** The URL the app should use: PUBLIC_URL when set, else http://<lan ip>:<port>. */
export function advertisedUrl(port: number, publicUrl?: string): string | undefined {
  if (publicUrl) return publicUrl.replace(/\/$/, "");
  const ip = lanAddress();
  return ip ? `http://${ip}:${port}` : undefined;
}

/** Advertise `_garage-opener._tcp` so the app can find the bridge on the LAN. Needs host networking under Docker. */
export function startBonjour(o: { port: number; version: string; mode: "live" | "mock"; id: string; logger: Logger; name?: string; publicUrl?: string }): () => Promise<void> {
  const bonjour = new Bonjour();
  const service = bonjour.publish({
    name: o.name ?? "Garage Opener Bridge",
    type: SERVICE_TYPE,
    protocol: "tcp",
    port: o.port,
    txt: { version: o.version, mode: o.mode, path: "/v1", id: o.id, ...(advertisedUrl(o.port, o.publicUrl) ? { url: advertisedUrl(o.port, o.publicUrl)! } : {}) },
  });
  service.on("error", (err: Error) => o.logger.warn({ err }, "bonjour error"));
  o.logger.info({ type: `_${SERVICE_TYPE}._tcp`, port: o.port, id: o.id, url: advertisedUrl(o.port, o.publicUrl) }, "bonjour advertising");
  return () =>
    new Promise<void>((resolve) => {
      bonjour.unpublishAll(() => {
        bonjour.destroy();
        resolve();
      });
    });
}
