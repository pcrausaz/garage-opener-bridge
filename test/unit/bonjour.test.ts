import { describe, expect, it } from "vitest";
import { advertisedUrl, lanAddress } from "../../src/bonjour.js";

describe("bonjour advertised url", () => {
  it("prefers PUBLIC_URL without a trailing slash", () => {
    expect(advertisedUrl(8787, "https://garage.example.com/")).toBe("https://garage.example.com");
  });
  it("falls back to the LAN IPv4 address and port", () => {
    const ip = lanAddress();
    const url = advertisedUrl(8787);
    if (ip) expect(url).toBe(`http://${ip}:8787`);
    else expect(url).toBeUndefined();
  });
});
