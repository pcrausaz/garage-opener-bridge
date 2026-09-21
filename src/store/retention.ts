import type { Logger } from "../logger.js";
import type { Store } from "./db.js";

const DAY_MS = 86_400_000;

/**
 * Keeps the audit table from growing forever. Prunes once at start and then daily; `retentionDays <= 0`
 * (the default) disables it entirely, so existing installs keep every row unless they opt in.
 */
export class AuditRetention {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly store: Store,
    private readonly retentionDays: number,
    private readonly log: Logger,
    private readonly intervalMs = DAY_MS,
  ) {}

  get enabled(): boolean {
    return Number.isFinite(this.retentionDays) && this.retentionDays > 0;
  }

  /** Prune now, then every `intervalMs`. Safe to call when disabled (does nothing). */
  start(): void {
    if (!this.enabled || this.timer) return;
    this.runOnce();
    this.timer = setInterval(() => this.runOnce(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Exposed for tests and the start path; never throws — a failed prune must not take the bridge down. */
  runOnce(): number {
    if (!this.enabled) return 0;
    try {
      const removed = this.store.pruneAudit(this.retentionDays);
      if (removed > 0) this.log.info({ removed, retentionDays: this.retentionDays }, "pruned audit log");
      return removed;
    } catch (err) {
      this.log.warn({ err }, "audit prune failed");
      return 0;
    }
  }
}
