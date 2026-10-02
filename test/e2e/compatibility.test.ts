import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer, type BridgeServer } from "../../src/http/server.js";
import { MockRegistry } from "../../src/mock/registry.js";
import { mockConfig } from "../helpers.js";
import { silentLogger } from "../../src/logger.js";
import { VERSION } from "../../src/version.js";
import { SIM_IDS, SIM_IDS_2 } from "../../src/protect/simulator.js";
import type { ConfigInput } from "../../src/config.js";

/**
 * Compatibility (ADR-0020). Bridges 0.5.x and app 1.0.x are in the field and either side may be upgraded
 * first. A 1.0.x app knows one door and only the routes without a door id, so on a 0.6 bridge those routes
 * must keep their exact shapes and must mean one door — the caller's default — and never the other one.
 */

/** The field names each payload had in 0.5.2. A new field here is a change to what a 1.0.x app is sent. */
const STATE_KEYS = ["connectionOk", "door", "hold", "isOpened", "mode", "nextPress", "openTooLongMinutes", "relay", "sensor", "since", "travelSeconds", "updatedAt", "vehicle"];
const RESULT_KEYS = ["auditId", "command", "finishedAt", "from", "ok", "pulsed", "startedAt", "to", "verified"];
const keys = (o: object) => Object.keys(o).filter((k) => k !== "lastChangedAt").sort();

interface Frame {
  event: string;
  data: Record<string, unknown> & { relay?: { outputId: number } };
}

async function boot(over: ConfigInput = {}) {
  const cfg = mockConfig({ door: { travelSeconds: 1, verifyAfterSeconds: 1 }, ...over });
  const registry = new MockRegistry(cfg, silentLogger);
  const app = await buildServer({ config: cfg, logger: silentLogger, registry, validateResponses: true });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const call = (token: string, path: string, init: RequestInit = {}) =>
    fetch(base + path, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) } });
  const json = async <T = Record<string, any>>(token: string, path: string, init: RequestInit = {}) => (await (await call(token, path, init)).json()) as T;
  /** Opens an event stream and collects its frames (heartbeats aside) until `stop()`. */
  const listen = async (token: string, query = "") => {
    const ac = new AbortController();
    const res = await fetch(`${base}/v1/events?token=${token}${query}`, { signal: ac.signal });
    const frames: Frame[] = [];
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const pump = (async () => {
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) return;
          buf += dec.decode(chunk.value, { stream: true });
          for (let end = buf.indexOf("\n\n"); end >= 0; end = buf.indexOf("\n\n")) {
            const [, event, data] = /^event: (.*)\ndata: (.*)$/s.exec(buf.slice(0, end))!;
            buf = buf.slice(end + 2);
            if (event !== "heartbeat") frames.push({ event: event!, data: JSON.parse(data!) });
          }
        }
      } catch {
        /* aborted */
      }
    })();
    const until = async (pred: () => boolean, ms = 4000) => {
      const end = Date.now() + ms;
      while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
      return pred();
    };
    return { frames, until, stop: async () => (ac.abort(), pump) };
  };
  return { app, registry, call, json, listen, close: async () => (await app.close(), registry.stop()) };
}

