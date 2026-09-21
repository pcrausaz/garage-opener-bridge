import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startMockProtect } from "../protect-mock-server.js";
import { Instance, startWithRetry } from "../../src/instance.js";
import { buildServer, type BridgeServer } from "../../src/http/server.js";
import { makeConfig } from "../../src/config.js";
import { silentLogger } from "../../src/logger.js";
import { ContractValidator } from "../../src/http/validation.js";

/** Live-mode boot with the console down: the port must come up, /healthz must say why, and boot must self-heal. */
describe("resilient live startup", () => {
  let protect: Awaited<ReturnType<typeof startMockProtect>>;
  let app: BridgeServer;
  let inst: Instance;
  const v = new ContractValidator();
  const auth = { authorization: "Bearer live-token-0123456789abcdef" };
  // controllable clock for the backoff: each sleep parks until the test releases it
  const delays: number[] = [];
  let release: (() => void) | null = null;
  const sleep = (ms: number) =>
    new Promise<void>((r) => {
      delays.push(ms);
      release = r;
    });
  const untilSleeping = async () => {
    for (let i = 0; i < 200 && !release; i++) await new Promise((r) => setTimeout(r, 10));
    expect(release).not.toBeNull();
  };
  const wake = () => {
    const r = release!;
    release = null;
    r();
  };

  beforeAll(async () => {
    protect = await startMockProtect({ travelMs: 200 });
    protect.state.failNext = 1_000_000; // console "down" at boot
    const cfg = makeConfig({
      bridge: { mode: "live", tokens: ["live-token-0123456789abcdef"], webhookSecret: "0123456789abcdef" },
      protect: { url: protect.url, apiKey: protect.apiKey, tls: "system" },
      door: { travelSeconds: 1, verifyAfterSeconds: 0 },
      poll: { movingMs: 100, idleMs: 300 },
    });
    inst = new Instance(cfg, silentLogger, "live", { storeFile: ":memory:", transports: [] });
    app = await buildServer({ config: cfg, logger: silentLogger, instance: inst, validateResponses: true });
    await app.ready();
    void startWithRetry(inst, silentLogger, { sleep });
  });
  afterAll(async () => {
    await app.close();
    await inst.stop();
    await protect.close();
  });

  it("listens while the console is unreachable: healthz ok:false ready:false with lastError, API 503", async () => {
    await untilSleeping();
    const h = await app.inject({ method: "GET", url: "/healthz" });
    expect(h.statusCode).toBe(200);
    expect(v.validate("Health", h.json())).toEqual({ ok: true });
    expect(h.json()).toMatchObject({ ok: false, ready: false, mode: "live" });
    expect(h.json().lastError).toMatch(/console unreachable/);
    for (const [method, url] of [["GET", "/v1/state"], ["POST", "/v1/door/open"], ["GET", "/v1/discovery"], ["POST", "/v1/hold"], ["DELETE", "/v1/hold"]] as const) {
      const r = await app.inject({ method, url, headers: auth, payload: method === "POST" && url === "/v1/hold" ? { minutes: 5 } : undefined });
      expect(r.statusCode, `${method} ${url}`).toBe(503);
      expect(r.json()).toMatchObject({ error: "protect_unavailable" });
      expect(v.validate("Error", r.json())).toEqual({ ok: true });
    }
    expect((await app.inject({ method: "GET", url: "/v1/audit", headers: auth })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/v1/webhooks/alarm-manager/0123456789abcdef", payload: { alarm: { triggers: [{ key: "sensor_opened" }] } } })).statusCode).toBe(503);
    expect((await app.inject({ method: "GET", url: "/v1/state" })).statusCode).toBe(401); // auth still checked first
  });

  it("backs off exponentially (2 s → 4 s → 8 s …, capped) while the console stays down", async () => {
    wake();
    await untilSleeping();
    wake();
    await untilSleeping();
    expect(delays).toEqual([2000, 4000, 8000]);
  });

  it("becomes ready when the console comes back: healthz ok:true, state 200", async () => {
    protect.state.failNext = 0;
    wake();
    for (let i = 0; i < 200 && !inst.ready; i++) await new Promise((r) => setTimeout(r, 10));
    expect(inst.ready).toBe(true);
    expect(release).toBeNull(); // retry loop exited
    const h = await app.inject({ method: "GET", url: "/healthz" });
    expect(h.json()).toMatchObject({ ok: true, ready: true, protect: { ok: true, applicationVersion: "7.2.105" } });
    expect(h.json().lastError).toBeUndefined();
    const s = await app.inject({ method: "GET", url: "/v1/state", headers: auth });
    expect(s.statusCode).toBe(200);
    expect(s.json()).toMatchObject({ door: "CLOSED", connectionOk: true });
    expect(inst.door.mapping.relayId).toBe("6aa43ec903253903e401d542");
  });

  it("backoff caps at 60 s and stops when asked", async () => {
    const seen: number[] = [];
    const failing = { start: async () => { throw new Error("nope"); }, startError: undefined as string | undefined } as unknown as Instance;
    let stop = false;
    await startWithRetry(failing, silentLogger, { baseMs: 2000, maxMs: 60_000, sleep: async (ms) => { seen.push(ms); if (seen.length >= 7) stop = true; }, stopped: () => stop });
    expect(seen).toEqual([2000, 4000, 8000, 16000, 32000, 60000, 60000]);
    expect(failing.startError).toBe("nope");
  });
});
