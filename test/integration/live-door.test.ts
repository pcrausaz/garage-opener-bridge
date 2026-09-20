import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startMockProtect } from "../protect-mock-server.js";
import { HttpProtectClient } from "../../src/protect/client.js";
import { Instance } from "../../src/instance.js";
import { makeConfig } from "../../src/config.js";
import { silentLogger } from "../../src/logger.js";
import { CaptureTransport } from "../helpers.js";

describe("live door service against the fixture-backed Protect mock", () => {
  let protect: Awaited<ReturnType<typeof startMockProtect>>;
  beforeAll(async () => {
    // a truly pulsing relay + native mode; the toggling USL-Relay is covered in relay-toggle.test.ts
    protect = await startMockProtect({ travelMs: 200, relayBehaviour: "pulse" });
  });
  afterAll(async () => {
    await protect.close();
  });

  const cfg = (extra = {}) =>
    makeConfig({
      bridge: { mode: "live", tokens: ["live-token-1"] },
      protect: { url: protect.url, apiKey: protect.apiKey, tls: "system" },
      door: { travelSeconds: 1, verifyAfterSeconds: 0 },
      poll: { movingMs: 100, idleMs: 300 },
      relay: { pulseMode: "native" },
      ...extra,
    });

  it("discovers the real ids, auto-pairs and reads the sensor", async () => {
    const inst = new Instance(cfg(), silentLogger, "live", { storeFile: ":memory:", transports: [new CaptureTransport()] });
    await inst.start();
    try {
      expect(inst.door.mapping).toEqual({
        relayId: "6aa43ec903253903e401d542",
        outputId: 0,
        sensorId: "6609938d012d0803e408748d",
        interiorCameraId: "650b2b3c03738b03e4013954",
        drivewayCameraId: "64dd4c4303e52b03e4008041",
      });
      const s = inst.state();
      expect(s.door).toBe("CLOSED");
      expect(s.sensor.name).toBe("Garage Door State");
      expect(s.sensor.battery).toEqual({ percentage: 76, isLow: false });
      expect(s.relay).toMatchObject({ outputId: 0, name: "Garage Door", pulseDurationMs: 100, connected: true });
      expect(inst.health()).toMatchObject({ ok: true, mode: "live", protect: { ok: true, applicationVersion: "7.2.105" } });
      const d = await inst.discoveryNow();
      expect(d.autoPaired).toBe(true);
      expect(d.cameras.find((c) => c.name.startsWith("Driveway"))?.smartDetectTypes).toContain("vehicle");
    } finally {
      await inst.stop();
    }
  });

  it("open → pulse once → verified OPEN; second command while moving → 409; close → CLOSED", async () => {
    protect.setOpened(false);
    protect.state.activations.length = 0;
    const inst = new Instance(cfg(), silentLogger, "live", { storeFile: ":memory:", transports: [] });
    await inst.start();
    try {
      const p = inst.door.open({ source: "test" });
      await expect(inst.door.close({ source: "test" })).rejects.toMatchObject({ code: "door_busy" });
      const r = await p;
      expect(r).toMatchObject({ ok: true, from: "CLOSED", to: "OPEN", pulsed: true, verified: true });
      expect(protect.state.activations).toEqual([expect.objectContaining({ relayId: "6aa43ec903253903e401d542", outputId: 0 })]);
      const again = await inst.door.open({ source: "test" });
      expect(again).toMatchObject({ ok: true, pulsed: false, from: "OPEN", to: "OPEN" });
      const c = await inst.door.close({ source: "test" });
      expect(c).toMatchObject({ ok: true, to: "CLOSED" });
      expect(protect.state.activations).toHaveLength(2);
      const audit = inst.store.listAudit(10);
      expect(audit.map((a) => [a.kind, a.command, a.outcome])).toEqual([
        ["command", "close", "ok"],
        ["command", "open", "noop"],
        ["command", "close", "rejected"],
        ["command", "open", "ok"],
      ]);
    } finally {
      await inst.stop();
    }
  });

  it("emulated pulse mode activates twice", async () => {
    protect.setOpened(false);
    protect.state.activations.length = 0;
    const inst = new Instance(cfg({ relay: { pulseMode: "emulated", pulseMs: 20 } }), silentLogger, "live", { storeFile: ":memory:", transports: [] });
    await inst.start();
    try {
      await inst.door.open({ source: "test" });
      expect(protect.state.activations).toHaveLength(2);
    } finally {
      await inst.stop();
    }
  });

  it("reports STUCK when the sensor never confirms and recovers on the next edge", async () => {
    const stuck = await startMockProtect({ travelMs: null, relayBehaviour: "pulse" });
    const inst = new Instance(cfg({ protect: { url: stuck.url, apiKey: stuck.apiKey, tls: "system" } }), silentLogger, "live", { storeFile: ":memory:", transports: [] });
    await inst.start();
    try {
      const r = await inst.door.open({ source: "test" });
      expect(r).toMatchObject({ ok: false, to: "STUCK", error: "verification_failed" });
      expect(inst.state().door).toBe("STUCK");
      stuck.setOpened(true);
      await new Promise((r) => setTimeout(r, 500));
      expect(inst.state().door).toBe("OPEN");
    } finally {
      await inst.stop();
      await stuck.close();
    }
  });

  it("marks UNKNOWN after repeated console failures and refuses commands", async () => {
    const inst = new Instance(cfg({ poll: { movingMs: 50, idleMs: 50 } }), silentLogger, "live", { storeFile: ":memory:", transports: [] });
    await inst.start();
    try {
      protect.state.failNext = 1000;
      // polls are throttled by the 8 req/s console gate, so three failures take up to ~1.5 s
      await new Promise((r) => setTimeout(r, 1600));
      expect(inst.state().door).toBe("UNKNOWN");
      expect(inst.state().connectionOk).toBe(false);
      await expect(inst.door.open({ source: "test" })).rejects.toMatchObject({ code: "protect_unavailable" });
      protect.state.failNext = 0;
      await new Promise((r) => setTimeout(r, 1200));
      expect(inst.state().connectionOk).toBe(true);
      expect(inst.state().door).not.toBe("UNKNOWN");
    } finally {
      await inst.stop();
    }
  });

  it("rejects a wrong API key and the wrong TLS mode string", async () => {
    const bad = new HttpProtectClient({ baseUrl: protect.url, apiKey: "wrong", tls: "system", logger: silentLogger });
    await expect(bad.getSensors()).rejects.toMatchObject({ status: 401 });
    await bad.close();
    expect(() => new HttpProtectClient({ baseUrl: protect.url, apiKey: "k", tls: "nope", logger: silentLogger })).toThrow();
  });

  it("webhook sensor edges are applied immediately and confirmed by a poll", async () => {
    protect.setOpened(false);
    const inst = new Instance(cfg(), silentLogger, "live", { storeFile: ":memory:", transports: [] });
    await inst.start();
    try {
      protect.setOpened(true);
      inst.bus.emit("protect-event", { type: "opened", device: "6609938d012d0803e408748d", at: Date.now(), source: "webhook" });
      await new Promise((r) => setTimeout(r, 20));
      expect(inst.state().door).toBe("OPEN");
      inst.bus.emit("protect-event", { type: "closed", device: "someone-else", at: Date.now(), source: "webhook" });
      await new Promise((r) => setTimeout(r, 20));
      expect(inst.state().door).toBe("OPEN");
    } finally {
      await inst.stop();
    }
  });
});
