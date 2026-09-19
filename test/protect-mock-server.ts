import Fastify from "fastify";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ProtectCamera, ProtectRelay, ProtectSensor } from "../src/protect/types.js";

const here = dirname(fileURLToPath(import.meta.url));
export const fixturesDir = join(here, "fixtures", "protect");
export const loadFixture = <T>(name: string): T => JSON.parse(readFileSync(join(fixturesDir, name), "utf8")) as T;

export interface MockProtectOptions {
  /** ms after an activate before the sensor flips; `null` = never flips (stuck). */
  travelMs?: number | null;
  apiKey?: string;
  /**
   * `pulse`: every activate is a press (output stays off).
   * `toggle`: activate flips the output state; the opener reacts only on the off→on edge
   * (what the USL-Relay does on Protect 7.2.105, see ADR-0010).
   */
  relayBehaviour?: "pulse" | "toggle";
}

/**
 * HTTP mock of the Protect Integration API built from the live fixtures. Serves the real JSON shapes
 * and simulates the door: `activate` flips `isOpened` after `travelMs`.
 */
export async function startMockProtect(opts: MockProtectOptions = {}) {
  const apiKey = opts.apiKey ?? "test-key";
  const sensors = loadFixture<ProtectSensor[]>("sensors.json");
  const relays = loadFixture<ProtectRelay[]>("relays.json");
  const cameras = loadFixture<ProtectCamera[]>("cameras.json");
  const meta = loadFixture<{ applicationVersion: string }>("meta_info.json");
  const sensor = sensors[0]!;
  const state = { sensor, activations: [] as { relayId: string; outputId: number; at: number }[], outputLog: [] as string[], failNext: 0, timers: [] as NodeJS.Timeout[] };
  const behaviour = opts.relayBehaviour ?? "pulse";

  const app = Fastify({ logger: false });
  app.addHook("onRequest", async (req, reply) => {
    reply.header("ratelimit-policy", '"10-in-1sec"; q=10; w=1');
    if (req.headers["x-api-key"] !== apiKey) throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
    if (state.failNext > 0) {
      state.failNext--;
      throw Object.assign(new Error("simulated outage"), { statusCode: 503 });
    }
  });
  const base = "/proxy/protect/integration/v1";
  app.get(`${base}/meta/info`, async () => meta);
  app.get(`${base}/sensors`, async () => [state.sensor]);
  app.get<{ Params: { id: string } }>(`${base}/sensors/:id`, async (req, reply) => (req.params.id === state.sensor.id ? state.sensor : reply.code(404).send({ error: "Entity 'sensor' not found" })));
  app.get(`${base}/relays`, async () => relays);
  app.get<{ Params: { id: string } }>(`${base}/relays/:id`, async (req, reply) => relays.find((r) => r.id === req.params.id) ?? reply.code(404).send({ error: "not found" }));
  app.get(`${base}/cameras`, async () => cameras);
  app.post<{ Params: { id: string; out: string } }>(`${base}/relays/:id/outputs/:out/activate`, async (req, reply) => {
    const relay = relays.find((r) => r.id === req.params.id);
    const outputId = Number(req.params.out);
    if (!relay || !relay.outputs.some((o) => o.id === outputId)) return reply.code(404).send({ error: "not found" });
    state.activations.push({ relayId: relay.id, outputId, at: Date.now() });
    const output = relay.outputs.find((o) => o.id === outputId)!;
    let press = true;
    if (behaviour === "toggle") {
      press = output.state !== "on";
      output.state = press ? "on" : "off";
      state.outputLog.push(output.state);
    }
    const travel = opts.travelMs === undefined ? 200 : opts.travelMs;
    if (press && travel !== null) {
      const t = setTimeout(() => {
        state.sensor = { ...state.sensor, isOpened: !state.sensor.isOpened, openStatusChangedAt: Date.now() };
      }, travel);
      state.timers.push(t);
    }
    return reply.code(200).send({});
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    apiKey,
    state,
    setOpened(v: boolean) {
      state.sensor = { ...state.sensor, isOpened: v, openStatusChangedAt: Date.now() };
    },
    /** Mutate the mapped relay/output record as the console would report it. */
    outputState: () => relays[0]!.outputs[0]!.state,
    setRelayOutput(patch: Partial<{ state: string; pulseDuration: number | null }>, relayPatch: Partial<{ state: string }> = {}) {
      const relay = relays[0]!;
      Object.assign(relay, relayPatch);
      Object.assign(relay.outputs[0]!, patch);
    },
    async close() {
      for (const t of state.timers) clearTimeout(t);
      await app.close();
    },
  };
}
