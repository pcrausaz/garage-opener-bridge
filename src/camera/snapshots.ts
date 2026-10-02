import type { Logger } from "../logger.js";
import { ProtectError, type ProtectClient } from "../protect/types.js";

/** A picture and when the bridge captured it. */
export interface Snapshot {
  contentType: string;
  body: Buffer;
  at: number;
}

export type SnapshotFailure = "camera_unavailable" | "camera_forbidden" | "rate_limited";

/** Why there is no picture, already mapped to the HTTP answer (ADR-0021). */
export class SnapshotError extends Error {
  constructor(readonly code: SnapshotFailure, readonly status: 429 | 502 | 503, message: string) {
    super(message);
    this.name = "SnapshotError";
  }
}

/** While a door is moving the picture is the point; otherwise it is a glance. */
export const SNAPSHOT_MOVING_MS = 2000;
export const SNAPSHOT_IDLE_MS = 10_000;

interface Entry {
  snapshot: Snapshot | null;
  failure: { error: SnapshotError; at: number } | null;
  inflight: Promise<Snapshot> | null;
  /** Bumped by `invalidate()`, so a fetch that was already in the air is not kept as fresh. */
  generation: number;
}

export interface SnapshotCacheDeps {
  protect: ProtectClient;
  /** Whether any door using this camera is travelling right now. */
  isMoving: (cameraId: string) => boolean;
  logger: Logger;
  now?: () => number;
}

/**
 * Camera stills, fetched once and shared. The cache is per *camera*, not per door or per phone: two doors
 * that share a camera, and every phone looking at either, are served by one upstream request — each of
 * which spends one of the API key's ten requests per second, the same budget door polling uses.
 *
 * Nothing stale is ever served in place of an error. A failure is remembered for the short window so that
 * several phones polling a dead camera do not turn into a request storm against the console.
 */
export class SnapshotCache {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly log: Logger;

  constructor(private readonly d: SnapshotCacheDeps) {
    this.now = d.now ?? Date.now;
    this.log = d.logger.child({ component: "snapshots" });
  }

  private entry(cameraId: string): Entry {
    let e = this.entries.get(cameraId);
    if (!e) {
      e = { snapshot: null, failure: null, inflight: null, generation: 0 };
      this.entries.set(cameraId, e);
    }
    return e;
  }

  /** The door changed state: whatever is cached shows the door as it was. */
  invalidate(cameraId: string): void {
    const e = this.entries.get(cameraId);
    if (!e) return;
    e.snapshot = null;
    e.failure = null;
    e.generation++;
  }

  get(cameraId: string): Promise<Snapshot> {
    const e = this.entry(cameraId);
    const t = this.now();
    const ttl = this.d.isMoving(cameraId) ? SNAPSHOT_MOVING_MS : SNAPSHOT_IDLE_MS;
    if (e.snapshot && t - e.snapshot.at < ttl) return Promise.resolve(e.snapshot);
    if (e.failure && t - e.failure.at < SNAPSHOT_MOVING_MS) return Promise.reject(e.failure.error);
    if (e.inflight) return e.inflight;
    const generation = e.generation;
    e.inflight = this.d.protect
      .getCameraSnapshot(cameraId)
      .then(
        (s) => {
          const snapshot: Snapshot = { contentType: s.contentType, body: s.body, at: this.now() };
          e.failure = null;
          e.snapshot = e.generation === generation ? snapshot : null;
          return snapshot;
        },
        (err: unknown) => {
          const error = toSnapshotError(err);
          this.log.warn({ cameraId, code: error.code, err }, "camera snapshot failed");
          e.snapshot = null;
          e.failure = e.generation === generation ? { error, at: this.now() } : null;
          throw error;
        },
      )
      .finally(() => {
        e.inflight = null;
      });
    return e.inflight;
  }
}

/**
 * 401/403: the key is fine for the door but not for this camera. 429: the console's own limiter. Anything
 * else — offline camera, unknown id, a timeout, a 5xx — is "no picture right now".
 */
export function toSnapshotError(err: unknown): SnapshotError {
  const status = err instanceof ProtectError ? err.status : undefined;
  if (status === 401 || status === 403) return new SnapshotError("camera_forbidden", 502, "the console refused the bridge's API key for this camera");
  if (status === 429) return new SnapshotError("rate_limited", 429, "the console is rate limiting the bridge; try again shortly");
  return new SnapshotError("camera_unavailable", 503, `no picture from the camera: ${(err as Error)?.message ?? "unknown error"}`);
}
