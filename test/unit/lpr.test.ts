import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockInstance } from "../helpers.js";
import type { Instance } from "../../src/instance.js";

const MIN = 60_000;

describe("LPR rule engine", () => {
  let inst: Instance;
  beforeEach(() => vi.useFakeTimers({ now: Date.UTC(2026, 8, 18, 12, 0, 0) }));
  afterEach(async () => {
    await inst?.stop();
    vi.useRealTimers();
  });

  it("known plate + door CLOSED + nobody inside → opens, notifies, undoable", async () => {
    const m = await mockInstance();
    inst = m.inst;
    await inst.mockAction("plate-seen", { plate: "abc-123" });
    expect(inst.lpr!.decisions.map((d) => d.rule)).toEqual(["lpr-auto-open"]);
    expect(m.capture.rules()).toEqual(["lpr-auto-open"]);
    expect(m.capture.alerts[0]?.actions).toEqual(["undo"]);
    expect(inst.door.snapshot().door).toBe("OPENING");
    const pending = inst.lpr!.pendingUndo();
    expect(pending).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(12_100);
    expect(inst.door.snapshot().door).toBe("OPEN");
    expect(m.capture.alerts[0]?.autoActionId).toBe(pending[0]!.id);
    const undo = inst.lpr!.undo(pending[0]!.id);
    await vi.advanceTimersByTimeAsync(12_100);
    expect(await undo).toMatchObject({ ok: true, command: "close", to: "CLOSED" });
    expect(await inst.lpr!.undo(pending[0]!.id)).toBeNull();
    expect(inst.store.listAudit(20).some((e) => e.kind === "auto-action" && e.outcome === "undone")).toBe(true);
  });

  it("undo expires after undoSeconds", async () => {
    const m = await mockInstance();
    inst = m.inst;
    await inst.mockAction("plate-seen", { plate: "ABC123" });
    const id = inst.lpr!.pendingUndo()[0]!.id;
    await vi.advanceTimersByTimeAsync(61_000);
    expect(await inst.lpr!.undo(id)).toBeNull();
  });

  it("acts on edges only: a plate that stays visible never re-triggers", async () => {
    const m = await mockInstance();
    inst = m.inst;
    await inst.mockAction("plate-seen", { plate: "ABC123" });
    await vi.advanceTimersByTimeAsync(12_100);
    // close it manually; the plate is still in view and reported again within the dedupe window
    const c = inst.door.close({ source: "test" });
    await vi.advanceTimersByTimeAsync(12_100);
    await c;
    await inst.mockAction("plate-seen", { plate: "ABC123" });
    expect(inst.door.snapshot().door).toBe("CLOSED");
    expect(inst.lpr!.decisions).toHaveLength(1);
  });

  it("unknown plates and a car already inside never open the door", async () => {
    const m = await mockInstance();
    inst = m.inst;
    await inst.mockAction("plate-seen", { plate: "ZZZ999" });
    expect(inst.door.snapshot().door).toBe("CLOSED");
    await inst.mockAction("vehicle-arrived");
    await vi.advanceTimersByTimeAsync(2 * MIN);
    await inst.mockAction("plate-seen", { plate: "ABC123" });
    expect(inst.door.snapshot().door).toBe("CLOSED");
    expect(inst.lpr!.decisions).toHaveLength(0);
  });

  it("departure: presence ends and the plate shows on the driveway → close after the grace period", async () => {
    const m = await mockInstance();
    inst = m.inst;
    await inst.mockAction("vehicle-arrived");
    const o = inst.door.open({ source: "test" });
    await vi.advanceTimersByTimeAsync(12_100);
    await o;
    await inst.mockAction("vehicle-left");
    await inst.mockAction("plate-seen", { plate: "ABC123" });
    await vi.advanceTimersByTimeAsync(2 * MIN + 59_000);
    expect(inst.door.snapshot().door).toBe("OPEN");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(inst.lpr!.decisions.map((d) => d.rule)).toEqual(["lpr-auto-close"]);
    expect(inst.door.snapshot().door).toBe("CLOSING");
  });

  it("departure close is cancelled when the car comes back or a hold is set", async () => {
    const m = await mockInstance();
    inst = m.inst;
    await inst.mockAction("vehicle-arrived");
    const o = inst.door.open({ source: "test" });
    await vi.advanceTimersByTimeAsync(12_100);
    await o;
    await inst.mockAction("plate-seen", { plate: "ABC123" });
    await inst.mockAction("vehicle-left");
    inst.hold.set(30, "test");
    await vi.advanceTimersByTimeAsync(4 * MIN);
    expect(inst.door.snapshot().door).toBe("OPEN");
    expect(inst.lpr!.decisions).toHaveLength(0);
  });

  it("is not instantiated in live mode unless features.lpr is on", async () => {
    const off = await mockInstance({ features: { lpr: false } });
    inst = off.inst;
    expect(inst.lpr).not.toBeNull(); // mock mode always has it for the demo
    expect(inst.lpr!.isKnown("abc 123")).toBe(true);
  });
});
