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
    expect(c.relay).toEqual({ pulseMode: "emulated", pulseMs: 800, releaseMs: 300 }); // USL-Relay defaults (ADR-0010)
  });

  it("RELAY_PULSE_MODE=native still parses for hardware that truly pulses", () => {
    const c = loadConfig({ BRIDGE_MODE: "mock", RELAY_PULSE_MODE: "native", RELAY_PULSE_MS: "500" });
    expect(c.relay).toEqual({ pulseMode: "native", pulseMs: 500, releaseMs: 300 });
    expect(() => loadConfig({ BRIDGE_MODE: "mock", RELAY_PULSE_MODE: "bogus" })).toThrow();
  });

  it("live mode requires console credentials and a token", () => {
    expect(() => loadConfig({ BRIDGE_MODE: "live" })).toThrow(/PROTECT_URL/);
    expect(() => loadConfig({ BRIDGE_MODE: "live", PROTECT_URL: "https://192.168.50.1", PROTECT_API_KEY: "k" })).toThrow(/BRIDGE_TOKENS/);
    expect(() => loadConfig({ BRIDGE_MODE: "live", PROTECT_URL: "https://192.168.50.1", PROTECT_API_KEY: "k", BRIDGE_TOKENS: "short" })).toThrow(/24 characters/);
    expect(loadConfig({ BRIDGE_MODE: "live", PROTECT_URL: "https://192.168.50.1", PROTECT_API_KEY: "k", BRIDGE_TOKENS: "0123456789abcdef0123456789abcdef" }).bridge.mode).toBe("live");
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

import { normalizeTls } from "../../src/config.js";

describe("PROTECT_TLS normalisation", () => {
  const hex = "618ac07b24c6596f6fa3186d4ccadabdd990dee4e3099a659af7e5dbf5da9506";
  it("accepts the documented forms and common copy-paste variants", () => {
    expect(normalizeTls("insecure")).toBe("insecure");
    expect(normalizeTls("system")).toBe("system");
    expect(normalizeTls("insecure               # switch to fingerprint:<sha256> after capture")).toBe("insecure");
    expect(normalizeTls('"insecure"')).toBe("insecure");
    expect(normalizeTls(`fingerprint:${hex}`)).toBe(`fingerprint:${hex}`);
    expect(normalizeTls(`fingerprint:${hex.toUpperCase()}`)).toBe(`fingerprint:${hex}`);
    expect(normalizeTls("fingerprint:61:8A:C0:7B:24:C6:59:6F:6F:A3:18:6D:4C:CA:DA:BD:D9:90:DE:E4:E3:09:9A:65:9A:F7:E5:DB:F5:DA:95:06")).toBe(`fingerprint:${hex}`);
    expect(normalizeTls(`sha256:${hex}`)).toBe(`fingerprint:${hex}`);
    expect(normalizeTls(`fingerprint:sha256:${hex}`)).toBe(`fingerprint:${hex}`);
    expect(normalizeTls("SHA256 Fingerprint=61:8A:C0:7B:24:C6:59:6F:6F:A3:18:6D:4C:CA:DA:BD:D9:90:DE:E4:E3:09:9A:65:9A:F7:E5:DB:F5:DA:95:06")).toBe(`fingerprint:${hex}`);
  });
  it("rejects garbage with a message naming the env var and value", () => {
    expect(() => loadConfig({ BRIDGE_MODE: "mock", PROTECT_TLS: "fingerprint:abc" } as NodeJS.ProcessEnv)).toThrow(/PROTECT_TLS must be .*\(got "fingerprint:abc"\)/);
  });
  it("redacts secrets in config errors", () => {
    expect(() => loadConfig({ BRIDGE_MODE: "live", PROTECT_URL: "not a url", PROTECT_API_KEY: "supersecretvalue", BRIDGE_TOKENS: "t" } as NodeJS.ProcessEnv)).not.toThrow(/supersecretvalue/);
  });
});
