import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const AUDIT_KINDS = ["command", "alert", "hold", "webhook", "auto-action", "mock", "member"] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];
export type AuditOutcome = "ok" | "noop" | "failed" | "rejected" | "notified" | "undone";

export interface AuditEntry {
  id: number;
  at: string;
  kind: AuditKind;
  source: string;
  /** Name of the phone whose token issued the action, when known. */
  member?: string;
  command?: string;
  from?: string;
  to?: string;
  outcome: AuditOutcome;
  detail?: string;
}

export type AuditInput = Omit<AuditEntry, "id" | "at"> & { at?: string };

export class Store {
  readonly db: Database.Database;
  private readonly insertAudit;
  private readonly updateAudit;
  private readonly getKv;
  private readonly setKv;
  private readonly delKv;

  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        kind TEXT NOT NULL,
        source TEXT NOT NULL,
        command TEXT,
        from_state TEXT,
        to_state TEXT,
        outcome TEXT NOT NULL,
        detail TEXT
      );
      CREATE INDEX IF NOT EXISTS audit_at ON audit(at);
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS members (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        last_seen_at TEXT,
        revoked_at TEXT
      );
      CREATE TABLE IF NOT EXISTS invites (
        code_hash TEXT PRIMARY KEY,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        claimed_at TEXT
      );
    `);
    const cols = (this.db.pragma("table_info(audit)") as { name: string }[]).map((c) => c.name);
    if (!cols.includes("member")) this.db.exec("ALTER TABLE audit ADD COLUMN member TEXT");
    this.insertAudit = this.db.prepare(
      "INSERT INTO audit (at, kind, source, member, command, from_state, to_state, outcome, detail) VALUES (@at, @kind, @source, @member, @command, @from, @to, @outcome, @detail)",
    );
    this.updateAudit = this.db.prepare("UPDATE audit SET to_state = COALESCE(@to, to_state), outcome = @outcome, detail = COALESCE(@detail, detail) WHERE id = @id");
    this.getKv = this.db.prepare("SELECT value FROM kv WHERE key = ?");
    this.setKv = this.db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    this.delKv = this.db.prepare("DELETE FROM kv WHERE key = ?");
  }

  audit(input: AuditInput): number {
    const res = this.insertAudit.run({
      at: input.at ?? new Date().toISOString(),
      kind: input.kind,
      source: input.source,
      member: input.member ?? null,
      command: input.command ?? null,
      from: input.from ?? null,
      to: input.to ?? null,
      outcome: input.outcome,
      detail: input.detail ?? null,
    });
    return Number(res.lastInsertRowid);
  }

  auditUpdate(id: number, patch: { to?: string; outcome: AuditOutcome; detail?: string }): void {
    this.updateAudit.run({ id, to: patch.to ?? null, outcome: patch.outcome, detail: patch.detail ?? null });
  }

  /** Newest first. `kinds` (when non-empty) restricts the result to those audit kinds. */
  listAudit(limit = 50, before?: number, kinds?: readonly AuditKind[]): AuditEntry[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (before !== undefined) {
      where.push("id < ?");
      params.push(before);
    }
    if (kinds?.length) {
      where.push(`kind IN (${kinds.map(() => "?").join(",")})`);
      params.push(...kinds);
    }
    const sql = `SELECT * FROM audit${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...params, limit) as Record<string, unknown>[];
    return rows.map((r) => {
      const e: AuditEntry = { id: r.id as number, at: r.at as string, kind: r.kind as AuditKind, source: r.source as string, outcome: r.outcome as AuditOutcome };
      if (r.member) e.member = r.member as string;
      if (r.command) e.command = r.command as string;
      if (r.from_state) e.from = r.from_state as string;
      if (r.to_state) e.to = r.to_state as string;
      if (r.detail) e.detail = r.detail as string;
      return e;
    });
  }

  countAudit(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM audit").get() as { n: number }).n;
  }

  /**
   * Drop audit rows older than `days`. `days <= 0` keeps everything (the default), so an install that never
   * sets AUDIT_RETENTION_DAYS behaves exactly as before. Returns how many rows went.
   */
  pruneAudit(days: number, now = Date.now()): number {
    if (!Number.isFinite(days) || days <= 0) return 0;
    const cutoff = new Date(now - days * 86_400_000).toISOString();
    const res = this.db.prepare("DELETE FROM audit WHERE at < ?").run(cutoff);
    return res.changes;
  }

  get<T>(key: string): T | null {
    const row = this.getKv.get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : null;
  }
  set(key: string, value: unknown): void {
    this.setKv.run(key, JSON.stringify(value));
  }
  delete(key: string): void {
    this.delKv.run(key);
  }
  close(): void {
    this.db.close();
  }
}

/** RFC 4180 field: quote when it contains a comma, quote, CR or LF; double any embedded quote. */
function csvField(v: string | number | undefined): string {
  if (v === undefined || v === null) return "";
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export const AUDIT_CSV_HEADER = ["id", "at", "kind", "source", "member", "command", "from", "to", "outcome", "detail"] as const;

/** Newest-first CSV of audit rows, UTF-8, no BOM. Timestamps stay ISO-8601 so they sort and re-parse. */
export function auditToCsv(entries: readonly AuditEntry[]): string {
  const rows = entries.map((e) => [e.id, e.at, e.kind, e.source, e.member, e.command, e.from, e.to, e.outcome, e.detail].map(csvField).join(","));
  return [AUDIT_CSV_HEADER.join(","), ...rows].join("\r\n") + "\r\n";
}
