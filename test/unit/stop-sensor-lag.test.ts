import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Instance } from "../../src/instance.js";
import { mockConfig } from "../helpers.js";
import { silentLogger } from "../../src/logger.js";

/**
 * Regression for #5. The real door's tilt sensor reports its edge 7–9 s into a ~15 s travel
 * (docs/ARCHITECTURE.md §5), so a door stopped on the way up is normally still reading *closed*.
 * Treating that as "the door is on the floor" threw away STOPPED and the direction with it, and the
 * next press then drove the door the wrong way into STUCK.
 */
describe("stop while the sensor edge still lags the press (#5)", () => {
  let inst: Instance;
  beforeEach(() => vi.useFakeTimers({ now: Date.UTC(2026, 8, 21, 12, 0, 0) }));
  afterEach(async () => {
    await inst?.stop();
    vi.useRealTimers();
  });

  /** travel 15 s, verify +3 s, tilt edge at 8 s — the measured behaviour of the real door. */
  async function boot() {
    const cfg = mockConfig({ door: { travelSeconds: 15, verifyAfterSeconds: 3 }, relay: { pulseMode: "native" } });
    inst = new Instance(cfg, silentLogger, "mock", { label: "lag", simulator: { relayBehaviour: "pulse", travelMs: 15_000, tiltMs: 8_000 } });
    await inst.start();
  }

  async function stopOnTheWayUpAt(ms: number) {
    void inst.door.open({ source: "test", wait: false });
    await vi.advanceTimersByTimeAsync(ms);
    await inst.door.stopDoor({ source: "test" });
  }

  it("keeps the door part-way when the contact has not caught up yet", async () => {
    await boot();
    await stopOnTheWayUpAt(4_000);
    const s = inst.door.snapshot();
    expect(s.door).toBe("STOPPED");
    expect(s.isOpened).toBe(false); // the sensor genuinely still reads closed
    expect(s.nextPress).toBe("close"); // stopped going up → one press sends it back down
  });

  it("stays part-way when the contact catches up seconds later", async () => {
    await boot();
    await stopOnTheWayUpAt(4_000);
    await vi.advanceTimersByTimeAsync(30_000); // edge arrives, then many idle polls
    const s = inst.door.snapshot();
    expect(s.door).toBe("STOPPED");
    expect(s.nextPress).toBe("close");
  });

  it("the direction the app is offered drives the door down and verifies", async () => {
    await boot();
    await stopOnTheWayUpAt(4_000);
    const p = inst.door.close({ source: "test" });
    await vi.advanceTimersByTimeAsync(19_000);
    expect(await p).toMatchObject({ ok: true, command: "close", from: "STOPPED", to: "CLOSED", verified: true });
  });

  it("refuses the direction the opener will not take, instead of reporting STUCK", async () => {
    await boot();
    await stopOnTheWayUpAt(4_000);
    await expect(inst.door.open({ source: "test" })).rejects.toMatchObject({ code: "door_direction" });
    expect(inst.door.snapshot().door).toBe("STOPPED");
  });

  it("still reports CLOSED when the door really does reach the floor at the wall button", async () => {
    await boot();
    await stopOnTheWayUpAt(4_000);
    await vi.advanceTimersByTimeAsync(20_000); // edge arrives, and an idle poll picks it up
    expect(inst.door.snapshot().isOpened).toBe(true);
    expect(inst.door.snapshot().door).toBe("STOPPED"); // still part-way, just now visible to the sensor
    inst.sim!.pulse(); // someone finishes the travel by hand; from a stop going up that closes it
    await vi.advanceTimersByTimeAsync(40_000); // travel, then the idle poll that sees the closed contact
    expect(inst.door.snapshot().door).toBe("CLOSED");
  });

  it("a stop mid-close is unaffected: the contact reads opened throughout", async () => {
    await boot();
    const o = inst.door.open({ source: "test" });
    await vi.advanceTimersByTimeAsync(19_000);
    await o;
    void inst.door.close({ source: "test", wait: false });
    await vi.advanceTimersByTimeAsync(4_000);
    await inst.door.stopDoor({ source: "test" });
    const s = inst.door.snapshot();
    expect(s.door).toBe("STOPPED");
    expect(s.nextPress).toBe("open");
  });
});
