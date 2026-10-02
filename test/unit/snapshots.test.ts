import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SNAPSHOT_IDLE_MS, SNAPSHOT_MOVING_MS, SnapshotCache, SnapshotError, toSnapshotError } from "../../src/camera/snapshots.js";
import { ProtectError, type ProtectClient, type ProtectSnapshot } from "../../src/protect/types.js";
import { silentLogger } from "../../src/logger.js";
import { mockInstance } from "../helpers.js";
import type { Instance } from "../../src/instance.js";

/** A console that counts snapshot fetches and answers when told to. */
function setup() {
  let now = 1_000_000;
  let moving = false;
  const calls: string[] = [];
  let next: () => Promise<ProtectSnapshot> = async () => ({ contentType: "image/jpeg", body: Buffer.from(`picture-${calls.length}`) });
  const protect = { getCameraSnapshot: (id: string) => (calls.push(id), next()) } as unknown as ProtectClient;
  const cache = new SnapshotCache({ protect, isMoving: () => moving, logger: silentLogger, now: () => now });
  return { cache, calls, tick: (ms: number) => (now += ms), setMoving: (v: boolean) => (moving = v), answer: (fn: typeof next) => (next = fn), now: () => now };
}

describe("camera snapshot cache (ADR-0021)", () => {
  it("serves one fetch for 10 s while nothing moves, stamped with when it was captured", async () => {
    const s = setup();
    const first = await s.cache.get("cam");
    expect(first).toMatchObject({ contentType: "image/jpeg", at: s.now() });
    s.tick(SNAPSHOT_IDLE_MS - 1);
    expect(await s.cache.get("cam")).toBe(first);
    expect(s.calls).toHaveLength(1);
    s.tick(1);
    const second = await s.cache.get("cam");
    expect(second.body.toString()).toBe("picture-2");
    expect(second.at).toBe(first.at + SNAPSHOT_IDLE_MS);
  });

  it("refreshes every 2 s while a door using the camera is moving", async () => {
    const s = setup();
    await s.cache.get("cam");
    s.setMoving(true);
    s.tick(SNAPSHOT_MOVING_MS - 1);
    await s.cache.get("cam");
    expect(s.calls).toHaveLength(1);
    s.tick(1);
    await s.cache.get("cam");
    expect(s.calls).toHaveLength(2);
  });

  it("is per camera: two doors on one camera share it, two cameras do not", async () => {
    const s = setup();
    await Promise.all([s.cache.get("shared"), s.cache.get("shared"), s.cache.get("other")]);
    expect(s.calls).toEqual(["shared", "other"]);
  });

  it("concurrent requests share one upstream fetch", async () => {
    const s = setup();
    let release!: (v: ProtectSnapshot) => void;
    s.answer(() => new Promise((r) => (release = r)));
    const waiting = [s.cache.get("cam"), s.cache.get("cam"), s.cache.get("cam")];
    expect(s.calls).toHaveLength(1);
    release({ contentType: "image/jpeg", body: Buffer.from("one") });
    const got = await Promise.all(waiting);
    expect(new Set(got).size).toBe(1);
  });

  it("a door state change drops the cached picture, and a fetch already in the air is not kept as fresh", async () => {
    const s = setup();
    await s.cache.get("cam");
    s.cache.invalidate("cam");
    await s.cache.get("cam");
    expect(s.calls).toHaveLength(2);

    let release!: (v: ProtectSnapshot) => void;
    s.tick(SNAPSHOT_IDLE_MS);
    s.answer(() => new Promise((r) => (release = r)));
    const inFlight = s.cache.get("cam");
    s.cache.invalidate("cam"); // the door started moving while the request was out
    release({ contentType: "image/jpeg", body: Buffer.from("before the change") });
    expect((await inFlight).body.toString()).toBe("before the change");
    s.answer(async () => ({ contentType: "image/jpeg", body: Buffer.from("after") }));
    expect((await s.cache.get("cam")).body.toString()).toBe("after");
  });

  it("never serves a stale picture in place of an error", async () => {
    const s = setup();
    await s.cache.get("cam");
    s.tick(SNAPSHOT_IDLE_MS);
    s.answer(async () => {
      throw new ProtectError("Protect GET /cameras/cam/snapshot → 503", 503);
    });
    await expect(s.cache.get("cam")).rejects.toMatchObject({ code: "camera_unavailable", status: 503 });
    // …and the failure is remembered briefly, so several phones do not hammer a dead camera.
    await expect(s.cache.get("cam")).rejects.toBeInstanceOf(SnapshotError);
    expect(s.calls).toHaveLength(2);
    s.tick(SNAPSHOT_MOVING_MS);
    s.answer(async () => ({ contentType: "image/jpeg", body: Buffer.from("back") }));
    expect((await s.cache.get("cam")).body.toString()).toBe("back");
  });

  it("maps console failures to distinct errors", () => {
    expect(toSnapshotError(new ProtectError("x", 401))).toMatchObject({ code: "camera_forbidden", status: 502 });
    expect(toSnapshotError(new ProtectError("x", 403))).toMatchObject({ code: "camera_forbidden", status: 502 });
    expect(toSnapshotError(new ProtectError("x", 429))).toMatchObject({ code: "rate_limited", status: 429 });
    expect(toSnapshotError(new ProtectError("x", 404))).toMatchObject({ code: "camera_unavailable", status: 503 });
    expect(toSnapshotError(new ProtectError("timeout"))).toMatchObject({ code: "camera_unavailable", status: 503 });
    expect(toSnapshotError(new Error("boom"))).toMatchObject({ code: "camera_unavailable", status: 503 });
  });
});

describe("snapshot freshness follows the doors that use the camera", () => {
  let inst: Instance;
  beforeEach(() => vi.useFakeTimers({ now: Date.UTC(2026, 9, 2, 12, 0, 0) }));
  afterEach(async () => {
    await inst?.stop();
    vi.useRealTimers();
  });

  it("2 s while either door on a shared camera is moving, 10 s once both are at rest", async () => {
    inst = (await mockInstance({ bridge: { mockDoors: 2 } }, { nativePulse: true })).inst;
    const [d1, d2] = inst.units;
    const camera = d1!.mapping.interiorCameraId!;
    expect(d2!.mapping.interiorCameraId).toBe(camera);
    const upstream = vi.spyOn(inst.sim!, "getCameraSnapshot");
    const look = () => inst.snapshots.get(camera);

    await look();
    await vi.advanceTimersByTimeAsync(SNAPSHOT_IDLE_MS - 1000);
    await look();
    expect(upstream).toHaveBeenCalledTimes(1);

    // The *other* door starts moving: the picture d1 is looking at shows it too.
    void d2!.door.open({ source: "test", wait: false });
    await vi.advanceTimersByTimeAsync(100);
    await look(); // the door changed state, so the cached picture was dropped
    expect(upstream).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(SNAPSHOT_MOVING_MS - 1);
    await look();
    expect(upstream).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await look();
    expect(upstream).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(12_100); // arrived and verified: one more state change, then calm
    await look();
    const settled = upstream.mock.calls.length;
    await vi.advanceTimersByTimeAsync(SNAPSHOT_IDLE_MS - 1);
    await look();
    expect(upstream).toHaveBeenCalledTimes(settled);
  });
});