describe("compatibility: a 0.5-style configuration boots as one door, d1, and answers as 0.5.2 did", () => {
  let b: Awaited<ReturnType<typeof boot>>;
  const t = "demo-compat-one";
  beforeAll(async () => {
    b = await boot();
  });
  afterAll(() => b.close());

  it("has exactly one door, d1, paired by discovery as before", async () => {
    const inst = await b.registry.get(t);
    expect(inst.units.map((u) => u.id)).toEqual(["d1"]);
    expect(inst.door.mapping).toEqual({ ...SIM_IDS });
    expect(inst.store.get("mapping")).toEqual({ ...SIM_IDS });
    expect(inst.store.get("autoPaired")).toBe(true);
  });

  it("/healthz is byte-for-byte what it was", async () => {
    const r = await fetch(`${b.app.listeningOrigin}/healthz`);
    expect(await r.text()).toBe(`{"ok":true,"ready":true,"mode":"mock","version":"${VERSION}","protect":{"ok":true,"applicationVersion":"mock"}}`);
  });

  it("state, commands, hold and mock actions carry no field they did not have", async () => {
    expect(keys(await b.json(t, "/v1/state"))).toEqual(STATE_KEYS);
    const open = await b.json(t, "/v1/door/open?source=compat", { method: "POST" });
    expect(keys(open)).toEqual(RESULT_KEYS);
    expect(open).toMatchObject({ ok: true, from: "CLOSED", to: "OPEN" });
    const accepted = await b.json(t, "/v1/door/close?wait=false", { method: "POST" });
    expect(Object.keys(accepted).sort()).toEqual(["accepted", "auditId", "command", "expectedBy"]);
    expect(keys(await b.json(t, "/v1/door/stop", { method: "POST" }))).toEqual(RESULT_KEYS);
    expect(await b.json(t, "/v1/hold", { method: "POST", body: JSON.stringify({ minutes: 5 }) })).toEqual({ active: true, minutes: 5, until: expect.any(String), setAt: expect.any(String) });
    expect((await b.call(t, "/v1/hold", { method: "DELETE" })).status).toBe(204);
    expect(keys(await b.json(t, "/v1/mock/reset", { method: "POST" }))).toEqual(STATE_KEYS);
  });

  it("discovery keeps current, suggested and autoPaired; the claim keeps mapping", async () => {
    const d = await b.json(t, "/v1/discovery");
    expect(d).toMatchObject({ current: { ...SIM_IDS }, suggested: { ...SIM_IDS }, autoPaired: true });
    const admin = "test-token-1";
    const inv = await b.json(admin, "/v1/invites", { method: "POST" });
    const claim = await (await fetch(`${b.app.listeningOrigin}/v1/invites/${inv.code}/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceName: "Old phone" }) })).json();
    expect(claim).toMatchObject({ token: expect.any(String), member: { name: "Old phone" }, bridge: { mode: "mock" }, mapping: { ...SIM_IDS } });
  });

  it("the activity log keeps its entries' fields (plus doorId) and its ten CSV columns", async () => {
    const { entries } = await b.json<{ entries: Record<string, unknown>[] }>(t, "/v1/audit?kind=command&limit=1");
    expect(Object.keys(entries[0]!).sort()).toEqual(["at", "command", "detail", "doorId", "from", "id", "kind", "member", "outcome", "source", "to"]);
    const csv = await (await b.call(t, "/v1/audit.csv?limit=1")).text();
    expect(csv.split("\r\n")[0]).toBe("id,at,kind,source,member,command,from,to,outcome,detail");
  });

  it("the event stream sends the frames it always sent", async () => {
    const s = await b.listen(t);
    await b.call(t, "/v1/door/open?wait=false", { method: "POST" });
    expect(await s.until(() => s.frames.some((f) => f.event === "command"))).toBe(true);
    await s.stop();
    expect(s.frames[0]!.event).toBe("state");
    for (const f of s.frames.filter((f) => f.event === "state")) expect(keys(f.data)).toEqual(STATE_KEYS);
    for (const f of s.frames.filter((f) => f.event === "command")) expect(keys(f.data)).toEqual(RESULT_KEYS);
  });
});

describe("compatibility: on a two-door bridge the routes without a door id act on the caller's default door", () => {
  let b: Awaited<ReturnType<typeof boot>>;
  const state = (t: string, door: string) => b.json(t, `/v1/doors/${door}/state`);
  beforeAll(async () => {
    b = await boot({ bridge: { mockDoors: 2 } });
  });
  afterAll(() => b.close());

  it("that is d1 until a default is set, in the same shapes as on a one-door bridge", async () => {
    const t = "demo-compat-d1";
    const s = await b.json(t, "/v1/state");
    expect(keys(s)).toEqual(STATE_KEYS);
    expect(s).toMatchObject({ relay: { outputId: 0 }, sensor: { id: SIM_IDS.sensorId } });

    const open = await b.json(t, "/v1/door/open", { method: "POST" });
    expect(keys(open)).toEqual(RESULT_KEYS);
    expect([(await state(t, "d1")).door, (await state(t, "d2")).door]).toEqual(["OPEN", "CLOSED"]);

    await b.call(t, "/v1/hold", { method: "POST", body: JSON.stringify({ minutes: 30 }) });
    expect([(await state(t, "d1")).hold.active, (await state(t, "d2")).hold.active]).toEqual([true, false]);
    expect((await b.call(t, "/v1/hold", { method: "DELETE" })).status).toBe(204);
    expect((await state(t, "d1")).hold.active).toBe(false);

    expect((await b.json(t, "/v1/discovery")).current).toEqual({ ...SIM_IDS });
    expect(await b.json(t, "/v1/door/toggle?wait=false", { method: "POST" })).toMatchObject({ accepted: true });
    expect((await b.json(t, "/v1/door/stop", { method: "POST" })).to).toBe("STOPPED");
    expect([(await state(t, "d1")).door, (await state(t, "d2")).door]).toEqual(["STOPPED", "CLOSED"]);
    expect((await b.json(t, "/v1/mock/vehicle-arrived", { method: "POST" })).relay.outputId).toBe(0);
    expect([(await state(t, "d1")).vehicle.present, (await state(t, "d2")).vehicle.present]).toEqual([true, false]);
  });

  it("after PUT /v1/doors/default they act on the chosen door, and only for that caller", async () => {
    const admin = "test-token-1";
    const inv = await b.json(admin, "/v1/invites", { method: "POST" });
    const claim = (await (await fetch(`${b.app.listeningOrigin}/v1/invites/${inv.code}/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceName: "Margo" }) })).json()) as { token: string };
    const member = claim.token;
    expect((await b.call(member, "/v1/doors/default", { method: "PUT", body: JSON.stringify({ doorId: "d2" }) })).status).toBe(200);

    expect(await b.json(member, "/v1/state")).toMatchObject({ relay: { outputId: 1 }, sensor: { id: SIM_IDS_2.sensorId } });
    expect(await b.json(admin, "/v1/state")).toMatchObject({ relay: { outputId: 0 } });
    expect((await b.json(member, "/v1/discovery")).current).toEqual({ ...SIM_IDS_2 });

    expect(await b.json(member, "/v1/door/open?source=app", { method: "POST" })).toMatchObject({ ok: true, to: "OPEN" });
    expect([(await state(admin, "d1")).door, (await state(admin, "d2")).door]).toEqual(["CLOSED", "OPEN"]);
    const last = (await b.json<{ entries: Record<string, unknown>[] }>(admin, "/v1/audit?kind=command&limit=1")).entries[0];
    expect(last).toMatchObject({ command: "open", member: "Margo", doorId: "d2" });

    await b.call(member, "/v1/hold", { method: "POST", body: JSON.stringify({ minutes: 10 }) });
    expect([(await state(admin, "d1")).hold.active, (await state(admin, "d2")).hold.active]).toEqual([false, true]);

    // The admin, who chose nothing, still drives d1 through the very same routes.
    expect(await b.json(admin, "/v1/door/open", { method: "POST" })).toMatchObject({ ok: true, from: "CLOSED", to: "OPEN" });
    expect((await b.json(member, "/v1/mock/reverse-next-close", { method: "POST" })).relay.outputId).toBe(1);
    const inst = await b.registry.get(admin);
    expect(inst.sim!.doors.map((d) => d.reverseNextClose)).toEqual([false, true]);
  });
});

