import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { HttpProtectClient } from "../../src/protect/client.js";
import { discover } from "../../src/discovery.js";
import { silentLogger } from "../../src/logger.js";

/**
 * Read-only checks against the real console. Runs only with LIVE_DOOR_TESTS=1 (pnpm test:live).
 * It NEVER activates the relay. Credentials come from ../.env (PROTECT_URL, PROTECT_API_KEY).
 */
const enabled = process.env.LIVE_DOOR_TESTS === "1";

function env(): { url: string; key: string } {
  const e = { ...process.env };
  try {
    for (const line of readFileSync(new URL("../../../.env", import.meta.url), "utf8").split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m && !e[m[1]!]) e[m[1]!] = m[2]!.trim();
    }
  } catch {
    /* no .env */
  }
  return { url: e.PROTECT_URL ?? "https://192.168.50.1", key: e.PROTECT_API_KEY ?? "" };
}

describe.skipIf(!enabled)("live Protect console (read-only)", () => {
  const { url, key } = env();
  const client = new HttpProtectClient({ baseUrl: url, apiKey: key, tls: "insecure", logger: silentLogger });

  it("reports the expected Protect version family", async () => {
    const meta = await client.getMetaInfo();
    expect(meta.applicationVersion).toMatch(/^7\./);
  });

  it("lists the garage sensor and relay with the documented ids", async () => {
    const sensors = await client.getSensors();
    const garage = sensors.find((s) => s.mountType === "garage");
    expect(garage?.id).toBe("6609938d012d0803e408748d");
    expect(typeof garage?.isOpened).toBe("boolean");
    expect(typeof garage?.openStatusChangedAt).toBe("number");
    const relays = await client.getRelays();
    const relay = relays.find((r) => r.id === "6aa43ec903253903e401d542");
    expect(relay?.outputs.find((o) => o.id === 0)?.type).toBe("garageDoor");
  });

  it("auto-pairs to the documented mapping", async () => {
    const d = await discover(client, null, {});
    expect(d.autoPaired).toBe(true);
    expect(d.current).toMatchObject({ relayId: "6aa43ec903253903e401d542", outputId: 0, sensorId: "6609938d012d0803e408748d" });
  });

  it("does not activate anything (guard)", () => {
    expect(process.env.LIVE_DOOR_ACTUATE).toBeUndefined();
  });
});
