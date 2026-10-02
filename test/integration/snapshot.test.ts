import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fixturesDir, startMockProtect } from "../protect-mock-server.js";
import { HttpProtectClient } from "../../src/protect/client.js";
import { Instance } from "../../src/instance.js";
import { buildServer, type BridgeServer } from "../../src/http/server.js";
import { makeConfig } from "../../src/config.js";
import { silentLogger } from "../../src/logger.js";
import { ContractValidator } from "../../src/http/validation.js";

const GARAGE_CAMERA = "650b2b3c03738b03e4013954";
const picture = readFileSync(join(fixturesDir, "synthetic-snapshot.jpg")); // generated colour bars, never a capture

/** Snapshots through the real HTTP client, against a console that answers as the captured one did (ADR-0021). */
describe("camera snapshot against the fixture-backed Protect mock", () => {
  let protect: Awaited<ReturnType<typeof startMockProtect>>;
  let inst: Instance;
  let app: BridgeServer;
  const v = new ContractValidator();
  const auth = { authorization: "Bearer live-token-0123456789abcdef" };
  const cfg = () =>
    makeConfig({
      bridge: { mode: "live", tokens: ["live-token-0123456789abcdef"] },
      protect: { url: protect.url, apiKey: protect.apiKey, tls: "system" },
      poll: { movingMs: 100, idleMs: 300 },
    });
  const snapshot = () => app.inject({ method: "GET", url: "/v1/camera/snapshot", headers: auth });
  /** As if a door state change had dropped whatever is cached, including a remembered failure. */
  const forget = () => inst.snapshots.invalidate(GARAGE_CAMERA);

  beforeAll(async () => {
    protect = await startMockProtect();
    inst = new Instance(cfg(), silentLogger, "live", { storeFile: ":memory:", transports: [] });
    await inst.start();
    app = await buildServer({ config: cfg(), logger: silentLogger, instance: inst, validateResponses: true });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await inst.stop();
    await protect.close();
  });

  it("the client asks for the default picture: never highQuality, never any query at all", async () => {
    const client = new HttpProtectClient({ baseUrl: protect.url, apiKey: protect.apiKey, tls: "system", logger: silentLogger });
    const s = await client.getCameraSnapshot(GARAGE_CAMERA);
    expect(s.contentType).toBe("image/jpeg");
    expect(s.body.equals(picture)).toBe(true);
    expect(protect.state.snapshotRequests).toEqual([`/proxy/protect/integration/v1/cameras/${GARAGE_CAMERA}/snapshot`]);
    await expect(client.getCameraSnapshot("0000000000000000000000ff")).rejects.toMatchObject({ name: "ProtectError", status: 404 });
    const wrongKey = new HttpProtectClient({ baseUrl: protect.url, apiKey: "wrong", tls: "system", logger: silentLogger });
    await expect(wrongKey.getCameraSnapshot(GARAGE_CAMERA)).rejects.toMatchObject({ status: 401 });
    await client.close();
    await wrongKey.close();
  });

  it("serves the console's JPEG as no-store with the capture time, whatever the console said about caching", async () => {
    expect(inst.door.mapping.interiorCameraId).toBe(GARAGE_CAMERA);
    expect(inst.doorList()[0]).toMatchObject({ id: "d1", hasCamera: true });
    protect.state.snapshotRequests.length = 0;
    const r = await snapshot();
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toBe("image/jpeg");
    expect(r.headers["cache-control"]).toBe("no-store"); // upstream: private, max-age=3600
    expect(Number.isNaN(Date.parse(String(r.headers["x-snapshot-at"])))).toBe(false);
    expect(r.rawPayload.equals(picture)).toBe(true);
    // A second phone a moment later, and the door-scoped route, are served from the same fetch.
    await snapshot();
    await app.inject({ method: "GET", url: "/v1/doors/d1/camera/snapshot", headers: auth });
    expect(protect.state.snapshotRequests).toHaveLength(1);
    expect(protect.state.snapshotRequests.every((u) => !u.includes("?"))).toBe(true);
  });

  it("maps console failures to distinct errors, and serves nothing stale in their place", async () => {
    for (const [upstream, status, error] of [[401, 502, "camera_forbidden"], [403, 502, "camera_forbidden"], [429, 429, "rate_limited"], [503, 503, "camera_unavailable"], [404, 503, "camera_unavailable"]] as const) {
      forget();
      protect.state.snapshotStatus = upstream;
      const r = await snapshot();
      expect(r.statusCode, `upstream ${upstream}`).toBe(status);
      expect(r.json()).toMatchObject({ error });
      expect(v.validate("Error", r.json())).toEqual({ ok: true });
      expect(r.headers["x-snapshot-at"]).toBeUndefined();
    }
    protect.state.snapshotStatus = 200;
    // Within the short window the failure is remembered rather than retried against the console…
    expect((await snapshot()).statusCode).toBe(503);
    forget();
    expect((await snapshot()).statusCode).toBe(200);
  });

  it("404 no_camera when the door has no interior camera mapped", async () => {
    const bare = new Instance(cfg(), silentLogger, "live", { storeFile: ":memory:", transports: [] });
    bare.store.set("mapping", { relayId: "6aa43ec903253903e401d542", outputId: 0, sensorId: "6609938d012d0803e408748d", interiorCameraId: null, drivewayCameraId: null });
    await bare.start();
    const server = await buildServer({ config: cfg(), logger: silentLogger, instance: bare, validateResponses: true });
    try {
      expect(bare.doorList()[0]).toMatchObject({ hasCamera: false });
      for (const url of ["/v1/camera/snapshot", "/v1/doors/d1/camera/snapshot"]) {
        const r = await server.inject({ method: "GET", url, headers: auth });
        expect(r.statusCode).toBe(404);
        expect(r.json()).toMatchObject({ error: "no_camera" });
        expect(v.validate("Error", r.json())).toEqual({ ok: true });
      }
    } finally {
      await server.close();
      await bare.stop();
    }
  });
});
