import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer, type BridgeServer } from "../../src/http/server.js";
import { MockRegistry } from "../../src/mock/registry.js";
import { ContractValidator } from "../../src/http/validation.js";
import { mockConfig } from "../helpers.js";
import { silentLogger } from "../../src/logger.js";
import { SIM_IDS, SIM_IDS_2 } from "../../src/protect/simulator.js";

/** The door-scoped half of the contract (0.6, ADR-0020), on a two-door simulator. */
describe("door-scoped routes match contract/bridge.openapi.yaml", () => {
  let app: BridgeServer;
  let registry: MockRegistry;
  const v = new ContractValidator();
  const auth = { authorization: "Bearer demo-doors" };
  const cfg = mockConfig({ bridge: { mockDoors: 2 }, door: { travelSeconds: 1, verifyAfterSeconds: 1 } });
  const get = (url: string, headers = auth) => app.inject({ method: "GET", url, headers });

  beforeAll(async () => {
    registry = new MockRegistry(cfg, silentLogger);
    app = await buildServer({ config: cfg, logger: silentLogger, registry, validateResponses: true });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await registry.stop();
  });

  it("GET /v1/doors → DoorList", async () => {
    const r = await get("/v1/doors");
    expect(r.statusCode).toBe(200);
    expect(v.validate("DoorList", r.json())).toEqual({ ok: true });
    expect(r.json()).toEqual({
      doors: [
        { id: "d1", name: "Left Door", hasCamera: true, cameraName: "Garage (mock)", mapping: { ...SIM_IDS } },
        { id: "d2", name: "Right Door", hasCamera: true, cameraName: "Garage (mock)", mapping: { ...SIM_IDS_2 } },
      ],
      defaultDoorId: "d1",
    });
    expect((await app.inject({ method: "GET", url: "/v1/doors" })).statusCode).toBe(401);
  });

  it("GET /v1/doors/{doorId}/state → State carrying doorId; unknown door → 404 unknown_door", async () => {
    const r = await get("/v1/doors/d2/state");
    expect(r.statusCode).toBe(200);
    expect(v.validate("State", r.json())).toEqual({ ok: true });
    expect(r.json()).toMatchObject({ doorId: "d2", door: "CLOSED", relay: { outputId: 1 }, sensor: { id: SIM_IDS_2.sensorId } });
    const missing = await get("/v1/doors/d3/state");
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: "unknown_door" });
    expect(v.validate("Error", missing.json())).toEqual({ ok: true });
  });

  it("door commands by id → CommandResult / CommandAccepted carrying doorId, 409, 404", async () => {
    const open = await app.inject({ method: "POST", url: "/v1/doors/d2/open?source=contract", headers: auth });
    expect(open.statusCode).toBe(200);
    expect(v.validate("CommandResult", open.json())).toEqual({ ok: true });
    expect(open.json()).toMatchObject({ ok: true, to: "OPEN", pulsed: true, doorId: "d2" });
    expect((await get("/v1/doors/d1/state")).json().door).toBe("CLOSED");

    const close = await app.inject({ method: "POST", url: "/v1/doors/d2/close?wait=false", headers: auth });
    expect(close.statusCode).toBe(202);
    expect(v.validate("CommandAccepted", close.json())).toEqual({ ok: true });
    expect(close.json().doorId).toBe("d2");
    const busy = await app.inject({ method: "POST", url: "/v1/doors/d2/toggle", headers: auth });
    expect(busy.statusCode).toBe(409);
    expect(busy.json()).toMatchObject({ error: "door_busy" });
    // The other door is not busy.
    const other = await app.inject({ method: "POST", url: "/v1/doors/d1/toggle?wait=false", headers: auth });
    expect(other.statusCode).toBe(202);

    const stop = await app.inject({ method: "POST", url: "/v1/doors/d2/stop", headers: auth });
    expect(stop.statusCode).toBe(200);
    expect(v.validate("CommandResult", stop.json())).toEqual({ ok: true });
    expect(stop.json()).toMatchObject({ command: "stop", to: "STOPPED", verified: false, doorId: "d2" });
    expect((await app.inject({ method: "POST", url: "/v1/doors/d2/stop", headers: auth })).json()).toMatchObject({ error: "door_not_moving" });

    for (const c of ["open", "close", "toggle", "stop"]) {
      const r = await app.inject({ method: "POST", url: `/v1/doors/nope/${c}`, headers: auth });
      expect(r.statusCode, c).toBe(404);
      expect(r.json()).toMatchObject({ error: "unknown_door" });
    }
    const audit = (await get("/v1/audit?kind=command&limit=20")).json().entries as { doorId?: string }[];
    for (const e of audit) expect(v.validate("AuditEntry", e)).toEqual({ ok: true });
    expect(new Set(audit.map((e) => e.doorId))).toEqual(new Set(["d1", "d2"]));
  });

  it("PUT|DELETE /v1/doors/{doorId}/hold → Hold carrying doorId / 400 / 204 / 404", async () => {
    const bad = await app.inject({ method: "PUT", url: "/v1/doors/d2/hold", headers: auth, payload: { minutes: 0 } });
    expect(bad.statusCode).toBe(400);
    const r = await app.inject({ method: "PUT", url: "/v1/doors/d2/hold", headers: auth, payload: { minutes: 45 } });
    expect(r.statusCode).toBe(200);
    expect(v.validate("Hold", r.json())).toEqual({ ok: true });
    expect(r.json()).toMatchObject({ active: true, minutes: 45, doorId: "d2" });
    expect((await get("/v1/doors/d2/state")).json().hold.active).toBe(true);
    expect((await get("/v1/doors/d1/state")).json().hold).toEqual({ active: false });
    expect((await app.inject({ method: "DELETE", url: "/v1/doors/d2/hold", headers: auth })).statusCode).toBe(204);
    expect((await get("/v1/doors/d2/state")).json().hold).toEqual({ active: false });
    expect((await app.inject({ method: "PUT", url: "/v1/doors/d9/hold", headers: auth, payload: { minutes: 5 } })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: "/v1/doors/d9/hold", headers: auth })).statusCode).toBe(404);
  });

  it("PUT /v1/doors/default → DefaultDoor; 400 for a door that does not exist", async () => {
    const t = { authorization: "Bearer demo-default" };
    for (const payload of [undefined, {}, { doorId: 2 }, { doorId: "d7" }]) {
      const bad = await app.inject({ method: "PUT", url: "/v1/doors/default", headers: t, ...(payload ? { payload } : {}) });
      expect(bad.statusCode, JSON.stringify(payload)).toBe(400);
      expect(v.validate("Error", bad.json())).toEqual({ ok: true });
    }
    const r = await app.inject({ method: "PUT", url: "/v1/doors/default", headers: t, payload: { doorId: "d2" } });
    expect(r.statusCode).toBe(200);
    expect(v.validate("DefaultDoor", r.json())).toEqual({ ok: true });
    expect(r.json()).toEqual({ doorId: "d2" });
    expect((await get("/v1/doors", t)).json().defaultDoorId).toBe("d2");
    expect((await get("/v1/doors")).json().defaultDoorId).toBe("d1"); // someone else's is untouched
  });

  it("GET /v1/discovery → Discovery with doors, and the name-based pairing as a suggestion only", async () => {
    const r = await get("/v1/discovery");
    expect(r.statusCode).toBe(200);
    expect(v.validate("Discovery", r.json())).toEqual({ ok: true });
    const d = r.json();
    expect(d.doors.map((x: { id: string }) => x.id)).toEqual(["d1", "d2"]);
    expect(d.current).toEqual({ ...SIM_IDS });
    expect(d).not.toHaveProperty("suggested"); // two of each: nothing to auto-pair
    expect(d.autoPaired).toBe(false);
    expect(d.suggestedDoors.map((m: { outputId: number; sensorId: string }) => [m.outputId, m.sensorId])).toEqual([[0, SIM_IDS.sensorId], [1, SIM_IDS_2.sensorId]]);
  });

  it("invites: the claim lists the doors and starts the phone on the invite's door", async () => {
    const admin = { authorization: "Bearer test-token-1" };
    expect((await app.inject({ method: "POST", url: "/v1/invites", headers: admin, payload: { defaultDoorId: "d5" } })).statusCode).toBe(400);
    const inv = await app.inject({ method: "POST", url: "/v1/invites", headers: admin, payload: { name: "Margo", defaultDoorId: "d2" } });
    expect(inv.statusCode).toBe(201);
    expect(v.validate("Invite", inv.json())).toEqual({ ok: true });
    const claim = await app.inject({ method: "POST", url: `/v1/invites/${inv.json().code}/claim`, payload: { deviceName: "Margo" } });
    expect(claim.statusCode).toBe(200);
    expect(v.validate("InviteClaim", claim.json())).toEqual({ ok: true });
    expect(claim.json()).toMatchObject({ defaultDoorId: "d2", mapping: { outputId: 1, sensorId: SIM_IDS_2.sensorId } });
    expect(claim.json().doors.map((x: { id: string }) => x.id)).toEqual(["d1", "d2"]);
    const member = { authorization: `Bearer ${claim.json().token}` };
    expect((await get("/v1/doors", member)).json().defaultDoorId).toBe("d2");
    expect((await get("/v1/doors", admin)).json().defaultDoorId).toBe("d1");

    // Without a door on the invite the phone inherits the inviter's default.
    await app.inject({ method: "PUT", url: "/v1/doors/default", headers: admin, payload: { doorId: "d2" } });
    const plain = await app.inject({ method: "POST", url: "/v1/invites", headers: admin });
    const inherited = await app.inject({ method: "POST", url: `/v1/invites/${plain.json().code}/claim`, payload: { deviceName: "Watch" } });
    expect(inherited.json().defaultDoorId).toBe("d2");
  });

  it("mock actions take a doorId; the response is that door's state", async () => {
    const t = { authorization: "Bearer demo-mock-doors" };
    const arrived = await app.inject({ method: "POST", url: "/v1/mock/vehicle-arrived", headers: t, payload: { doorId: "d2" } });
    expect(arrived.statusCode).toBe(200);
    expect(v.validate("State", arrived.json())).toEqual({ ok: true });
    expect(arrived.json()).toMatchObject({ relay: { outputId: 1 }, vehicle: { present: true } });
    expect((await get("/v1/doors/d1/state", t)).json().vehicle.present).toBe(false);
    const unknown = await app.inject({ method: "POST", url: "/v1/mock/reset", headers: t, payload: { doorId: "d4" } });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ error: "unknown_door" });
    const reset = await app.inject({ method: "POST", url: "/v1/mock/reset", headers: t });
    expect(reset.json()).toMatchObject({ relay: { outputId: 0 } });
    expect((await get("/v1/doors/d2/state", t)).json().vehicle.present).toBe(false);
  });

  it("GET /v1/audit.csv names the door in a trailing column when there is more than one", async () => {
    const r = await get("/v1/audit.csv?kind=command&limit=50");
    const lines = r.body.trimEnd().split("\r\n");
    expect(lines[0]).toBe("id,at,kind,source,member,command,from,to,outcome,detail,door");
    expect(new Set(lines.slice(1).map((l) => l.split(",").at(-1)))).toEqual(new Set(["Left Door", "Right Door"]));
  });

  it("GET /v1/events rejects a `doors` value it does not know", async () => {
    const r = await get("/v1/events?doors=d2");
    expect(r.statusCode).toBe(400);
    expect(v.validate("Error", r.json())).toEqual({ ok: true });
  });
});

