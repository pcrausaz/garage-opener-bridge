import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer, type BridgeServer } from "../../src/http/server.js";
import { MockRegistry } from "../../src/mock/registry.js";
import { ContractValidator } from "../../src/http/validation.js";
import { mockConfig } from "../helpers.js";
import { silentLogger } from "../../src/logger.js";

/** Every response body is validated against the OpenAPI component named for the operation. */
describe("bridge HTTP API matches contract/bridge.openapi.yaml", () => {
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
    const implemented = app.routeList;
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

  it("GET /v1/audit?kind= filters, rejects unknown kinds", async () => {
    const all = (await app.inject({ method: "GET", url: "/v1/audit?limit=200", headers: auth })).json().entries as { kind: string }[];
    expect(new Set(all.map((e) => e.kind)).size).toBeGreaterThan(1);

    const commands = (await app.inject({ method: "GET", url: "/v1/audit?kind=command&limit=200", headers: auth })).json().entries as { kind: string }[];
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.every((e) => e.kind === "command")).toBe(true);
    for (const e of commands) expect(v.validate("AuditEntry", e)).toEqual({ ok: true });

    const two = (await app.inject({ method: "GET", url: "/v1/audit?kind=command,mock&limit=200", headers: auth })).json().entries as { kind: string }[];
    expect(two.every((e) => e.kind === "command" || e.kind === "mock")).toBe(true);
    expect(two.length).toBeGreaterThanOrEqual(commands.length);

    const bad = await app.inject({ method: "GET", url: "/v1/audit?kind=nope", headers: auth });
    expect(bad.statusCode).toBe(400);
    expect(v.validate("Error", bad.json())).toEqual({ ok: true });
  });

  it("GET /v1/audit.csv → text/csv attachment honouring limit and kind", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/audit.csv?limit=3", headers: auth });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("text/csv");
    expect(r.headers["content-disposition"]).toMatch(/attachment; filename="garage-activity-\d{4}-\d{2}-\d{2}\.csv"/);
    const lines = r.body.trimEnd().split("\r\n");
    expect(lines[0]).toBe("id,at,kind,source,member,command,from,to,outcome,detail");
    expect(lines).toHaveLength(4); // header + 3 rows

    const filtered = await app.inject({ method: "GET", url: "/v1/audit.csv?kind=command&limit=5", headers: auth });
    for (const line of filtered.body.trimEnd().split("\r\n").slice(1)) expect(line.split(",")[2]).toBe("command");

    expect((await app.inject({ method: "GET", url: "/v1/audit.csv?limit=99999", headers: auth })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/v1/audit.csv?kind=nope", headers: auth })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/v1/audit.csv" })).statusCode).toBe(401);
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
    const seen = await app.inject({ method: "POST", url: "/v1/mock/plate-seen", headers: t, payload: { plate: "DEMO123" } });
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

  it("family routes → Invite / InviteClaim / Member[] / 204, with 401/403/404/429", async () => {
    const admin = { authorization: "Bearer test-token-1" };
    expect((await app.inject({ method: "POST", url: "/v1/invites" })).statusCode).toBe(401);
    const inv = await app.inject({ method: "POST", url: "/v1/invites", headers: admin, payload: { publicUrl: "http://bridge.local:8787/" } });
    expect(inv.statusCode).toBe(201);
    expect(v.validate("Invite", inv.json())).toEqual({ ok: true });
    const expiresUnix = Math.floor(Date.parse(inv.json().expiresAt) / 1000);
    expect(inv.json().joinUrl).toBe(`garageopener://join?v=1&b=${encodeURIComponent("http://bridge.local:8787")}&c=${inv.json().code}&e=${expiresUnix}`);
    expect(inv.json().bridgeUrl).toBe("http://bridge.local:8787");
    expect(inv.json().name).toBeUndefined();
    const named = await app.inject({ method: "POST", url: "/v1/invites", headers: admin, payload: { name: " Margo Ô " } });
    expect(named.statusCode).toBe(201);
    expect(v.validate("Invite", named.json())).toEqual({ ok: true });
    expect(named.json().name).toBe("Margo Ô");
    expect(named.json().joinUrl.endsWith(`&n=${encodeURIComponent("Margo Ô")}`)).toBe(true);
    expect((await app.inject({ method: "POST", url: "/v1/invites", headers: admin, payload: { name: "" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/v1/invites", headers: admin, payload: { name: "x".repeat(49) } })).statusCode).toBe(400);

    const bad = await app.inject({ method: "POST", url: `/v1/invites/${inv.json().code}/claim`, payload: {} });
    expect(bad.statusCode).toBe(400);
    expect(v.validate("Error", bad.json())).toEqual({ ok: true });
    const claim = await app.inject({ method: "POST", url: `/v1/invites/${inv.json().code}/claim`, payload: { deviceName: "Contract Phone" } });
    expect(claim.statusCode).toBe(200);
    expect(v.validate("InviteClaim", claim.json())).toEqual({ ok: true });
    expect(claim.json().token).toMatch(/^demo-/);
    expect(claim.json().mapping).toMatchObject({ outputId: 0 });
    expect((await app.inject({ method: "POST", url: `/v1/invites/${inv.json().code}/claim`, payload: { deviceName: "Again" } })).statusCode).toBe(404);
    const memberAuth = { authorization: `Bearer ${claim.json().token}` };
    const forbidden = await app.inject({ method: "POST", url: "/v1/invites", headers: memberAuth });
    expect(forbidden.statusCode).toBe(403);
    expect(v.validate("Error", forbidden.json())).toEqual({ ok: true });

    const list = await app.inject({ method: "GET", url: "/v1/members", headers: admin });
    expect(list.statusCode).toBe(200);
    for (const m of list.json().members) expect(v.validate("Member", m)).toEqual({ ok: true });
    expect(list.json().members.map((m: { kind: string; isCurrent: boolean }) => [m.kind, m.isCurrent])).toEqual([["admin", true], ["member", false]]);
    const mine = await app.inject({ method: "GET", url: "/v1/members", headers: memberAuth });
    expect(mine.json().members).toHaveLength(1);
    expect(mine.json().members[0]).toMatchObject({ name: "Contract Phone", isCurrent: true });

    const id = claim.json().member.id;
    expect((await app.inject({ method: "PATCH", url: `/v1/members/${id}`, headers: memberAuth, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: "PATCH", url: `/v1/members/${list.json().members[0].id}`, headers: memberAuth, payload: { name: "Nope" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "PATCH", url: "/v1/members/mem_nope", headers: admin, payload: { name: "x" } })).statusCode).toBe(404);
    const renamed = await app.inject({ method: "PATCH", url: `/v1/members/${id}`, headers: memberAuth, payload: { name: "Margo" } });
    expect(renamed.statusCode).toBe(200);
    expect(v.validate("Member", renamed.json())).toEqual({ ok: true });
    expect(renamed.json()).toMatchObject({ id, name: "Margo", isCurrent: true });
    expect((await app.inject({ method: "PATCH", url: `/v1/members/${id}`, headers: admin, payload: { name: "Margo M." } })).json()).toMatchObject({ name: "Margo M.", isCurrent: false });
    expect((await app.inject({ method: "DELETE", url: "/v1/members/mem_nope", headers: admin })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/v1/members/${list.json().members[0].id}`, headers: memberAuth })).statusCode).toBe(403);
    expect((await app.inject({ method: "DELETE", url: `/v1/members/${id}`, headers: admin })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/v1/state", headers: memberAuth })).statusCode).toBe(401);

    let last = 0;
    for (let i = 0; i < 7; i++) last = (await app.inject({ method: "POST", url: "/v1/invites/NOPENOPENOPENOPE/claim", payload: { deviceName: "x" }, remoteAddress: "10.9.9.9" })).statusCode;
    expect(last).toBe(429);
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
