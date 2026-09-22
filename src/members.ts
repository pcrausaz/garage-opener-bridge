import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Store } from "./store/db.js";
import type { components } from "./contract.js";

export type Member = components["schemas"]["Member"];

export interface MemberIdentity {
  id: string;
  name: string;
  kind: "admin" | "member";
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateToken(prefix = ""): string {
  return prefix + randomBytes(32).toString("base64url");
}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function generateInviteCode(): string {
  const bytes = randomBytes(10);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out; // 16 chars
}

export function hashesEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && timingSafeEqual(x, y);
}

export const INVITE_TTL_MS = 15 * 60_000;

interface MemberRow {
  id: string;
  name: string;
  kind: "admin" | "member";
  token_hash: string;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
}

interface InviteRow {
  code_hash: string;
  created_by: string;
  created_at: string;
  expires_at: number;
  claimed_at: string | null;
}

export interface CreatedInvite {
  code: string;
  expiresAt: string;
}

/** Member tokens (SQLite) plus the admin tokens from BRIDGE_TOKENS. */
export class MembersService {
  private lastSeenTouched = new Map<string, number>();
  private readonly admins: { token: string; id: string; name: string }[] = [];

  constructor(private readonly store: Store, private readonly now: () => number = Date.now) {}

  /** Register configured admin tokens (idempotent; keyed by token hash). */
  ensureAdmins(tokens: string[], names: string[] = []): void {
    tokens.forEach((token, i) => {
      const hash = hashToken(token);
      const name = names[i]?.trim() || (tokens.length > 1 ? `Admin ${i + 1}` : "Admin");
      let row = this.store.db.prepare("SELECT * FROM members WHERE token_hash = ?").get(hash) as MemberRow | undefined;
      if (!row) {
        const id = "adm_" + randomBytes(6).toString("hex");
        this.store.db
          .prepare("INSERT INTO members (id, name, kind, token_hash, created_at) VALUES (?, ?, 'admin', ?, ?)")
          .run(id, name, hash, new Date(this.now()).toISOString());
        row = this.store.db.prepare("SELECT * FROM members WHERE id = ?").get(id) as MemberRow;
      } else if (row.revoked_at) {
        this.store.db.prepare("UPDATE members SET revoked_at = NULL WHERE id = ?").run(row.id);
      }
      this.admins.push({ token, id: row.id, name: row.name });
    });
  }

  /** Resolve a bearer token to an identity; admin tokens are compared in constant time, member tokens by hash. */
  authenticate(token: string): MemberIdentity | null {
    for (const a of this.admins) {
      const x = Buffer.from(a.token);
      const y = Buffer.from(token);
      if (x.length === y.length && timingSafeEqual(x, y)) return { id: a.id, name: a.name, kind: "admin" };
    }
    const row = this.store.db.prepare("SELECT * FROM members WHERE token_hash = ? AND revoked_at IS NULL").get(hashToken(token)) as MemberRow | undefined;
    return row ? { id: row.id, name: row.name, kind: row.kind } : null;
  }

  isRevoked(token: string): boolean {
    return this.store.db.prepare("SELECT 1 FROM members WHERE token_hash = ? AND revoked_at IS NOT NULL").get(hashToken(token)) !== undefined;
  }

  /** Update last_seen_at at most once per minute per member. */
  touch(id: string): void {
    const t = this.now();
    const last = this.lastSeenTouched.get(id) ?? 0;
    if (t - last < 60_000) return;
    this.lastSeenTouched.set(id, t);
    this.store.db.prepare("UPDATE members SET last_seen_at = ? WHERE id = ?").run(new Date(t).toISOString(), id);
  }

