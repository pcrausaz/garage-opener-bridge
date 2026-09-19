import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { buildServer, type BridgeServer } from "../../src/http/server.js";
import { MockRegistry } from "../../src/mock/registry.js";
import { mockConfig } from "../helpers.js";
import { silentLogger } from "../../src/logger.js";
import { verify } from "../../src/notify/webhook.js";

/** Real HTTP end-to-end through the public API in mock mode (short travel time). */
describe("mock-mode e2e", () => {
  let app: BridgeServer;
  let registry: MockRegistry;
  let base: string;
  const received: { event: string; body: string; sig: string }[] = [];
  let sink: ReturnType<typeof createServer>;
  let sinkUrl: string;

  beforeAll(async () => {
    sink = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push({ event: String(req.headers["x-garage-event"]), body, sig: String(req.headers["x-garage-signature"]) });
        res.writeHead(200).end();
      });
    });
    await new Promise<void>((r) => sink.listen(0, "127.0.0.1", r));
    sinkUrl = `http://127.0.0.1:${(sink.address() as { port: number }).port}/hook`;
    const cfg = mockConfig({ door: { travelSeconds: 1, verifyAfterSeconds: 1 }, events: { webhookUrl: sinkUrl, webhookSecret: "hmac-secret" } });
    registry = new MockRegistry(cfg, silentLogger);
    app = await buildServer({ config: cfg, logger: silentLogger, registry, validateResponses: true });
    await app.listen({ host: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    await app.close();
    await registry.stop();
    sink.close();
  });

  const call = (path: string, init: RequestInit = {}, token = "demo-e2e") =>
    fetch(base + path, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) } });

  it("open → wait → verified; state and audit agree", async () => {
    const r = await call("/v1/door/open?source=e2e", { method: "POST" });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({ ok: true, from: "CLOSED", to: "OPEN", pulsed: true, verified: true });
    const s = (await (await call("/v1/state")).json()) as { door: string; isOpened: boolean };
    expect(s.door).toBe("OPEN");
    expect(s.isOpened).toBe(true);
    const audit = (await (await call("/v1/audit?limit=1")).json()) as { entries: unknown[] };
    expect(audit.entries[0]).toMatchObject({ kind: "command", command: "open", source: "e2e", outcome: "ok", from: "CLOSED", to: "OPEN" });
  });

  it("stuck path: reverse-next-close → close reports ok:false / STUCK, then reset recovers", async () => {
    expect((await call("/v1/mock/reverse-next-close", { method: "POST" })).status).toBe(200);
    const r = await (await call("/v1/door/close", { method: "POST" })).json();
    expect(r).toMatchObject({ ok: false, to: "STUCK", error: "verification_failed" });
    expect(((await (await call("/v1/state")).json()) as { door: string }).door).toBe("STUCK");
    const reset = (await (await call("/v1/mock/reset", { method: "POST" })).json()) as { door: string };
    expect(reset.door).toBe("CLOSED");
  });

  it("SSE delivers state and command events", async () => {
    const ac = new AbortController();
    const res = await fetch(`${base}/v1/events?token=demo-e2e`, { signal: ac.signal });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const first = await reader.read();
    buf += dec.decode(first.value);
    expect(buf).toMatch(/^event: state\n/);
    await call("/v1/door/open?wait=false", { method: "POST" });
    const deadline = Date.now() + 3000;
    while (!/event: command\n/.test(buf) && Date.now() < deadline) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buf += dec.decode(chunk.value);
    }
    ac.abort();
    expect(buf).toMatch(/event: state\ndata: .*"door":"OPENING"/);
    expect(buf).toMatch(/event: command\ndata: .*"to":"OPEN"/);
  });

  it("concurrent reviewers never collide (state keyed by token)", async () => {
    await call("/v1/mock/reset", { method: "POST" });
    await call("/v1/door/open", { method: "POST" }, "demo-alice");
    const door = async (t: string) => ((await (await call("/v1/state", {}, t)).json()) as { door: string }).door;
    expect(await door("demo-alice")).toBe("OPEN");
    expect(await door("demo-bob")).toBe("CLOSED");
    expect(registry.size()).toBeGreaterThanOrEqual(3);
  });

  it("hold-open suppresses alerts and is reflected in state", async () => {
    await call("/v1/mock/reset", { method: "POST" });
    const h = (await (await call("/v1/hold", { method: "POST", body: JSON.stringify({ minutes: 120 }) })).json()) as { active: boolean };
    expect(h.active).toBe(true);
    await call("/v1/door/open", { method: "POST" });
    await call("/v1/mock/vehicle-arrived", { method: "POST" });
    const inst = await registry.get("demo-e2e");
    expect(inst.hold.isActive()).toBe(true);
    expect(inst.alerts.fired).toHaveLength(0);
    expect((await call("/v1/hold", { method: "DELETE" })).status).toBe(204);
  });

  it("demo LPR: plate-seen opens the door for a known plate", async () => {
    await call("/v1/mock/reset", { method: "POST" }, "demo-lpr");
    const s = (await (await call("/v1/mock/plate-seen", { method: "POST", body: JSON.stringify({ plate: "abc 123" }) }, "demo-lpr")).json()) as { door: string };
    expect(s.door).toBe("OPENING");
    await new Promise((r) => setTimeout(r, 2300));
    expect(((await (await call("/v1/state", {}, "demo-lpr")).json()) as { door: string }).door).toBe("OPEN");
  });

  it("undo: plate-seen → auto-open → undo → CLOSED; consumed/expired undo → 404", async () => {
    await call("/v1/mock/reset", { method: "POST" }, "demo-undo");
    await call("/v1/mock/plate-seen", { method: "POST", body: JSON.stringify({ plate: "ABC123" }) }, "demo-undo");
    const inst = await registry.get("demo-undo");
    const alert = inst.store.listAudit(5).find((e) => e.kind === "alert");
    expect(alert).toBeDefined();
    const id = inst.lpr!.pendingUndo()[0]!.id;
    const alertEvent = received.map((e) => JSON.parse(e.body)).find((e) => e.type === "alert" && e.data.autoActionId === id);
    expect(alertEvent).toBeDefined();
    await new Promise((r) => setTimeout(r, 2300));
    const r = await call(`/v1/auto-actions/${id}/undo`, { method: "POST" }, "demo-undo");
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, command: "close", to: "CLOSED" });
    expect(((await (await call("/v1/state", {}, "demo-undo")).json()) as { door: string }).door).toBe("CLOSED");
    // a consumed action is gone; true time-based expiry (61 s) is covered with fake timers in test/unit/lpr.test.ts
    const expired = await call(`/v1/auto-actions/${id}/undo`, { method: "POST" }, "demo-undo");
    expect(expired.status).toBe(404);
    expect(await expired.json()).toMatchObject({ error: "undo_expired" });
  });

  it("idle mock instances expire", async () => {
    await call("/v1/state", {}, "demo-expire");
    const before = registry.size();
    await registry.sweep(Date.now() + 61 * 60_000);
    expect(registry.size()).toBeLessThan(before);
    expect(registry.size()).toBe(0);
  });

  it("outbound events were HMAC-signed and include door.command", async () => {
    await new Promise((r) => setTimeout(r, 300));
    expect(received.length).toBeGreaterThan(0);
    for (const ev of received) expect(verify("hmac-secret", ev.body, ev.sig)).toBe(true);
    expect(received.map((e) => e.event)).toContain("door.command");
    expect(received.map((e) => e.event)).toContain("door.state");
    expect(received.map((e) => e.event)).toContain("alert");
  });

  it("rejects tokens outside the demo prefix and the configured list", async () => {
    expect((await call("/v1/state", {}, "random-token")).status).toBe(401);
    expect((await call("/v1/state", {}, "test-token-1")).status).toBe(200);
  });
});
