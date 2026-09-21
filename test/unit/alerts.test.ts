import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockInstance } from "../helpers.js";
import type { Instance } from "../../src/instance.js";

const MIN = 60_000;

describe("alert engine (mock instance, fake timers)", () => {
  let inst: Instance;
  beforeEach(() => {
    vi.useFakeTimers({ now: Date.UTC(2026, 8, 18, 12, 0, 0) });
  });
  afterEach(async () => {
    await inst?.stop();
    vi.useRealTimers();
  });

  async function openDoor(i: Instance) {
    const p = i.door.open({ source: "test" });
    await vi.advanceTimersByTimeAsync(12_000 + 10);
    const r = await p;
    expect(r).toMatchObject({ ok: true, to: "OPEN" });
  }

  it("rule 1: door open longer than N minutes → alert with actions", async () => {
    const m = await mockInstance({}, { nativePulse: true });
    inst = m.inst;
    await openDoor(inst);
    await vi.advanceTimersByTimeAsync(14 * MIN);
    expect(m.capture.alerts).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1 * MIN + 100);
    expect(m.capture.rules()).toEqual(["open-too-long"]);
    expect(m.capture.alerts[0]?.actions).toEqual(["close-now", "hold-2h", "ignore"]);
    // closing resets; reopening starts a new episode
    const c = inst.door.close({ source: "test" });
    await vi.advanceTimersByTimeAsync(12_100);
    await c;
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(m.capture.alerts).toHaveLength(1);
  });

  it("hold-open suppresses rule 1 and re-arms after the hold expires", async () => {
    const m = await mockInstance({}, { nativePulse: true });
    inst = m.inst;
    await openDoor(inst);
    inst.hold.set(30, "test");
    await vi.advanceTimersByTimeAsync(29 * MIN);
    expect(m.capture.alerts).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1 * MIN + 100); // hold expires → 15 min timer re-armed
    await vi.advanceTimersByTimeAsync(14 * MIN);
    expect(m.capture.alerts).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1 * MIN + 100);
    expect(m.capture.rules()).toEqual(["open-too-long"]);
  });

  it("rule 2: nightly check notifies when open, is silent when closed or held, and can auto-close", async () => {
    const m = await mockInstance({}, { nativePulse: true });
    inst = m.inst;
    await inst.alerts.runNightly();
    expect(m.capture.alerts).toHaveLength(0);
    await openDoor(inst);
    await inst.alerts.runNightly();
    expect(m.capture.rules()).toEqual(["nightly-check"]);
    inst.hold.set(60, "test");
    await inst.alerts.runNightly();
    expect(m.capture.alerts).toHaveLength(1);
    await inst.stop();

    const a = await mockInstance({ alerts: { nightlyAutoclose: true } }, { nativePulse: true });
    inst = a.inst;
    await openDoor(inst);
    await inst.alerts.runNightly();
    expect(a.capture.alerts[0]?.actions).toContain("undo");
    expect(inst.door.snapshot().door).toBe("CLOSING");
    await vi.advanceTimersByTimeAsync(12_100);
    expect(inst.door.snapshot().door).toBe("CLOSED");
  });

  it("rule 1 arms for a door stopped part-way, but never offers a close that would open it (ADR-0015)", async () => {
    const m = await mockInstance({}, { nativePulse: true });
    inst = m.inst;
    // Stop the door on the way down: from here one press opens it again.
    await openDoor(inst);
    void inst.door.close({ source: "test" });
    await vi.advanceTimersByTimeAsync(2_000);
    await inst.door.stopDoor({ source: "test" });
    expect(inst.door.snapshot().door).toBe("STOPPED");
    expect(inst.door.snapshot().nextPress).toBe("open");

    await vi.advanceTimersByTimeAsync(15 * MIN + 100);
    expect(m.capture.rules()).toEqual(["open-too-long"]);
    expect(m.capture.alerts[0]?.actions).toEqual(["hold-2h", "ignore"]);
  });

  it("rule 2: a door stopped part-way is reported, never auto-closed", async () => {
    const m = await mockInstance({ alerts: { nightlyAutoclose: true } }, { nativePulse: true });
    inst = m.inst;
    await openDoor(inst);
    void inst.door.close({ source: "test" });
    await vi.advanceTimersByTimeAsync(2_000);
    await inst.door.stopDoor({ source: "test" });

    await inst.alerts.runNightly();
    expect(m.capture.rules()).toEqual(["nightly-check"]);
    // The press an auto-close would send opens this door, so the rule notifies and leaves it alone.
    expect(m.capture.alerts[0]?.actions).not.toContain("undo");
    await vi.advanceTimersByTimeAsync(12_100);
    expect(inst.door.snapshot().door).toBe("STOPPED");
  });

  it("rule 2 fires from the scheduler at 22:00 local time", async () => {
    const m = await mockInstance({ tz: "UTC" }, { nativePulse: true });
    inst = m.inst;
    await openDoor(inst);
    await vi.advanceTimersByTimeAsync(9 * 60 * MIN + 59 * MIN); // 21:59
    const before = m.capture.rules().filter((r) => r === "nightly-check").length;
    expect(before).toBe(0);
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(m.capture.rules()).toContain("nightly-check");
  });

  it("rule 3: car inside + door open > M minutes, and car left + door open > M minutes", async () => {
    const m = await mockInstance({}, { nativePulse: true });
    inst = m.inst;
    await openDoor(inst);
    await inst.mockAction("vehicle-arrived");
    await vi.advanceTimersByTimeAsync(5 * MIN + 100);
    expect(m.capture.rules()).toContain("vehicle-inside-door-open");
    await inst.mockAction("vehicle-left");
    await vi.advanceTimersByTimeAsync(5 * MIN + 100);
    expect(m.capture.rules()).toContain("vehicle-left-door-open");
  });

  it("rule 3 respects the hold flag", async () => {
    const m = await mockInstance({}, { nativePulse: true });
    inst = m.inst;
    await openDoor(inst);
    inst.hold.set(120, "test");
    await inst.mockAction("vehicle-arrived");
    await vi.advanceTimersByTimeAsync(6 * MIN);
    expect(m.capture.alerts).toHaveLength(0);
  });

  it("vehicle presence uses the grace period for detection-ended events", async () => {
    const m = await mockInstance({}, { nativePulse: true });
    inst = m.inst;
    inst.vehicle.detectionStarted();
    expect(inst.vehicle.isPresent()).toBe(true);
    inst.vehicle.detectionEnded();
    await vi.advanceTimersByTimeAsync(119_000);
    expect(inst.vehicle.isPresent()).toBe(true);
    inst.vehicle.detectionStarted(); // new detection cancels the pending end
    await vi.advanceTimersByTimeAsync(5_000);
    expect(inst.vehicle.isPresent()).toBe(true);
    inst.vehicle.detectionEnded();
    await vi.advanceTimersByTimeAsync(121_000);
    expect(inst.vehicle.isPresent()).toBe(false);
  });
});
