import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pino from "pino";
import { startMockProtect } from "../protect-mock-server.js";
import { Instance } from "../../src/instance.js";
import { makeConfig } from "../../src/config.js";
import { ContractValidator } from "../../src/http/validation.js";

const until = async (pred: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  return pred();
};

describe("relay record refresh and stuck-output handling (fixture mock Protect)", () => {
  let protect: Awaited<ReturnType<typeof startMockProtect>>;
  let inst: Instance;
  const warnLines: string[] = [];
  const logger = pino({ level: "warn" }, { write: (s: string) => void warnLines.push(s) });
  const v = new ContractValidator();

  beforeAll(async () => {
    // native mode on a truly pulsing relay: a held-on output is a fault and commands are refused
    protect = await startMockProtect({ travelMs: 100, relayBehaviour: "pulse" });
    const cfg = makeConfig({
      bridge: { mode: "live", tokens: ["live-token-0123456789abcdef"] },
      protect: { url: protect.url, apiKey: protect.apiKey, tls: "system" },
      door: { travelSeconds: 1, verifyAfterSeconds: 0 },
      poll: { movingMs: 100, idleMs: 100 },
      relay: { pulseMode: "native" },
    });
    inst = new Instance(cfg, logger, "live", { storeFile: ":memory:", transports: [] });
    await inst.start();
  });
  afterAll(async () => {
    await inst.stop();
    await protect.close();
  });

  it("pulseDurationMs and connected follow the console's relay record", async () => {
    expect(inst.state().relay).toMatchObject({ pulseDurationMs: 100, connected: true, outputStuck: false });
    protect.setRelayOutput({ pulseDuration: 1000 });
    expect(await until(() => inst.state().relay.pulseDurationMs === 1000)).toBe(true);
    protect.setRelayOutput({}, { state: "DISCONNECTED" });
    expect(await until(() => inst.state().relay.connected === false)).toBe(true);
    protect.setRelayOutput({ pulseDuration: 100 }, { state: "CONNECTED" });
    expect(await until(() => inst.state().relay.connected && inst.state().relay.pulseDurationMs === 100)).toBe(true);
    expect(v.validate("State", inst.state())).toEqual({ ok: true });
  });

  it("output held on → outputStuck + healthz warning + command refused without activating; released → cleared and command proceeds", async () => {
    protect.state.activations.length = 0;
    protect.setRelayOutput({ state: "on" });
    await new Promise((r) => setTimeout(r, 1500));
    expect(inst.state().relay.outputStuck).toBe(false); // below the 3 s threshold
    expect(await until(() => inst.state().relay.outputStuck === true, 4000)).toBe(true);
    const h = inst.health();
    expect(h.warnings).toEqual(["relay_output_stuck"]);
    expect(v.validate("Health", h)).toEqual({ ok: true });
    expect(v.validate("State", inst.state())).toEqual({ ok: true });
    expect(warnLines.filter((l) => l.includes("relay output stuck")).length).toBe(1);

    const refused = await inst.door.open({ source: "test" });
    expect(refused).toMatchObject({ ok: false, pulsed: false, verified: false, error: "relay_output_stuck", from: "CLOSED", to: "CLOSED" });
    expect(v.validate("CommandResult", refused)).toEqual({ ok: true });
    expect(protect.state.activations).toHaveLength(0);
    expect(inst.state().door).toBe("CLOSED"); // sensor stays the only truth
    expect(inst.store.listAudit(1)[0]).toMatchObject({ kind: "command", command: "open", outcome: "failed", detail: expect.stringContaining("relay_output_stuck") });

    await new Promise((r) => setTimeout(r, 1000));
    expect(warnLines.filter((l) => l.includes("relay output stuck")).length).toBe(1); // once per episode

    protect.setRelayOutput({ state: "off" });
    expect(await until(() => !inst.state().relay.outputStuck)).toBe(true);
    expect(inst.health().warnings).toBeUndefined();
    const ok = await inst.door.open({ source: "test" });
    expect(ok).toMatchObject({ ok: true, pulsed: true, to: "OPEN" });
    expect(protect.state.activations).toHaveLength(1);
  });
});
