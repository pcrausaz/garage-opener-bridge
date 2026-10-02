import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import { mockInstance } from "../helpers.js";
import { Instance, type DoorUnit } from "../../src/instance.js";
import { makeConfig, type ConfigInput } from "../../src/config.js";
import { ProtectSimulator, SIM_IDS, SIM_IDS_2 } from "../../src/protect/simulator.js";
import { silentLogger } from "../../src/logger.js";

const MIN = 60_000;
const TRAVEL = 12_100; // travel 10 s + verify 2 s (test/helpers.ts)

/** Two doors on the simulator: the only place a second door can be exercised (there is one real sensor). */
describe("two doors, one bridge (ADR-0020)", () => {
  let inst: Instance;
  let d1: DoorUnit;
  let d2: DoorUnit;
  let capture: Awaited<ReturnType<typeof mockInstance>>["capture"];

  const boot = async (over: ConfigInput = {}) => {
    const m = await mockInstance({ ...over, bridge: { mockDoors: 2, ...(over.bridge ?? {}) } }, { nativePulse: true });
    inst = m.inst;
    capture = m.capture;
    [d1, d2] = inst.units as [DoorUnit, DoorUnit];
  };
  const open = async (u: DoorUnit) => {
    const p = u.door.open({ source: "test" });
    await vi.advanceTimersByTimeAsync(TRAVEL);
    expect(await p).toMatchObject({ ok: true, to: "OPEN" });
  };
  const doors = () => inst.units.map((u) => u.door.snapshot().door);

  beforeEach(() => vi.useFakeTimers({ now: Date.UTC(2026, 9, 2, 12, 0, 0) }));
  afterEach(async () => {
    await inst?.stop();
    vi.useRealTimers();
  });

  it("ids are d1, d2 by position; names default to the relay outputs'; both doors may share a camera", async () => {
    await boot();
    expect(inst.doorList()).toEqual([
      { id: "d1", name: "Left Door", hasCamera: true, mapping: { ...SIM_IDS } },
      { id: "d2", name: "Right Door", hasCamera: true, mapping: { ...SIM_IDS_2 } },
    ]);
    expect(inst.door).toBe(d1.door); // the instance's own door is still the first one
    expect(inst.unit("d2")).toBe(d2);
    expect(inst.unit("d3")).toBeUndefined();
  });

  it("DOOR_NAME / DOOR2_NAME name the doors", async () => {
    await boot({ door: { name: "Pascal" }, door2: { name: "Margo" } });
    expect(inst.doorList().map((d) => d.name)).toEqual(["Pascal", "Margo"]);
  });

  it("each door has its own state machine: one moves, the other neither moves nor is busy", async () => {
    await boot();
    const opening = d2.door.open({ source: "test" });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(doors()).toEqual(["CLOSED", "OPENING"]);
    expect([d1.door.snapshot().nextPress, d2.door.snapshot().nextPress]).toEqual(["open", "stop"]);
    // d1 is free while d2 travels; with one shared machine this would be 409 door_busy.
    const other = d1.door.open({ source: "test" });
    await vi.advanceTimersByTimeAsync(TRAVEL);
    expect(await opening).toMatchObject({ ok: true, to: "OPEN" });
    expect(await other).toMatchObject({ ok: true, to: "OPEN" });
    expect(inst.sim!.doors.map((d) => d.activations)).toEqual([1, 1]);
    expect(inst.stateOf(d2).relay).toMatchObject({ outputId: 1, name: "Right Door" });
    expect(inst.stateOf(d2).sensor.id).toBe(SIM_IDS_2.sensorId);
  });

  it("stop memory is per door", async () => {
    await boot();
    await open(d1);
    await open(d2);
    void d2.door.close({ source: "test" });
    await vi.advanceTimersByTimeAsync(2_000);
    await d2.door.stopDoor({ source: "test" });
    expect(doors()).toEqual(["OPEN", "STOPPED"]);
    expect([d1.door.snapshot().nextPress, d2.door.snapshot().nextPress]).toEqual(["close", "open"]);
    await expect(d2.door.close({ source: "test" })).rejects.toMatchObject({ code: "door_direction" });
    const closing = d1.door.close({ source: "test" });
    await vi.advanceTimersByTimeAsync(TRAVEL);
    expect(await closing).toMatchObject({ ok: true, to: "CLOSED" });
    expect(d2.door.snapshot().door).toBe("STOPPED");
  });

  it("verification is per door: one door STUCK leaves the other alone", async () => {
    await boot();
    await open(d1);
    await open(d2);
    await inst.mockAction("reverse-next-close", {}, d2, true);
    expect(inst.sim!.doors.map((d) => d.reverseNextClose)).toEqual([false, true]);
    const a = d1.door.close({ source: "test" });
    const b = d2.door.close({ source: "test" });
    await vi.advanceTimersByTimeAsync(TRAVEL);
    expect(await a).toMatchObject({ ok: true, to: "CLOSED" });
    expect(await b).toMatchObject({ ok: false, to: "STUCK", error: "verification_failed" });
  });

  it("hold-open and the alert rules are per door, and alerts say which door", async () => {
    await boot();
    await open(d1);
    await open(d2);
    d2.hold.set(60, "test");
    expect([d1.hold.isActive(), d2.hold.isActive()]).toEqual([false, true]);
    expect(inst.stateOf(d1).hold).toEqual({ active: false });
    expect(inst.stateOf(d2).hold).toMatchObject({ active: true, minutes: 60 });
    // d1 keeps the storage key every install already has.
    expect(inst.store.get("hold")).toBeNull();
    expect(inst.store.get("hold:d2")).not.toBeNull();

    await vi.advanceTimersByTimeAsync(15 * MIN + 100);
    expect(capture.alerts.map((a) => [a.rule, a.doorId, a.title])).toEqual([["open-too-long", "d1", "Left Door: Garage door still open"]]);
    expect([d1.alerts.fired.length, d2.alerts.fired.length]).toEqual([1, 0]);

    // The nightly check runs for each door.
    d2.hold.clear("test");
    await d1.alerts.runNightly();
    await d2.alerts.runNightly();
    expect(capture.alerts.slice(1).map((a) => [a.rule, a.doorId, a.title])).toEqual([
      ["nightly-check", "d1", "Left Door: Garage door is open tonight"],
      ["nightly-check", "d2", "Right Door: Garage door is open tonight"],
    ]);
  });

  it("vehicle presence is per door; the simulator's vehicle controls act on one door", async () => {
    await boot();
    await open(d1);
    await open(d2);
    await inst.mockAction("vehicle-arrived", {}, d2, true);
    expect([d1.vehicle.isPresent(), d2.vehicle.isPresent()]).toEqual([false, true]);
    await vi.advanceTimersByTimeAsync(5 * MIN + 100);
    expect(capture.alerts.map((a) => [a.rule, a.doorId])).toEqual([["vehicle-inside-door-open", "d2"]]);
    await inst.mockAction("vehicle-left", {}, d2, true);
    expect(d2.vehicle.isPresent()).toBe(false);
  });

  describe("Alarm Manager events are routed by the device they carry", () => {
    const event = (type: "opened" | "closed" | "vehicle-start" | "vehicle-end", device?: string) => inst.onProtectEvent({ type, ...(device ? { device } : {}), at: Date.now(), source: "webhook" });

    it("a sensor edge reaches only the door that sensor watches", async () => {
      await boot();
      await event("opened", SIM_IDS_2.sensorId);
      expect(doors()).toEqual(["CLOSED", "OPEN"]);
      expect(inst.store.listAudit(1)[0]).toMatchObject({ kind: "webhook", detail: `opened ${SIM_IDS_2.sensorId}`, doorId: "d2" });
      await event("opened", SIM_IDS.sensorId);
      expect(doors()).toEqual(["OPEN", "OPEN"]);
      await event("closed", "someone-else");
      expect(doors()).toEqual(["OPEN", "OPEN"]);
    });

    it("a camera shared by two doors feeds both", async () => {
      await boot();
      await event("vehicle-start", SIM_IDS.interiorCameraId);
      expect([d1.vehicle.isPresent(), d2.vehicle.isPresent()]).toEqual([true, true]);
      expect(inst.store.listAudit(1)[0]!.doorId).toBeUndefined(); // about both doors, so about neither
    });

    it("an event that names no device moves no door; the console is asked instead", async () => {
      await boot();
      const reads = vi.spyOn(inst.sim!, "getSensor");
      await event("opened");
      expect(doors()).toEqual(["CLOSED", "CLOSED"]);
      expect(reads.mock.calls.map((c) => c[0]).sort()).toEqual([SIM_IDS.sensorId, SIM_IDS_2.sensorId]);
      await event("vehicle-start");
      expect([d1.vehicle.isPresent(), d2.vehicle.isPresent()]).toEqual([false, false]);
    });
  });

  it("a known plate tied to a door opens that door; an untied plate means d1", async () => {
    await boot({ lpr: { knownPlates: ["DEMO123", "TWO-222:d2"] } });
    expect([d1.lpr!.isKnown("TWO222"), d2.lpr!.isKnown("TWO222"), d2.lpr!.isKnown("DEMO123")]).toEqual([false, true, false]);
    await inst.mockAction("plate-seen", { plate: "two 222" });
    expect(doors()).toEqual(["CLOSED", "OPENING"]);
    expect(capture.alerts.map((a) => [a.rule, a.doorId, a.title])).toEqual([["lpr-auto-open", "d2", "Right Door: Opening the garage"]]);
    await vi.advanceTimersByTimeAsync(TRAVEL);

    // Undo finds the action whichever door it was for.
    const action = d2.lpr!.pendingUndo()[0]!;
    expect(action.doorId).toBe("d2");
    const undo = inst.undo(action.id);
    await vi.advanceTimersByTimeAsync(TRAVEL);
    expect(await undo).toMatchObject({ ok: true, command: "close", to: "CLOSED" });
    expect(await inst.undo("nope")).toBeNull();

    await inst.mockAction("plate-seen", { plate: "DEMO123" });
    expect(doors()).toEqual(["OPENING", "CLOSED"]);
  });

  it("audit rows say which door", async () => {
    await boot();
    await open(d2);
    d2.hold.set(5, "test");
    await d1.door.open({ source: "test", wait: false });
    const rows = inst.store.listAudit(10).map((e) => [e.kind, e.command ?? e.detail, e.doorId]);
    expect(rows).toEqual([["command", "open", "d1"], ["hold", "5 min", "d2"], ["command", "open", "d2"]]);
  });

  it("mock reset: one door when told which, the whole simulator otherwise", async () => {
    await boot();
    await open(d1);
    await open(d2);
    d1.hold.set(5, "test");
    expect(await inst.mockAction("reset", {}, d2, true)).toMatchObject({ door: "CLOSED", relay: { outputId: 1 } });
    expect(doors()).toEqual(["OPEN", "CLOSED"]);
    expect(d1.hold.isActive()).toBe(true);
    await inst.mockAction("reset");
    expect(doors()).toEqual(["CLOSED", "CLOSED"]);
    expect(d1.hold.isActive()).toBe(false);
  });

  it("a door's own travel time is reported in its state", async () => {
    await boot({ door2: { travelSeconds: 20 } });
    expect([inst.stateOf(d1).travelSeconds, inst.stateOf(d2).travelSeconds]).toEqual([10, 20]);
  });

  it("/healthz content is unchanged: one warning however many doors are stuck", async () => {
    await boot();
    expect(Object.keys(inst.health()).sort()).toEqual(["mode", "ok", "protect", "ready", "version"]);
  });
});

