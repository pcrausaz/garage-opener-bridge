import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ntfyActions } from "../../src/notify/ntfy.js";
import { OutboundWebhook } from "../../src/notify/webhook.js";
import { Bus } from "../../src/events/bus.js";
import { Store, auditToCsv } from "../../src/store/db.js";
import { MembersService } from "../../src/members.js";
import { HoldService } from "../../src/hold.js";
import { silentLogger } from "../../src/logger.js";
import type { Alert } from "../../src/types.js";

const alert = (over: Partial<Alert> = {}): Alert => ({ id: "a", rule: "open-too-long", title: "t", body: "b", createdAt: "2026-10-02T00:00:00.000Z", actions: ["close-now", "hold-2h", "ignore"], doorId: "d2", ...over });
const urls = (a: unknown[]) => (a as { method: string; url: string }[]).map((x) => `${x.method} ${x.url}`);

describe("ntfy action buttons", () => {
  it("compatibility: with one door they call the routes they always have", () => {
    expect(urls(ntfyActions(alert({ doorId: "d1" }), "https://b", "tok"))).toEqual(["POST https://b/v1/door/close?source=ntfy", "POST https://b/v1/hold"]);
    expect(urls(ntfyActions(alert({ doorId: "d1", rule: "lpr-auto-open", actions: ["undo"] }), "https://b", "tok"))).toEqual(["POST https://b/v1/door/close?source=undo"]);
  });

  it("with more than one door they name the alert's door, not the token's default door", () => {
    expect(urls(ntfyActions(alert(), "https://b", "tok", true))).toEqual(["POST https://b/v1/doors/d2/close?source=ntfy", "PUT https://b/v1/doors/d2/hold"]);
    expect(urls(ntfyActions(alert({ rule: "lpr-auto-close", actions: ["undo"] }), "https://b", "tok", true))).toEqual(["POST https://b/v1/doors/d2/open?source=undo"]);
    expect(urls(ntfyActions(alert({ actions: ["undo"], autoActionId: "x y" }), "https://b", "tok", true))).toEqual(["POST https://b/v1/auto-actions/x%20y/undo"]);
  });
});

describe("outbound event webhook", () => {
  const collect = () => {
    const bodies: { type: string; data: Record<string, unknown> }[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => (bodies.push(JSON.parse(init.body as string)), new Response("", { status: 200 }))) as unknown as typeof fetch;
    return { bodies, hook: new OutboundWebhook({ url: "https://n8n.example/hook", secret: "k", logger: silentLogger, fetchImpl }) };
  };

  it("says which door only on an install with more than one", async () => {
    const one = collect();
    const bus = new Bus();
    one.hook.attach(bus);
    bus.emit("hold", { active: false });
    await one.hook.send("alert", { id: "flush" });
    expect(one.bodies[0]).toMatchObject({ type: "hold", data: { active: false } });
    expect(one.bodies[0]!.data).not.toHaveProperty("doorId");

    const two = collect();
    const second = new Bus();
    two.hook.attach(second, "d2");
    second.emit("hold", { active: false });
    await two.hook.send("alert", { id: "flush" });
    expect(two.bodies[0]!.data).toEqual({ active: false, doorId: "d2" });
  });
});

describe("activity CSV", () => {
  it("gains a `door` column, by name, only when asked to (more than one door)", () => {
    const s = new Store(":memory:");
    s.audit({ kind: "command", source: "app", command: "open", outcome: "ok", doorId: "d2", at: "2026-10-02T00:00:00.000Z" });
    s.audit({ kind: "member", source: "admin", outcome: "ok", at: "2026-10-02T00:00:01.000Z" });
    const rows = s.listAudit(5);
    expect(rows.map((r) => r.doorId)).toEqual([undefined, "d2"]);
    expect(auditToCsv(rows).split("\r\n")[0]).toBe("id,at,kind,source,member,command,from,to,outcome,detail");
    const csv = auditToCsv(rows, new Map([["d1", "Left"], ["d2", "Right, the big one"]])).split("\r\n");
    expect(csv[0]).toBe("id,at,kind,source,member,command,from,to,outcome,detail,door");
    expect(csv[1]).toBe("2,2026-10-02T00:00:01.000Z,member,admin,,,,,ok,,");
    expect(csv[2]).toBe('1,2026-10-02T00:00:00.000Z,command,app,,open,,,ok,,"Right, the big one"');
    s.close();
  });
});