describe("compatibility: the legacy event stream never carries the other door", () => {
  let b: Awaited<ReturnType<typeof boot>>;
  beforeAll(async () => {
    b = await boot({ bridge: { mockDoors: 2 } });
  });
  afterAll(() => b.close());

  it("/v1/events without parameters carries only the default door's events, without doorId", async () => {
    const t = "demo-compat-stream";
    const s = await b.listen(t);
    await s.until(() => s.frames.length > 0);
    expect(s.frames).toHaveLength(1); // one initial state, not one per door

    // Everything that can make the other door talk: a command, its verification, a hold, a vehicle.
    await b.call(t, "/v1/doors/d2/open", { method: "POST" });
    await b.call(t, "/v1/doors/d2/hold", { method: "PUT", body: JSON.stringify({ minutes: 5 }) });
    await b.call(t, "/v1/mock/vehicle-arrived", { method: "POST", body: JSON.stringify({ doorId: "d2" }) });
    await new Promise((r) => setTimeout(r, 300));
    expect(s.frames).toHaveLength(1);

    // …while the default door's events arrive in the shapes a one-door stream has.
    await b.call(t, "/v1/door/open", { method: "POST" });
    await b.call(t, "/v1/hold", { method: "POST", body: JSON.stringify({ minutes: 5 }) });
    expect(await s.until(() => s.frames.some((f) => f.event === "hold"))).toBe(true);
    await s.stop();
    expect(s.frames.filter((f) => f.event !== "state").map((f) => f.event)).toEqual(["command", "hold"]);
    expect(s.frames.filter((f) => f.event === "state").map((f) => f.data.door)).toEqual(expect.arrayContaining(["CLOSED", "OPENING", "OPEN"]));
    for (const f of s.frames) expect(f.data).not.toHaveProperty("doorId");
    for (const f of s.frames.filter((f) => f.event === "state")) {
      expect(keys(f.data)).toEqual(STATE_KEYS);
      expect(f.data.relay!.outputId).toBe(0);
    }
    expect(keys(s.frames.find((f) => f.event === "command")!.data)).toEqual(RESULT_KEYS);
  });

  it("follows the caller's default door when it changes, starting with that door's state", async () => {
    const t = "demo-compat-switch";
    const s = await b.listen(t);
    await s.until(() => s.frames.length > 0);
    await b.call(t, "/v1/doors/default", { method: "PUT", body: JSON.stringify({ doorId: "d2" }) });
    expect(await s.until(() => s.frames.length === 2)).toBe(true);
    expect(s.frames[1]).toMatchObject({ event: "state", data: { door: "CLOSED", relay: { outputId: 1 } } });

    await b.call(t, "/v1/doors/d1/open?wait=false", { method: "POST" }); // no longer this stream's door
    await b.call(t, "/v1/door/open?wait=false", { method: "POST" });
    expect(await s.until(() => s.frames.length >= 3)).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    await s.stop();
    for (const f of s.frames.slice(1)) if (f.event === "state") expect(f.data.relay!.outputId).toBe(1);
    for (const f of s.frames) expect(f.data).not.toHaveProperty("doorId");
  });

  it("/v1/events?doors=all carries every door's events, each with doorId", async () => {
    const t = "demo-compat-all";
    const s = await b.listen(t, "&doors=all");
    await s.until(() => s.frames.length >= 2);
    expect(s.frames.map((f) => [f.event, f.data.doorId, f.data.relay!.outputId])).toEqual([["state", "d1", 0], ["state", "d2", 1]]);

    await b.call(t, "/v1/doors/d2/open", { method: "POST" });
    await b.call(t, "/v1/hold", { method: "POST", body: JSON.stringify({ minutes: 5 }) });
    await b.call(t, "/v1/mock/vehicle-arrived", { method: "POST", body: JSON.stringify({ doorId: "d2" }) });
    expect(await s.until(() => s.frames.some((f) => f.event === "vehicle"))).toBe(true);
    await s.stop();
    for (const f of s.frames) expect(f.data.doorId, f.event).toMatch(/^d[12]$/);
    const seen = s.frames.slice(2).map((f) => `${f.event}:${f.data.doorId}`);
    expect(seen).toContain("command:d2");
    expect(seen).toContain("hold:d1");
    expect(seen).toContain("vehicle:d2");
    expect(seen.filter((x) => x.startsWith("state:"))).not.toContain("state:d1");
  });
});
