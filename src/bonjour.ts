import { randomUUID } from "node:crypto";
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

/** Advertise `_garage-opener._tcp` so the app can find the bridge on the LAN. Needs host networking under Docker. */
export function startBonjour(o: { port: number; version: string; mode: "live" | "mock"; id: string; logger: Logger; name?: string }): () => Promise<void> {
  const bonjour = new Bonjour();
  const service = bonjour.publish({
    name: o.name ?? "Garage Opener Bridge",
    type: SERVICE_TYPE,
    protocol: "tcp",
    port: o.port,
    txt: { version: o.version, mode: o.mode, path: "/v1", id: o.id },
  });
  service.on("error", (err: Error) => o.logger.warn({ err }, "bonjour error"));
  o.logger.info({ type: `_${SERVICE_TYPE}._tcp`, port: o.port, id: o.id }, "bonjour advertising");
  return () =>
    new Promise<void>((resolve) => {
      bonjour.unpublishAll(() => {
        bonjour.destroy();
        resolve();
      });
    });
}
