import { describe, it, expect, vi } from "vitest";
import { printPairingInvite } from "../../src/pairing.js";
import { makeConfig } from "../../src/config.js";
import type { Instance } from "../../src/instance.js";
import type { Logger } from "../../src/logger.js";

const STRONG = "0123456789abcdef0123456789abcdef";
const liveConfig = (over = {}) =>
  makeConfig({ bridge: { mode: "live", tokens: [STRONG] }, protect: { url: "https://192.168.1.1", apiKey: "k" }, publicUrl: "https://garage.example.com", ...over });

function fakeInstance(members: { kind: string }[]) {
  const created: string[] = [];
  return {
    created,
    inst: {
      members: {
        list: () => members,
        createInvite: (by: string) => {
          created.push(by);
          return { code: "ABCDEFGHIJKLMNOP", expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() };
        },
      },
    } as unknown as Instance,
  };
}

const capture = () => {
  const lines: string[] = [];
  return { lines, logger: { info: (m: unknown) => lines.push(String(m)) } as unknown as Logger };
};

describe("first-run pairing banner", () => {
  it("prints a single-use join link while no phone has joined", () => {
    const { inst, created } = fakeInstance([{ kind: "admin" }]);
    const { lines, logger } = capture();
    printPairingInvite(inst, liveConfig(), logger);
    expect(created).toEqual(["first-run"]);
    const out = lines.join("\n");
    expect(out).toContain("garageopener://join?v=1&b=https%3A%2F%2Fgarage.example.com&c=ABCDEFGHIJKLMNOP");
    expect(out).toContain("ABCDEFGHIJKLMNOP");
    // The admin credential must never appear in it: replacing that copy-paste is the whole point.
    expect(out).not.toContain(STRONG);
  });

  it("stops once a phone has joined", () => {
    const { inst, created } = fakeInstance([{ kind: "admin" }, { kind: "member" }]);
    const { lines, logger } = capture();
    printPairingInvite(inst, liveConfig(), logger);
    expect(created).toEqual([]);
    expect(lines).toEqual([]);
  });

  it("can be switched off, and never runs in mock mode", () => {
    const off = fakeInstance([{ kind: "admin" }]);
    const c1 = capture();
    printPairingInvite(off.inst, liveConfig({ pairingBanner: false }), c1.logger);
    expect(c1.lines).toEqual([]);

    const mock = fakeInstance([{ kind: "admin" }]);
    const c2 = capture();
    printPairingInvite(mock.inst, makeConfig({ bridge: { mode: "mock", tokens: ["demo-1"] } }), c2.logger);
    expect(c2.lines).toEqual([]);
  });
});
