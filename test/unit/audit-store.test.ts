import { describe, expect, it } from "vitest";
import { auditToCsv, Store, type AuditInput } from "../../src/store/db.js";
import { AuditRetention } from "../../src/store/retention.js";
import { silentLogger } from "../../src/logger.js";

const DAY = 86_400_000;

function seeded(rows: AuditInput[]): Store {
  const s = new Store(":memory:");
  for (const r of rows) s.audit(r);
  return s;
}

describe("audit store", () => {
  it("filters by kind and still pages with before", () => {
    const s = seeded([
      { kind: "command", source: "app", command: "open", outcome: "ok" },
      { kind: "alert", source: "engine", outcome: "notified", detail: "open too long" },
      { kind: "command", source: "siri", command: "close", outcome: "ok" },
      { kind: "webhook", source: "alarm-manager", outcome: "ok", detail: "opened" },
      { kind: "command", source: "widget", command: "open", outcome: "failed" },
    ]);

    expect(s.listAudit(50).map((e) => e.kind)).toEqual(["command", "webhook", "command", "alert", "command"]);
    expect(s.listAudit(50, undefined, ["command"]).map((e) => e.command)).toEqual(["open", "close", "open"]);
    expect(s.listAudit(50, undefined, ["alert", "webhook"]).map((e) => e.kind)).toEqual(["webhook", "alert"]);

    // paging inside a filter: ids keep decreasing and the filter still applies
    const first = s.listAudit(2, undefined, ["command"]);
    expect(first).toHaveLength(2);
    const next = s.listAudit(2, first[1]!.id, ["command"]);
    expect(next.every((e) => e.id < first[1]!.id && e.kind === "command")).toBe(true);

    // an empty kind list is "no filter", not "match nothing"
    expect(s.listAudit(50, undefined, []).length).toBe(5);
    expect(s.countAudit()).toBe(5);
    s.close();
  });

  it("prunes rows older than the retention window and keeps the rest", () => {
    const now = Date.UTC(2026, 8, 21, 12, 0, 0);
    const at = (daysAgo: number) => new Date(now - daysAgo * DAY).toISOString();
    const s = seeded([
      { kind: "command", source: "app", outcome: "ok", detail: "100 days", at: at(100) },
      { kind: "command", source: "app", outcome: "ok", detail: "31 days", at: at(31) },
      { kind: "command", source: "app", outcome: "ok", detail: "29 days", at: at(29) },
      { kind: "command", source: "app", outcome: "ok", detail: "today", at: at(0) },
    ]);

    expect(s.pruneAudit(0, now)).toBe(0); // 0 = keep forever
    expect(s.pruneAudit(-5, now)).toBe(0);
    expect(s.countAudit()).toBe(4);

    expect(s.pruneAudit(30, now)).toBe(2);
    expect(s.listAudit(50).map((e) => e.detail)).toEqual(["today", "29 days"]);
    expect(s.pruneAudit(30, now)).toBe(0); // idempotent
    s.close();
  });

  it("AuditRetention prunes on start, repeats on the interval, and is a no-op when disabled", () => {
    const store = seeded([{ kind: "command", source: "app", outcome: "ok", at: new Date(Date.now() - 90 * DAY).toISOString() }]);

    const off = new AuditRetention(store, 0, silentLogger);
    expect(off.enabled).toBe(false);
    off.start();
    expect(store.countAudit()).toBe(1);
    off.stop();

    const on = new AuditRetention(store, 30, silentLogger, 60_000);
    expect(on.enabled).toBe(true);
    on.start();
    expect(store.countAudit()).toBe(0);

    store.audit({ kind: "command", source: "app", outcome: "ok", at: new Date(Date.now() - 90 * DAY).toISOString() });
    expect(on.runOnce()).toBe(1);
    on.stop();
    store.close();
  });

  it("survives a store that throws instead of taking the bridge down", () => {
    const store = seeded([]);
    store.close(); // any query now throws
    const r = new AuditRetention(store, 30, silentLogger);
    expect(() => r.start()).not.toThrow();
    expect(r.runOnce()).toBe(0);
    r.stop();
  });
});

describe("audit CSV", () => {
  it("writes a header, escapes separators/quotes/newlines and leaves blanks for missing fields", () => {
    const s = seeded([
      { kind: "command", source: "app", member: 'Margo "M" Ô', command: "open", from: "CLOSED", to: "OPEN", outcome: "ok" },
      { kind: "alert", source: "engine", outcome: "notified", detail: "open too long, 20 min\nsecond line" },
    ]);
    const csv = auditToCsv(s.listAudit(50));
    const lines = csv.split("\r\n");

    expect(lines[0]).toBe("id,at,kind,source,member,command,from,to,outcome,detail");
    // newest first: the alert row, whose detail carries both a comma and a newline
    expect(lines[1]).toContain('"open too long, 20 min\nsecond line"');
    expect(lines[1]).toMatch(/,alert,engine,,,,,notified,/); // blank member/command/from/to
    expect(csv).toContain('"Margo ""M"" Ô"');
    expect(csv.endsWith("\r\n")).toBe(true);

    expect(auditToCsv([])).toBe("id,at,kind,source,member,command,from,to,outcome,detail\r\n");
    s.close();
  });
});
