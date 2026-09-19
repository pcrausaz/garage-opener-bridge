import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:https";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X509Certificate } from "node:crypto";
import { request } from "undici";
import { buildDispatcher } from "../../src/protect/client.js";

/** Pinning must survive many sequential connections: with TLS session resumption Node reports an empty peer cert. */
describe("PROTECT_TLS fingerprint pinning", () => {
  let server: Server;
  let port = 0;
  let fingerprint = "";
  let connections = 0;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "pin-"));
    const openssl = existsSync("/usr/bin/openssl") ? "/usr/bin/openssl" : "openssl";
    execFileSync(openssl, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"), "-days", "2", "-subj", "/CN=localhost"], { stdio: "ignore" });
    const cert = readFileSync(join(dir, "cert.pem"));
    fingerprint = new X509Certificate(cert).fingerprint256.replace(/:/g, "").toLowerCase();
    server = createServer({ key: readFileSync(join(dir, "key.pem")), cert }, (_req, res) => { res.setHeader("content-type", "application/json"); res.end('{"ok":true}'); });
    server.on("secureConnection", () => { connections += 1; });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as { port: number }).port;
  });
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

  it("accepts the pinned certificate across 5 sequential connections", async () => {
    const dispatcher = buildDispatcher(`fingerprint:${fingerprint}`);
    for (let i = 0; i < 5; i++) {
      const res = await request(`https://127.0.0.1:${port}/x`, { dispatcher, headers: { connection: "close" } });
      expect(res.statusCode).toBe(200);
      await res.body.text();
    }
    expect(connections).toBeGreaterThanOrEqual(5);
    await dispatcher.close();
  });

  it("rejects a different fingerprint", async () => {
    const dispatcher = buildDispatcher(`fingerprint:${"0".repeat(64)}`);
    await expect(request(`https://127.0.0.1:${port}/x`, { dispatcher })).rejects.toThrow(/fingerprint mismatch/);
    await dispatcher.close();
  });
});