describe("door-scoped routes on a one-door bridge", () => {
  let app: BridgeServer;
  let registry: MockRegistry;
  const v = new ContractValidator();
  const auth = { authorization: "Bearer demo-one-door" };
  const cfg = mockConfig({ door: { travelSeconds: 1, verifyAfterSeconds: 1 } });

  beforeAll(async () => {
    registry = new MockRegistry(cfg, silentLogger);
    app = await buildServer({ config: cfg, logger: silentLogger, registry, validateResponses: true });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await registry.stop();
  });

  it("is a list of one door, d1, reachable by id too", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/doors", headers: auth });
    expect(v.validate("DoorList", r.json())).toEqual({ ok: true });
    expect(r.json()).toEqual({ doors: [{ id: "d1", name: "Garage Door", hasCamera: true, cameraName: "Garage (mock)", mapping: { ...SIM_IDS } }], defaultDoorId: "d1" });
    expect((await app.inject({ method: "GET", url: "/v1/doors/d1/state", headers: auth })).json()).toMatchObject({ doorId: "d1", door: "CLOSED" });
    expect((await app.inject({ method: "GET", url: "/v1/doors/d2/state", headers: auth })).statusCode).toBe(404);
    expect((await app.inject({ method: "PUT", url: "/v1/doors/default", headers: auth, payload: { doorId: "d2" } })).statusCode).toBe(400);
    const d = (await app.inject({ method: "GET", url: "/v1/discovery", headers: auth })).json();
    expect(d.doors).toHaveLength(1);
    expect(d).not.toHaveProperty("suggestedDoors");
    expect(d.suggested).toEqual(d.current);
  });
});
