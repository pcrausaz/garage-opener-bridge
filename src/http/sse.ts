import type { FastifyReply } from "fastify";
import type { Bus, BusEvents } from "../events/bus.js";

export function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const NAMES: (keyof BusEvents)[] = ["state", "command", "alert", "hold", "vehicle"];

export interface SseStream {
  send(event: string, data: unknown): void;
  /**
   * Forward one door's bus to the client until the returned function is called. `doorId` stamps every frame
   * (`?doors=all`); without it the frames are exactly what a one-door stream always sent.
   */
  follow(bus: Bus, doorId?: string): () => void;
  /** Runs when the client goes away, after every bus has been released. */
  onClose(fn: () => void): void;
}

/** Opens the event stream; the caller sends the initial `state` frame(s) and says which buses to follow. */
export function openSse(reply: FastifyReply, heartbeatMs = 15000): SseStream {
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  const send = (event: string, data: unknown) => void reply.raw.write(sseFrame(event, data));
  const following = new Set<() => void>();
  const closers: (() => void)[] = [];
  const hb = setInterval(() => send("heartbeat", { at: new Date().toISOString() }), heartbeatMs);
  const cleanup = () => {
    clearInterval(hb);
    for (const off of [...following]) off();
    for (const fn of closers.splice(0)) fn();
  };
  reply.raw.on("close", cleanup);
  reply.raw.on("error", cleanup);
  return {
    send,
    follow(bus, doorId) {
      const handlers = NAMES.map((name) => {
        const h = (data: object) => send(name, doorId ? { ...data, doorId } : data);
        bus.on(name, h as never);
        return [name, h] as const;
      });
      const off = () => {
        for (const [name, h] of handlers) bus.off(name, h as never);
        following.delete(off);
      };
      following.add(off);
      return off;
    },
    onClose: (fn) => void closers.push(fn),
  };
}
