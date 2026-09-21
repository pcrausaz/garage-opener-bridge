import { afterEach, describe, expect, it } from "vitest";
import pino from "pino";
import { startMockProtect } from "../protect-mock-server.js";
import { Instance } from "../../src/instance.js";
import { makeConfig, type ConfigInput } from "../../src/config.js";
import { ProtectSimulator, SIM_IDS } from "../../src/protect/simulator.js";

const until = async (pred: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  return pred();
};

/** The USL-Relay on Protect 7.2.105 toggles its output on every activate (ADR-0010). */
describe("toggle relay semantics", () => {
  let protect: Awaited<ReturnType<typeof startMockProtect>> | null = null;
  let inst: Instance | null = null;
  const infoLines: string[] = [];
  const logger = pino({ level: "info" }, { write: (s: string) => void infoLines.push(s) });

  const boot = async (relay: ConfigInput["relay"]) => {
    protect = await startMockProtect({ travelMs: 100, relayBehaviour: "toggle" });
    const cfg = makeConfig({
      bridge: { mode: "live", tokens: ["live-token-0123456789abcdef"] },
      protect: { url: protect.url, apiKey: protect.apiKey, tls: "system" },
      door: { travelSeconds: 1, verifyAfterSeconds: 0 },
      poll: { movingMs: 100, idleMs: 100 },
      relay,
    });
    inst = new Instance(cfg, logger, "live", { storeFile: ":memory:", transports: [] });
    await inst.start();
    return { protect, inst };
  };
  afterEach(async () => {
    await inst?.stop();
    await protect?.close();
    inst = null;
    protect = null;
    infoLines.length = 0;
  });

  it("emulated mode: exactly on → off, output ends off, door moves, no stuck flag", async () => {
    const { protect, inst } = await boot({ pulseMode: "emulated", pulseMs: 100, releaseMs: 50 });
    const r = await inst.door.open({ source: "test" });
    expect(r).toMatchObject({ ok: true, pulsed: true, to: "OPEN" });
    expect(protect.state.activations).toHaveLength(2);
    expect(protect.state.outputLog).toEqual(["on", "off"]);
    expect(protect.outputState()).toBe("off");
    expect(inst.state().relay.outputStuck).toBe(false);
    expect(inst.health().warnings).toBeUndefined();
    const log = infoLines.map((l) => JSON.parse(l)).find((l) => l.msg === "emulated pulse");
    expect(log.sequence).toEqual(["read=off", "activate(on)", "activate(off)", "read=off"]);
    expect(log.finalOutputState).toBe("off");
  });

  it("emulated mode with the output already on: release + press (3 activates), ends off, door moves", async () => {
    const { protect, inst } = await boot({ pulseMode: "emulated", pulseMs: 100, releaseMs: 50 });
    protect.setRelayOutput({ state: "on" });
    expect(await until(() => inst.state().relay.outputStuck === true, 4500)).toBe(true); // reported…
    const r = await inst.door.open({ source: "test" });
    expect(r).toMatchObject({ ok: true, pulsed: true, to: "OPEN" }); // …but not refused
    expect(protect.state.activations).toHaveLength(3);
    expect(protect.state.outputLog).toEqual(["off", "on", "off"]);
    expect(protect.outputState()).toBe("off");
    const log = infoLines.map((l) => JSON.parse(l)).find((l) => l.msg === "emulated pulse");
    expect(log.sequence).toEqual(["read=on", "activate(release)", "activate(on)", "activate(off)", "read=off"]);
    expect(inst.state().relay.outputStuck).toBe(false);
    expect(await until(() => inst.health().warnings === undefined)).toBe(true);
  });

  it("native mode on a toggle relay: output left on, stuck after the threshold, next command refused with the hint", async () => {
    const { protect, inst } = await boot({ pulseMode: "native" });
    const r = await inst.door.open({ source: "test" });
    expect(r).toMatchObject({ ok: true, to: "OPEN" }); // first press works (off→on edge)
    expect(protect.state.activations).toHaveLength(1);
    expect(protect.outputState()).toBe("on");
    expect(await until(() => inst.state().relay.outputStuck === true, 4500)).toBe(true);
    expect(inst.health().warnings).toEqual(["relay_output_stuck"]);
    const refused = await inst.door.close({ source: "test" });
    expect(refused).toMatchObject({ ok: false, pulsed: false, error: "relay_output_stuck" });
    expect(protect.state.activations).toHaveLength(1);
    expect(inst.store.listAudit(1)[0]?.detail).toBe("relay_output_stuck: output held on after activate; set RELAY_PULSE_MODE=emulated");
  });

  it("simulator models toggle semantics too", async () => {
    const sim = new ProtectSimulator({ travelMs: 50, tiltMs: 10, relayBehaviour: "toggle" });
    await sim.activateOutput(SIM_IDS.relayId, 0);
    expect(sim.outputState).toBe("on");
    expect(sim.phase).toBe("opening");
    await sim.activateOutput(SIM_IDS.relayId, 0);
    expect(sim.outputState).toBe("off");
    expect(sim.phase).toBe("opening"); // off edge is not a press
    expect((await sim.getRelay(SIM_IDS.relayId)).outputs[0]?.state).toBe("off");
    await sim.close();
  });
});
