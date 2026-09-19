import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type AuditKind = "command" | "alert" | "hold" | "webhook" | "auto-action" | "mock";
export type AuditOutcome = "ok" | "noop" | "failed" | "rejected" | "notified" | "undone";

export interface AuditEntry {
  id: number;
  at: string;
  kind: AuditKind;
  source: string;
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
    `);
    this.insertAudit = this.db.prepare(
      "INSERT INTO audit (at, kind, source, command, from_state, to_state, outcome, detail) VALUES (@at, @kind, @source, @command, @from, @to, @outcome, @detail)",
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

  listAudit(limit = 50, before?: number): AuditEntry[] {
    const rows = (
      before
        ? this.db.prepare("SELECT * FROM audit WHERE id < ? ORDER BY id DESC LIMIT ?").all(before, limit)
        : this.db.prepare("SELECT * FROM audit ORDER BY id DESC LIMIT ?").all(limit)
    ) as Record<string, unknown>[];
    return rows.map((r) => {
      const e: AuditEntry = { id: r.id as number, at: r.at as string, kind: r.kind as AuditKind, source: r.source as string, outcome: r.outcome as AuditOutcome };
      if (r.command) e.command = r.command as string;
      if (r.from_state) e.from = r.from_state as string;
      if (r.to_state) e.to = r.to_state as string;
      if (r.detail) e.detail = r.detail as string;
      return e;
    });
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
