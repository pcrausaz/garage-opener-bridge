import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildServer, type BridgeServer } from "../../src/http/server.js";
import { MockRegistry } from "../../src/mock/registry.js";
import { ContractValidator } from "../../src/http/validation.js";
import { mockConfig } from "../helpers.js";
import { silentLogger } from "../../src/logger.js";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Camera snapshot routes (ADR-0021) on the two-door simulator, whose doors share one interior camera. */
describe("camera snapshot routes match contract/bridge.openapi.yaml", () => {
  let app: BridgeServer;
  let registry: MockRegistry;
  const v = new ContractValidator();
  const auth = { authorization: "Bearer demo-snapshot" };
  const cfg = mockConfig({ bridge: { mockDoors: 2 }, door: { travelSeconds: 1, verifyAfterSeconds: 1 } });
  const shot = (url: string, headers: Record<string, string> = auth) => app.inject({ method: "GET", url, headers });

  beforeAll(async () => {
    registry = new MockRegistry(cfg, silentLogger);
    app = await buildServer({ config: cfg, logger: silentLogger, registry, validateResponses: true });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await registry.stop();
  });

  it("GET /v1/doors/{doorId}/camera/snapshot → the picture, no-store, with its capture time", async () => {
    const before = Date.now();
    const r = await shot("/v1/doors/d1/camera/snapshot");
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toBe("image/png"); // the mock's drawn illustration
    expect(r.headers["cache-control"]).toBe("no-store");
    const at = Date.parse(String(r.headers["x-snapshot-at"]));
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(Date.now());
    expect(r.rawPayload.subarray(0, 8)).toEqual(PNG_MAGIC);
  });

  it("two doors on one camera, the legacy route and every caller share one upstream fetch", async () => {
    const t = { authorization: "Bearer demo-snapshot-shared" };
    const inst = await registry.get("demo-snapshot-shared");
    const upstream = vi.spyOn(inst.sim!, "getCameraSnapshot");
    const all = await Promise.all([shot("/v1/doors/d1/camera/snapshot", t), shot("/v1/doors/d2/camera/snapshot", t), shot("/v1/camera/snapshot", t)]);
    expect(all.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(new Set(all.map((r) => r.headers["x-snapshot-at"])).size).toBe(1);
    await shot("/v1/doors/d2/camera/snapshot", t); // still fresh: nothing is moving
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("follows the door: a state change drops the cached picture", async () => {
    const closed = await shot("/v1/camera/snapshot");
    expect((await app.inject({ method: "POST", url: "/v1/door/open", headers: auth })).json()).toMatchObject({ ok: true, to: "OPEN" });
    const open = await shot("/v1/camera/snapshot");
    expect(open.rawPayload.equals(closed.rawPayload)).toBe(false);
    expect(Date.parse(String(open.headers["x-snapshot-at"]))).toBeGreaterThan(Date.parse(String(closed.headers["x-snapshot-at"])));
  });

  it("GET /v1/camera/snapshot is the caller's default door", async () => {
    const t = { authorization: "Bearer demo-snapshot-default" };
    const inst = await registry.get("demo-snapshot-default");
    const asked = vi.spyOn(inst.snapshots, "get");
    await shot("/v1/camera/snapshot", t);
    expect(asked).toHaveBeenLastCalledWith(inst.units[0]!.mapping.interiorCameraId);
    expect((await shot("/v1/camera/snapshot")).statusCode).toBe(200);
  });

  it("401 without a token; 404 unknown_door for a door that does not exist", async () => {
    expect((await app.inject({ method: "GET", url: "/v1/camera/snapshot" })).statusCode).toBe(401);
    const r = await shot("/v1/doors/d9/camera/snapshot");
    expect(r.statusCode).toBe(404);
    expect(r.json()).toMatchObject({ error: "unknown_door" });
    expect(v.validate("Error", r.json())).toEqual({ ok: true });
  });
});
