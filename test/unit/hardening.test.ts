import { describe, it, expect } from "vitest";
import { loadConfig, makeConfig, assertStrongToken, isLanHost } from "../../src/config.js";
import { auditToCsv } from "../../src/store/db.js";
import { buildServer } from "../../src/http/server.js";
import { MockRegistry } from "../../src/mock/registry.js";
import { silentLogger } from "../../src/logger.js";
import { mockConfig } from "../helpers.js";

const STRONG = "0123456789abcdef0123456789abcdef";
const live = (over: Record<string, string> = {}) => ({
  BRIDGE_MODE: "live",
  PROTECT_URL: "https://192.168.50.1",
  PROTECT_API_KEY: "k",
  BRIDGE_TOKENS: STRONG,
  ...over,
});

describe("admin token strength", () => {
  it("rejects short, guessable and low-entropy tokens", () => {
    expect(() => assertStrongToken("short")).toThrow(/24 characters/);
    expect(() => assertStrongToken("changeme")).toThrow(/24 characters/);
    // Long enough, but still a word anyone would try.
    expect(() => assertStrongToken("garage1111111111111111111")).toThrow(/guessable/);
    expect(() => assertStrongToken("aaaaaaaaaaaaaaaaaaaaaaaaaa")).toThrow(/low-entropy/);
  });

  it("accepts a generated token", () => {
    expect(() => assertStrongToken(STRONG)).not.toThrow();
    expect(loadConfig(live()).bridge.tokens).toEqual([STRONG]);
  });

  it("only applies to live mode, so demo tokens still work", () => {
    expect(() => makeConfig({ bridge: { mode: "mock", tokens: ["demo-1"] } })).not.toThrow();
  });
});

describe("PROTECT_TLS=insecure", () => {
  it("classifies LAN hosts", () => {
    for (const h of ["192.168.50.1", "10.0.0.5", "172.16.3.4", "127.0.0.1", "udm.local", "localhost"]) {
      expect(isLanHost(h), h).toBe(true);
    }
    for (const h of ["protect.example.com", "203.0.113.7", "172.32.0.1"]) {
      expect(isLanHost(h), h).toBe(false);
    }
  });

  it("is allowed on the LAN and refused for a routable host", () => {
    expect(() => loadConfig(live())).not.toThrow();
    expect(() => loadConfig(live({ PROTECT_URL: "https://protect.example.com" }))).toThrow(/refused for the non-LAN host/);
    // The escape hatches stay open.
    expect(() => loadConfig(live({ PROTECT_URL: "https://protect.example.com", PROTECT_TLS: "system" }))).not.toThrow();
    expect(() => loadConfig(live({ PROTECT_URL: "https://protect.example.com", PROTECT_TLS: `fingerprint:${"a".repeat(64)}` }))).not.toThrow();
  });
});

describe("activity CSV export", () => {
  it("neutralises a formula in an attacker-supplied member name", () => {
    const csv = auditToCsv([
      { id: 1, at: "2026-09-21T00:00:00.000Z", kind: "command", source: "api", member: '=HYPERLINK("http://evil","x")', command: "open", from: "closed", to: "open", outcome: "ok", detail: "+1" },
    ] as never);
    const row = csv.split("\r\n")[1]!;
    expect(row).toContain("\"'=HYPERLINK");
    expect(row).toContain("'+1");
    expect(row).not.toMatch(/,=HYPERLINK/);
  });
});

describe("event stream caps", () => {
  it("refuses more than sse.maxPerToken concurrent streams for one token", async () => {
    const config = mockConfig({ sse: { maxPerToken: 2, maxTotal: 10 } });
    const registry = new MockRegistry(config, silentLogger);
    const app = await buildServer({ config, logger: silentLogger, registry });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const controllers: AbortController[] = [];
    const open = async () => {
      const ac = new AbortController();
      controllers.push(ac);
      return fetch(`${base}/v1/events`, { headers: { authorization: "Bearer demo-sse" }, signal: ac.signal });
    };
    const a = await open();
    const b = await open();
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const c = await fetch(`${base}/v1/events`, { headers: { authorization: "Bearer demo-sse" } });
    expect(c.status).toBe(429);
    expect(await c.json()).toMatchObject({ error: "rate_limited" });

    // Closing one frees a slot again.
    controllers.pop()!.abort();
    await new Promise((r) => setTimeout(r, 200));
    const d = await fetch(`${base}/v1/events`, { headers: { authorization: "Bearer demo-sse" }, signal: (controllers[controllers.push(new AbortController()) - 1] as AbortController).signal });
    expect(d.status).toBe(200);

    for (const ac of controllers) ac.abort();
    await app.close();
    await registry.stop();
  }, 30000);
});

describe("failed authentication", () => {
  it("throttles an address after repeated bad tokens, without ever blocking a valid one", async () => {
    const config = mockConfig({});
    const registry = new MockRegistry(config, silentLogger);
    const app = await buildServer({ config, logger: silentLogger, registry });
    const bad = (n: number) => app.inject({ method: "GET", url: "/v1/state", headers: { authorization: `Bearer wrong-${n}` } });

    for (let n = 0; n < 30; n++) expect((await bad(n)).statusCode).toBe(401);
    // Past the window's allowance the answer changes, so an attacker learns they are being throttled.
    expect((await bad(99)).statusCode).toBe(429);
    // A different, valid token from the same address is unaffected: households share one public address.
    const ok = await app.inject({ method: "GET", url: "/v1/state", headers: { authorization: "Bearer demo-good" } });
    expect(ok.statusCode).toBe(200);

    await app.close();
    await registry.stop();
  }, 30000);
});
