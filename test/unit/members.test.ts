import { describe, expect, it } from "vitest";
import { Store } from "../../src/store/db.js";
import { MembersService, INVITE_TTL_MS, generateInviteCode, generateToken, hashToken, hashesEqual } from "../../src/members.js";

describe("members and invites", () => {
  const setup = () => {
    let now = Date.UTC(2026, 8, 19, 12, 0, 0);
    const store = new Store(":memory:");
    const m = new MembersService(store, () => now);
    m.ensureAdmins(["admin-token-aaa", "admin-token-bbb"], ["Pascal's iPhone"]);
    return { store, m, tick: (ms: number) => (now += ms) };
  };

  it("hashes tokens with SHA-256 and compares hashes in constant time", () => {
    const t = generateToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes base64url
    expect(generateToken("demo-")).toMatch(/^demo-[A-Za-z0-9_-]{43}$/);
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashesEqual(hashToken(t), hashToken(t))).toBe(true);
    expect(hashesEqual(hashToken(t), hashToken(t + "x"))).toBe(false);
    expect(hashesEqual("ab", "abcd")).toBe(false);
    expect(generateInviteCode()).toMatch(/^[A-Z2-7]{16}$/);
  });

  it("admin tokens authenticate with names; unknown tokens do not", () => {
    const { m } = setup();
    expect(m.authenticate("admin-token-aaa")).toMatchObject({ kind: "admin", name: "Pascal's iPhone" });
    expect(m.authenticate("admin-token-bbb")).toMatchObject({ kind: "admin", name: "Admin 2" });
    expect(m.authenticate("admin-token-aa")).toBeNull();
    expect(m.authenticate("nope")).toBeNull();
    expect(m.list().map((x) => x.kind)).toEqual(["admin", "admin"]);
  });

  it("invite: claim once, token authenticates as member, code is single-use and expires after 15 min", () => {
    const { m, tick } = setup();
    const admin = m.authenticate("admin-token-aaa")!;
    const inv = m.createInvite(admin.id);
    expect(Date.parse(inv.expiresAt) - Date.UTC(2026, 8, 19, 12, 0, 0)).toBe(INVITE_TTL_MS);
    expect(m.hasInvite(inv.code)).toBe(true);
    expect(m.hasInvite(inv.code.toLowerCase())).toBe(true);
    expect(m.claim("WRONGCODEWRONGCO", "x")).toBeNull();
    const c = m.claim(inv.code, " Margo's iPhone ")!;
    expect(c.member).toMatchObject({ name: "Margo's iPhone", kind: "member" });
    expect(m.authenticate(c.token)).toMatchObject({ id: c.member.id, kind: "member" });
    expect(m.claim(inv.code, "again")).toBeNull(); // single use
    const late = m.createInvite(admin.id);
    tick(INVITE_TTL_MS + 1);
    expect(m.claim(late.code, "late")).toBeNull();
    expect(m.hasInvite(late.code)).toBe(false);
  });

  it("revoke: admin can revoke members, member only itself, admins never; revoked tokens stop authenticating", () => {
    const { m } = setup();
    const admin = m.authenticate("admin-token-aaa")!;
    const a = m.claim(m.createInvite(admin.id).code, "A")!;
    const b = m.claim(m.createInvite(admin.id).code, "B")!;
    const idA = m.authenticate(a.token)!;
    expect(m.revoke(b.member.id, idA)).toBe("forbidden");
    expect(m.revoke(admin.id, idA)).toBe("forbidden");
    expect(m.revoke(admin.id, admin)).toBe("forbidden");
    expect(m.revoke("mem_nope", admin)).toBe("not_found");
    expect(m.revoke(a.member.id, idA)).toBe("ok");
    expect(m.authenticate(a.token)).toBeNull();
    expect(m.revoke(b.member.id, admin)).toBe("ok");
    expect(m.authenticate(b.token)).toBeNull();
    expect(m.list().map((x) => x.kind)).toEqual(["admin", "admin"]);
  });

  it("rename: admin renames anyone (admins included, kept in memory), member only itself; audited only when changed", () => {
    const { m, store } = setup();
    const admin = m.authenticate("admin-token-aaa")!;
    const a = m.claim(m.createInvite(admin.id).code, "A")!;
    const b = m.claim(m.createInvite(admin.id).code, "B")!;
    const idA = m.authenticate(a.token)!;
    expect(m.rename(b.member.id, "Bee", idA)).toBe("forbidden");
    expect(m.rename("mem_nope", "x", admin)).toBe("not_found");
    expect(m.rename(a.member.id, "  Margo ", idA)).toMatchObject({ id: a.member.id, name: "Margo", kind: "member" });
    expect(m.authenticate(a.token)).toMatchObject({ name: "Margo" });
    expect(m.rename(b.member.id, "Bee", admin)).toMatchObject({ name: "Bee" });
    expect(m.rename(admin.id, "Pascal", admin)).toMatchObject({ name: "Pascal", kind: "admin" });
    expect(m.authenticate("admin-token-aaa")).toMatchObject({ name: "Pascal" });
    expect(m.rename(admin.id, "Pascal", admin)).toMatchObject({ name: "Pascal" });
    const details = store.listAudit(10).map((r) => r.detail);
    expect(details.filter((d) => d?.startsWith("renamed"))).toEqual(["renamed Pascal's iPhone to Pascal", "renamed B to Bee", "renamed A to Margo"]);
  });

  it("last_seen_at is written at most once per minute", () => {
    const { m, store, tick } = setup();
    const admin = m.authenticate("admin-token-aaa")!;
    const c = m.claim(m.createInvite(admin.id).code, "C")!;
    const seen = () => (store.db.prepare("SELECT last_seen_at FROM members WHERE id = ?").get(c.member.id) as { last_seen_at: string | null }).last_seen_at;
    m.touch(c.member.id);
    const first = seen();
    expect(first).not.toBeNull();
    tick(30_000);
    m.touch(c.member.id);
    expect(seen()).toBe(first);
    tick(31_000);
    m.touch(c.member.id);
    expect(seen()).not.toBe(first);
  });

  it("audit rows carry the member name", () => {
    const { m, store } = setup();
    const admin = m.authenticate("admin-token-aaa")!;
    m.claim(m.createInvite(admin.id).code, "Margo's iPhone");
    store.audit({ kind: "command", source: "app", member: "Margo's iPhone", command: "open", outcome: "ok" });
    const rows = store.listAudit(5);
    expect(rows[0]).toMatchObject({ kind: "command", member: "Margo's iPhone" });
    expect(rows[1]).toMatchObject({ kind: "member", detail: "claimed by Margo's iPhone" });
  });
});
