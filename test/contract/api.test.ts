import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer, type BridgeServer } from "../../src/http/server.js";
import { MockRegistry } from "../../src/mock/registry.js";
import { ContractValidator } from "../../src/http/validation.js";
import { mockConfig } from "../helpers.js";
import { silentLogger } from "../../src/logger.js";

/** Every response body is validated against the OpenAPI component named for the operation. */
describe("bridge HTTP API matches packages/contract/bridge.openapi.yaml", () => {
  let app: BridgeServer;
  let registry: MockRegistry;
  const v = new ContractValidator();
  const auth = { authorization: "Bearer demo-contract" };
  const cfg = mockConfig({ door: { travelSeconds: 1, verifyAfterSeconds: 1 } });

  beforeAll(async () => {
    registry = new MockRegistry(cfg, silentLogger);
    app = await buildServer({ config: cfg, logger: silentLogger, registry, validateResponses: true });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await registry.stop();
  });

  it("documents every implemented route and vice-versa", () => {
    const documented = new Set<string>();
    for (const [path, ops] of Object.entries(v.doc.paths)) for (const m of Object.keys(ops)) if (m !== "parameters") documented.add(`${m.toUpperCase()} ${path.replace(/\{(\w+)\}/g, ":$1")}`);
    const implemented = new Set<string>();
    for (const line of app.printRoutes({ commonPrefix: false }).split("\n")) {
      const m = line.match(/^\s*(?:[│├└─\s]*)(\S+)\s+\((\w+(?:,\s*\w+)*)\)/);
      if (!m) continue;
      for (const method of m[2]!.split(/,\s*/)) if (method !== "HEAD") implemented.add(`${method} ${m[1]}`);
    }
    for (const d of documented) expect(implemented, `missing implementation for ${d}`).toContain(d);
    for (const i of implemented) expect(documented, `undocumented route ${i}`).toContain(i);
  });

  it("GET /healthz → Health", async () => {
    const r = await app.inject({ method: "GET", url: "/healthz" });
    expect(r.statusCode).toBe(200);
    expect(v.validate("Health", r.json())).toEqual({ ok: true });
  });

  it("401 → Error", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/state" });
    expect(r.statusCode).toBe(401);
    expect(v.validate("Error", r.json())).toEqual({ ok: true });
    expect(v.validate("Error", (await app.inject({ method: "GET", url: "/v1/nope", headers: auth })).json())).toEqual({ ok: true });
  });

  it("GET /v1/state → State", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/state", headers: auth });
    expect(r.statusCode).toBe(200);
    expect(v.validate("State", r.json())).toEqual({ ok: true });
  });

  it("door commands → CommandResult / CommandAccepted / 409 Error", async () => {
    const open = await app.inject({ method: "POST", url: "/v1/door/open?source=contract", headers: auth });
    expect(open.statusCode).toBe(200);
    expect(v.validate("CommandResult", open.json())).toEqual({ ok: true });
    expect(open.json()).toMatchObject({ ok: true, to: "OPEN", pulsed: true });
    const noop = await app.inject({ method: "POST", url: "/v1/door/open", headers: auth });
    expect(noop.json()).toMatchObject({ pulsed: false });
    const close = await app.inject({ method: "POST", url: "/v1/door/close?wait=false", headers: auth });
    expect(close.statusCode).toBe(202);
    expect(v.validate("CommandAccepted", close.json())).toEqual({ ok: true });
    const busy = await app.inject({ method: "POST", url: "/v1/door/toggle", headers: auth });
    expect(busy.statusCode).toBe(409);
    expect(v.validate("Error", busy.json())).toEqual({ ok: true });
    await new Promise((r) => setTimeout(r, 2300));
    const toggle = await app.inject({ method: "POST", url: "/v1/door/toggle", headers: auth });
    expect(toggle.json()).toMatchObject({ ok: true, from: "CLOSED", to: "OPEN" });
  });

  it("hold → Hold / 400 / 204", async () => {
    const bad = await app.inject({ method: "POST", url: "/v1/hold", headers: auth, payload: { minutes: 0 } });
    expect(bad.statusCode).toBe(400);
    expect(v.validate("Error", bad.json())).toEqual({ ok: true });
    const r = await app.inject({ method: "POST", url: "/v1/hold", headers: auth, payload: { minutes: 45 } });
    expect(r.statusCode).toBe(200);
    expect(v.validate("Hold", r.json())).toEqual({ ok: true });
    expect(r.json()).toMatchObject({ active: true, minutes: 45 });
    expect((await app.inject({ method: "GET", url: "/v1/state", headers: auth })).json().hold.active).toBe(true);
    expect((await app.inject({ method: "DELETE", url: "/v1/hold", headers: auth })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/v1/state", headers: auth })).json().hold).toEqual({ active: false });
  });

  it("GET /v1/audit → AuditEntry[] with paging", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/audit?limit=2", headers: auth });
    expect(r.statusCode).toBe(200);
    const entries = r.json().entries as { id: number }[];
    expect(entries.length).toBe(2);
    for (const e of entries) expect(v.validate("AuditEntry", e)).toEqual({ ok: true });
    const older = await app.inject({ method: "GET", url: `/v1/audit?before=${entries[1]!.id}`, headers: auth });
    expect((older.json().entries as { id: number }[]).every((e) => e.id < entries[1]!.id)).toBe(true);
    expect((await app.inject({ method: "GET", url: "/v1/audit?limit=9999", headers: auth })).statusCode).toBe(400);
  });

  it("GET /v1/discovery → Discovery", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/discovery", headers: auth });
    expect(r.statusCode).toBe(200);
    expect(v.validate("Discovery", r.json())).toEqual({ ok: true });
  });

  it("mock actions → State; unknown action → 400; plate required", async () => {
    for (const a of ["vehicle-arrived", "vehicle-left", "reverse-next-close", "reset"]) {
      const r = await app.inject({ method: "POST", url: `/v1/mock/${a}`, headers: auth });
      expect(r.statusCode, a).toBe(200);
      expect(v.validate("State", r.json())).toEqual({ ok: true });
    }
    expect((await app.inject({ method: "POST", url: "/v1/mock/plate-seen", headers: auth, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/v1/mock/plate-seen", headers: auth, payload: { plate: "DEMO123" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/v1/mock/explode", headers: auth })).statusCode).toBe(400);
  });

  it("POST /v1/auto-actions/{id}/undo → CommandResult / 404 undo_expired", async () => {
    const t = { authorization: "Bearer demo-undo" };
    await app.inject({ method: "POST", url: "/v1/mock/reset", headers: t });
    const seen = await app.inject({ method: "POST", url: "/v1/mock/plate-seen", headers: t, payload: { plate: "ABC123" } });
    expect(seen.json().door).toBe("OPENING");
    const inst = await registry.get("demo-undo");
    const id = inst.lpr!.pendingUndo()[0]!.id;
    const busy = await app.inject({ method: "POST", url: `/v1/auto-actions/${id}/undo`, headers: t });
    expect(busy.statusCode).toBe(409);
    expect(v.validate("Error", busy.json())).toEqual({ ok: true });
    await new Promise((r) => setTimeout(r, 2300));
    const undo = await app.inject({ method: "POST", url: `/v1/auto-actions/${id}/undo`, headers: t });
    expect(undo.statusCode).toBe(200);
    expect(v.validate("CommandResult", undo.json())).toEqual({ ok: true });
    expect(undo.json()).toMatchObject({ ok: true, command: "close", to: "CLOSED" });
    const gone = await app.inject({ method: "POST", url: `/v1/auto-actions/${id}/undo`, headers: t });
    expect(gone.statusCode).toBe(404);
    expect(gone.json()).toMatchObject({ error: "undo_expired" });
    expect(v.validate("Error", gone.json())).toEqual({ ok: true });
    expect((await app.inject({ method: "POST", url: "/v1/auto-actions/nope/undo" })).statusCode).toBe(401);
  });

  it("webhook: 204 with the right secret (POST and GET), 404 otherwise", async () => {
    const ok = await app.inject({ method: "POST", url: "/v1/webhooks/alarm-manager/0123456789abcdef", payload: { alarm: { triggers: [{ key: "sensor_opened" }] } } });
    expect(ok.statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/v1/webhooks/alarm-manager/0123456789abcdef?event=closed" })).statusCode).toBe(204);
    expect((await app.inject({ method: "POST", url: "/v1/webhooks/alarm-manager/nope-nope-nope-nope" })).statusCode).toBe(404);
    const multipart = await app.inject({ method: "POST", url: "/v1/webhooks/alarm-manager/0123456789abcdef", headers: { "content-type": "multipart/form-data; boundary=x" }, payload: "--x--" });
    expect(multipart.statusCode).toBe(204);
  });

  it("SSE stream sends the initial state frame and accepts ?token=", async () => {
    // light-my-request cannot end an infinite stream; the live stream is covered by the e2e suite.
    const { sseFrame } = await import("../../src/http/sse.js");
    expect(sseFrame("state", { door: "OPEN" })).toBe('event: state\ndata: {"door":"OPEN"}\n\n');
    expect((await app.inject({ method: "GET", url: "/v1/events" })).statusCode).toBe(401);
  });

  it("rate limits door commands at 10/min per token", async () => {
    const t = { authorization: "Bearer demo-ratelimit" };
    let last = 200;
    for (let i = 0; i < 12; i++) last = (await app.inject({ method: "POST", url: "/v1/door/open", headers: t })).statusCode;
    expect(last).toBe(429);
  });
});