describe("one door, as before", () => {
  let inst: Instance;
  beforeEach(() => vi.useFakeTimers({ now: Date.UTC(2026, 9, 2, 12, 0, 0) }));
  afterEach(async () => {
    await inst?.stop();
    vi.useRealTimers();
  });

  it("is a list of one, and its alerts do not name the door", async () => {
    const m = await mockInstance({}, { nativePulse: true });
    inst = m.inst;
    expect(inst.doorList()).toEqual([{ id: "d1", name: "Garage Door", hasCamera: true, mapping: { ...SIM_IDS } }]);
    const p = inst.door.open({ source: "test" });
    await vi.advanceTimersByTimeAsync(TRAVEL);
    await p;
    await vi.advanceTimersByTimeAsync(15 * MIN + 100);
    expect(m.capture.alerts.map((a) => [a.title, a.doorId])).toEqual([["Garage door still open", "d1"]]);
    // An event that names no device can only be about the one door.
    await inst.onProtectEvent({ type: "closed", at: Date.now(), source: "webhook" });
    expect(inst.door.snapshot().door).toBe("CLOSED");
  });
});

/** Live mode against a two-door console: only what is written down counts. */
describe("configuring a second door", () => {
  const STRONG = "0123456789abcdef0123456789abcdef";
  let inst: Instance | undefined;
  const lines: Record<string, unknown>[] = [];
  const logger = pino({ level: "info" }, { write: (s: string) => void lines.push(JSON.parse(s)) });
  const live = (over: ConfigInput = {}) =>
    new Instance(makeConfig({ bridge: { mode: "live", tokens: [STRONG] }, protect: { url: "https://192.168.1.1", apiKey: "k" }, ...over }), logger, "live", {
      protect: new ProtectSimulator({ doors: 2 }),
      storeFile: ":memory:",
      transports: [],
    });
  const d1 = { relayId: SIM_IDS.relayId, outputId: 0, sensorId: SIM_IDS.sensorId };
  const d2 = { relayId: SIM_IDS_2.relayId, outputId: 1, sensorId: SIM_IDS_2.sensorId };
  afterEach(async () => {
    await inst?.stop();
    inst = undefined;
    lines.length = 0;
  });

  it("never pairs two outputs with two sensors by itself: it refuses to start and logs the suggestion", async () => {
    inst = live();
    await expect(inst.start()).rejects.toThrow(/no door mapping/);
    expect(inst.ready).toBe(false);
    const hint = lines.find((l) => String(l.msg).includes("never paired automatically"))!;
    expect(hint.level).toBe(40);
    expect(hint.suggested).toEqual([
      `DOOR_RELAY_ID=${SIM_IDS.relayId}`, "DOOR_OUTPUT_ID=0", `DOOR_SENSOR_ID=${SIM_IDS.sensorId}`,
      `DOOR2_RELAY_ID=${SIM_IDS.relayId}`, "DOOR2_OUTPUT_ID=1", `DOOR2_SENSOR_ID=${SIM_IDS_2.sensorId}`,
    ]);
    // A retry does not repeat it.
    await expect(inst.start()).rejects.toThrow(/no door mapping/);
    expect(lines.filter((l) => String(l.msg).includes("never paired automatically"))).toHaveLength(1);
  });

  it("DOOR_* and DOOR2_* written down: two doors, the second with no camera unless one is named", async () => {
    inst = live({ door: d1, door2: { ...d2, name: "Right" } });
    await inst.start();
    expect(inst.doorList()).toEqual([
      { id: "d1", name: "Left Door", hasCamera: false, mapping: { ...d1, interiorCameraId: null, drivewayCameraId: null } },
      { id: "d2", name: "Right", hasCamera: false, mapping: { ...d2, interiorCameraId: null, drivewayCameraId: null } },
    ]);
    expect(inst.store.get("mapping")).toMatchObject(d1); // only d1 is ever saved, under the key 0.5 used
    expect(lines.some((l) => String(l.msg).includes("never paired automatically"))).toBe(false);
  });

  it("an install paired on 0.5 keeps its saved d1 and gains d2 from DOOR2_*", async () => {
    inst = live({ door2: { ...d2, interiorCameraId: SIM_IDS.interiorCameraId } });
    inst.store.set("mapping", { ...d1, interiorCameraId: SIM_IDS.interiorCameraId, drivewayCameraId: null });
    await inst.start();
    expect(inst.units.map((u) => [u.id, u.mapping.sensorId, u.mapping.interiorCameraId])).toEqual([
      ["d1", SIM_IDS.sensorId, SIM_IDS.interiorCameraId],
      ["d2", SIM_IDS_2.sensorId, SIM_IDS.interiorCameraId],
    ]);
  });

  it("refuses a second door that turns out to be the first one's sensor or output", async () => {
    inst = live({ door2: { relayId: SIM_IDS.relayId, outputId: 1, sensorId: SIM_IDS.sensorId } });
    inst.store.set("mapping", { ...d1, interiorCameraId: null, drivewayCameraId: null });
    await expect(inst.start()).rejects.toThrow(/d1 and d2 use the same sensor/);
  });

  it("with one door configured, a visible second output and sensor is only mentioned", async () => {
    inst = live({ door: d1 });
    await inst.start();
    expect(inst.units).toHaveLength(1);
    expect(lines.find((l) => String(l.msg).includes("never paired automatically"))!.level).toBe(30);
  });
});
