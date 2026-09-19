import type { FastifyReply } from "fastify";
import type { Bus, BusEvents } from "../events/bus.js";

export function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Streams bus events to an SSE client; the caller sends the initial `state` frame. */
export function attachSse(reply: FastifyReply, bus: Bus, initial: unknown, heartbeatMs = 15000): void {
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  reply.raw.write(sseFrame("state", initial));
  const names: (keyof BusEvents)[] = ["state", "command", "alert", "hold", "vehicle"];
  const handlers = names.map((name) => {
    const h = (data: unknown) => reply.raw.write(sseFrame(name, data));
    bus.on(name, h as never);
    return [name, h] as const;
  });
  const hb = setInterval(() => reply.raw.write(sseFrame("heartbeat", { at: new Date().toISOString() })), heartbeatMs);
  const cleanup = () => {
    clearInterval(hb);
    for (const [name, h] of handlers) bus.off(name, h as never);
  };
  reply.raw.on("close", cleanup);
  reply.raw.on("error", cleanup);
}