  createInvite(createdBy: string): CreatedInvite {
    const code = generateInviteCode();
    const expires = this.now() + INVITE_TTL_MS;
    this.store.db
      .prepare("INSERT INTO invites (code_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .run(hashToken(code), createdBy, new Date(this.now()).toISOString(), expires);
    this.store.db.prepare("DELETE FROM invites WHERE expires_at < ?").run(this.now() - 86_400_000);
    return { code, expiresAt: new Date(expires).toISOString() };
  }

  /** True when an unexpired, unclaimed invite with this code exists (used by mock mode to find the instance). */
  hasInvite(code: string): boolean {
    return this.findInvite(code) !== null;
  }

  private findInvite(code: string): InviteRow | null {
    const hash = hashToken(code.toUpperCase());
    const rows = this.store.db.prepare("SELECT * FROM invites WHERE claimed_at IS NULL AND expires_at >= ?").all(this.now()) as InviteRow[];
    return rows.find((r) => hashesEqual(r.code_hash, hash)) ?? null;
  }

  /** Redeem a code once; returns the plaintext token (shown once) and the member. */
  claim(code: string, deviceName: string, tokenPrefix = ""): { token: string; member: Member } | null {
    const inv = this.findInvite(code);
    if (!inv) return null;
    const token = generateToken(tokenPrefix);
    const id = "mem_" + randomBytes(6).toString("hex");
    const createdAt = new Date(this.now()).toISOString();
    const tx = this.store.db.transaction(() => {
      const r = this.store.db.prepare("UPDATE invites SET claimed_at = ? WHERE code_hash = ? AND claimed_at IS NULL").run(createdAt, inv.code_hash);
      if (r.changes !== 1) throw new Error("already claimed");
      this.store.db.prepare("INSERT INTO members (id, name, kind, token_hash, created_at) VALUES (?, ?, 'member', ?, ?)").run(id, deviceName.trim(), hashToken(token), createdAt);
    });
    try {
      tx();
    } catch {
      return null;
    }
    this.store.audit({ kind: "member", source: "invite", outcome: "ok", detail: `claimed by ${deviceName.trim()}`, member: deviceName.trim() });
    return { token, member: { id, name: deviceName.trim(), kind: "member", createdAt, lastSeenAt: null } };
  }

  get(id: string): Member | null {
    const row = this.store.db.prepare("SELECT * FROM members WHERE id = ? AND revoked_at IS NULL").get(id) as MemberRow | undefined;
    return row ? this.toMember(row) : null;
  }

  list(): Member[] {
    const rows = this.store.db.prepare("SELECT * FROM members WHERE revoked_at IS NULL ORDER BY created_at").all() as MemberRow[];
    return rows.map((r) => this.toMember(r));
  }

  /** Rename a member; an admin may rename anyone, a member only itself. Admin rows keep the new name across restarts. */
  rename(id: string, name: string, by: MemberIdentity): Member | "not_found" | "forbidden" {
    const row = this.store.db.prepare("SELECT * FROM members WHERE id = ? AND revoked_at IS NULL").get(id) as MemberRow | undefined;
    if (!row) return "not_found";
    if (by.kind !== "admin" && by.id !== id) return "forbidden";
    const trimmed = name.trim();
    this.store.db.prepare("UPDATE members SET name = ? WHERE id = ?").run(trimmed, id);
    for (const a of this.admins) if (a.id === id) a.name = trimmed;
    if (trimmed !== row.name) this.store.audit({ kind: "member", source: by.id === id ? "self" : "admin", outcome: "ok", detail: `renamed ${row.name} to ${trimmed}`, member: by.name });
    return this.toMember({ ...row, name: trimmed });
  }

  /** Revoke a member token; admin rows configured via BRIDGE_TOKENS cannot be revoked here. */
  revoke(id: string, by: MemberIdentity): "ok" | "not_found" | "forbidden" {
    const row = this.store.db.prepare("SELECT * FROM members WHERE id = ? AND revoked_at IS NULL").get(id) as MemberRow | undefined;
    if (!row) return "not_found";
    if (row.kind === "admin") return "forbidden";
    if (by.kind !== "admin" && by.id !== id) return "forbidden";
    this.store.db.prepare("UPDATE members SET revoked_at = ? WHERE id = ?").run(new Date(this.now()).toISOString(), id);
    this.store.audit({ kind: "member", source: by.kind === "admin" ? "admin" : "self", outcome: "ok", detail: `revoked ${row.name}`, member: by.name });
    return "ok";
  }

  private toMember(r: MemberRow): Member {
    return { id: r.id, name: r.name, kind: r.kind, createdAt: r.created_at, lastSeenAt: r.last_seen_at };
  }
}
