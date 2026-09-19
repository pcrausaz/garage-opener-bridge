import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, makeConfig } from "../../src/config.js";

describe("config", () => {
  it("applies defaults and parses env types", () => {
    const c = loadConfig({ BRIDGE_MODE: "mock", DOOR_TRAVEL_SECONDS: "20", FEATURES_LPR: "true", LPR_KNOWN_PLATES: "abc 123, XYZ-9", BRIDGE_TOKENS: "aaaaaaaa, bbbbbbbb" });
    expect(c.door.travelSeconds).toBe(20);
    expect(c.door.verifyAfterSeconds).toBe(3);
    expect(c.features.lpr).toBe(true);
    expect(c.lpr.knownPlates).toEqual(["abc 123", "XYZ-9"]);
    expect(c.bridge.tokens).toEqual(["aaaaaaaa", "bbbbbbbb"]);
    expect(c.alerts.nightlyTime).toBe("22:00");
    expect(c.relay.pulseMode).toBe("native");
  });

  it("live mode requires console credentials and a token", () => {
    expect(() => loadConfig({ BRIDGE_MODE: "live" })).toThrow(/PROTECT_URL/);
    expect(() => loadConfig({ BRIDGE_MODE: "live", PROTECT_URL: "https://192.168.50.1", PROTECT_API_KEY: "k" })).toThrow(/BRIDGE_TOKENS/);
    expect(() => loadConfig({ BRIDGE_MODE: "live", PROTECT_URL: "https://192.168.50.1", PROTECT_API_KEY: "k", BRIDGE_TOKENS: "short" })).toThrow(/8 characters/);
    expect(loadConfig({ BRIDGE_MODE: "live", PROTECT_URL: "https://192.168.50.1", PROTECT_API_KEY: "k", BRIDGE_TOKENS: "longenough" }).bridge.mode).toBe("live");
  });

  it("rejects bad values", () => {
    expect(() => loadConfig({ BRIDGE_MODE: "mock", PROTECT_TLS: "yolo" })).toThrow();
    expect(() => loadConfig({ BRIDGE_MODE: "mock", ALERT_NIGHTLY_TIME: "25:00" })).toThrow();
    expect(() => loadConfig({ BRIDGE_MODE: "mock", WEBHOOK_SECRET: "short" })).toThrow();
    expect(() => loadConfig({ BRIDGE_MODE: "mock", EVENTS_WEBHOOK_URL: "https://x.example/hook" })).toThrow(/EVENTS_WEBHOOK_SECRET/);
    expect(loadConfig({ BRIDGE_MODE: "mock", PROTECT_TLS: "fingerprint:" + "ab".repeat(32) }).protect.tls).toMatch(/^fingerprint:/);
  });

  it("reads config.yaml and lets env override it", () => {
    const dir = mkdtempSync(join(tmpdir(), "go-cfg-"));
    const file = join(dir, "config.yaml");
    writeFileSync(file, "bridge:\n  mode: mock\ndoor:\n  travelSeconds: 12\n  relayId: r1\nalerts:\n  openTooLongMinutes: 30\n");
    const c = loadConfig({ CONFIG_FILE: file, DOOR_TRAVEL_SECONDS: "7" });
    expect(c.door.travelSeconds).toBe(7);
    expect(c.door.relayId).toBe("r1");
    expect(c.alerts.openTooLongMinutes).toBe(30);
  });

  it("makeConfig builds a mock config without env", () => {
    expect(makeConfig({ bridge: { mode: "mock" } }).bridge.mockTokenPrefix).toBe("demo-");
  });
});