describe("hold-open storage", () => {
  it("d1 uses the key a one-door install already has, so a hold survives the upgrade", () => {
    const s = new Store(":memory:");
    const now = Date.now();
    s.set("hold", { until: now + 60_000, minutes: 1, setAt: now }); // written by 0.5
    const d1 = new HoldService(s, new Bus());
    const d2 = new HoldService(s, new Bus(), Date.now, "d2");
    expect([d1.isActive(), d2.isActive()]).toEqual([true, false]);
    d1.stop();
    d2.stop();
    s.close();
  });
});

describe("default door per member", () => {
  const setup = () => {
    const store = new Store(":memory:");
    const m = new MembersService(store);
    m.ensureAdmins(["admin-token-aaa", "admin-token-bbb"]);
    return { store, m, a: m.authenticate("admin-token-aaa")!, b: m.authenticate("admin-token-bbb")! };
  };

  it("is unset until chosen, and is kept per admin token", () => {
    const { m, a, b } = setup();
    expect(m.defaultDoor(a.id)).toBeNull();
    m.setDefaultDoor(a.id, "d2");
    expect([m.defaultDoor(a.id), m.defaultDoor(b.id)]).toEqual(["d2", null]);
  });

  it("survives a restart for admins, because it lives on the member record", () => {
    const { store, m, a } = setup();
    m.setDefaultDoor(a.id, "d2");
    const again = new MembersService(store);
    again.ensureAdmins(["admin-token-aaa", "admin-token-bbb"]);
    expect(again.defaultDoor(again.authenticate("admin-token-aaa")!.id)).toBe("d2");
  });

  it("a claimed invite starts on the door the invite named, else on the inviter's default", () => {
    const { m, a, b } = setup();
    m.setDefaultDoor(a.id, "d2");
    const inherited = m.claim(m.createInvite(a.id).code, "Margo")!;
    expect(m.defaultDoor(inherited.member.id)).toBe("d2");
    const named = m.claim(m.createInvite(a.id, "d1").code, "Guest")!;
    expect(m.defaultDoor(named.member.id)).toBe("d1");
    const plain = m.claim(m.createInvite(b.id).code, "Other")!;
    expect(m.defaultDoor(plain.member.id)).toBeNull();
    // Changing the inviter's default later does not move the member.
    m.setDefaultDoor(a.id, "d1");
    expect(m.defaultDoor(inherited.member.id)).toBe("d2");
  });

  it("an identity without a member record (the mock demo token) is remembered in the instance's store", () => {
    const { m } = setup();
    expect(m.defaultDoor("demo")).toBeNull();
    m.setDefaultDoor("demo", "d2");
    expect(m.defaultDoor("demo")).toBe("d2");
  });

  it("a database written by 0.5 gains the columns on open and keeps its rows", () => {
    const file = join(mkdtempSync(join(tmpdir(), "go-db-")), "bridge.db");
    const old = new Database(file);
    // The 0.5.2 schema, as that release created it.
    old.exec(`
      CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, kind TEXT NOT NULL, source TEXT NOT NULL, command TEXT, from_state TEXT, to_state TEXT, outcome TEXT NOT NULL, detail TEXT, member TEXT);
      CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE members (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, last_seen_at TEXT, revoked_at TEXT);
      CREATE TABLE invites (code_hash TEXT PRIMARY KEY, created_by TEXT NOT NULL, created_at TEXT NOT NULL, expires_at INTEGER NOT NULL, claimed_at TEXT);
      INSERT INTO audit (at, kind, source, command, outcome) VALUES ('2026-09-22T00:00:00.000Z', 'command', 'app', 'open', 'ok');
      INSERT INTO members (id, name, kind, token_hash, created_at) VALUES ('mem_1', 'Margo', 'member', 'h', '2026-09-22T00:00:00.000Z');
    `);
    old.close();
    const store = new Store(file);
    const m = new MembersService(store);
    expect(store.listAudit(5)).toEqual([{ id: 1, at: "2026-09-22T00:00:00.000Z", kind: "command", source: "app", command: "open", outcome: "ok" }]);
    expect(m.list().map((x) => x.name)).toEqual(["Margo"]);
    expect(m.defaultDoor("mem_1")).toBeNull();
    m.setDefaultDoor("mem_1", "d2");
    expect(m.defaultDoor("mem_1")).toBe("d2");
    store.audit({ kind: "hold", source: "app", outcome: "ok", doorId: "d2" });
    expect(store.listAudit(1)[0]!.doorId).toBe("d2");
    store.close();
  });
});
