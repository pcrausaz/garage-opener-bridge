import { Agent, buildConnector, request, type Dispatcher } from "undici";
import type { TLSSocket } from "node:tls";
import type { Logger } from "../logger.js";
import { ProtectError, type ProtectCamera, type ProtectClient, type ProtectMetaInfo, type ProtectRelay, type ProtectSensor } from "./types.js";

export interface HttpProtectClientOptions {
  baseUrl: string;
  apiKey: string;
  tls: string; // insecure | system | fingerprint:<sha256>
  logger: Logger;
  /** Max requests per second sent to the console (console enforces 10/s). */
  maxPerSecond?: number;
  timeoutMs?: number;
  dispatcher?: Dispatcher;
}

/** Simple token bucket so we never trip the console's `10-in-1sec` policy. */
export class RateGate {
  private stamps: number[] = [];
  constructor(private readonly perSecond: number, private readonly now: () => number = Date.now) {}
  async wait(): Promise<void> {
    for (;;) {
      const t = this.now();
      this.stamps = this.stamps.filter((s) => t - s < 1000);
      if (this.stamps.length < this.perSecond) {
        this.stamps.push(t);
        return;
      }
      const delay = 1000 - (t - this.stamps[0]!) + 1;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

export function normalizeFingerprint(fp: string): string {
  return fp.replace(/^fingerprint:/, "").replace(/:/g, "").toUpperCase();
}

export function buildDispatcher(tls: string): Dispatcher {
  if (tls === "system") return new Agent();
  if (tls === "insecure") return new Agent({ connect: { rejectUnauthorized: false } });
  if (tls.startsWith("fingerprint:")) {
    const expected = normalizeFingerprint(tls);
    // maxCachedSessions: 0 disables TLS session resumption. On a resumed session Node returns an empty
    // peer certificate (no fingerprint256), which made every connection after the first fail the pin check.
    const base = buildConnector({ rejectUnauthorized: false, maxCachedSessions: 0 });
    return new Agent({
      connect: (opts, cb) => {
        base(opts, (err, socket) => {
          if (err || !socket) return cb(err ?? new Error("connect failed"), null);
          const tlsSocket = socket as TLSSocket;
          const cert = typeof tlsSocket.getPeerCertificate === "function" ? tlsSocket.getPeerCertificate() : undefined;
          const actual = cert?.fingerprint256?.replace(/:/g, "").toUpperCase();
          if (!actual) {
            socket.destroy();
            return cb(new ProtectError("TLS fingerprint unavailable (empty peer certificate; session resumed?)"), null);
          }
          if (actual !== expected) {
            socket.destroy();
            return cb(new ProtectError(`TLS fingerprint mismatch (got ${actual})`), null);
          }
          cb(null, socket);
        });
      },
    });
  }
  throw new Error(`unsupported PROTECT_TLS: ${tls}`);
}

export class HttpProtectClient implements ProtectClient {
  private readonly base: string;
  private readonly dispatcher: Dispatcher;
  private readonly gate: RateGate;
  private readonly log: Logger;
  private readonly timeoutMs: number;
  private readonly apiKey: string;

  constructor(opts: HttpProtectClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, "") + "/proxy/protect/integration/v1";
    this.dispatcher = opts.dispatcher ?? buildDispatcher(opts.tls);
    this.gate = new RateGate(opts.maxPerSecond ?? 8);
    this.log = opts.logger.child({ component: "protect" });
    this.timeoutMs = opts.timeoutMs ?? 8000;
    this.apiKey = opts.apiKey;
  }

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    await this.gate.wait();
    const url = this.base + path;
    const started = Date.now();
    try {
      const res = await request(url, {
        method,
        dispatcher: this.dispatcher,
        headers: { "x-api-key": this.apiKey, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        headersTimeout: this.timeoutMs,
        bodyTimeout: this.timeoutMs,
      });
      const text = await res.body.text();
      const ms = Date.now() - started;
      this.log.debug({ method, path, status: res.statusCode, ms, raw: text.slice(0, 4000) }, "protect response");
      if (res.statusCode >= 400) throw new ProtectError(`Protect ${method} ${path} → ${res.statusCode}`, res.statusCode, text);
      if (!text) return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        return text as unknown as T;
      }
    } catch (err) {
      if (err instanceof ProtectError) throw err;
      this.log.debug({ method, path, err }, "protect request failed");
      throw new ProtectError(`Protect ${method} ${path} failed: ${(err as Error).message}`, undefined, err);
    }
  }

  getMetaInfo(): Promise<ProtectMetaInfo> {
    return this.call("GET", "/meta/info");
  }
  getSensors(): Promise<ProtectSensor[]> {
    return this.call("GET", "/sensors");
  }
  getSensor(id: string): Promise<ProtectSensor> {
    return this.call("GET", `/sensors/${encodeURIComponent(id)}`);
  }
  getRelays(): Promise<ProtectRelay[]> {
    return this.call("GET", "/relays");
  }
  getRelay(id: string): Promise<ProtectRelay> {
    return this.call("GET", `/relays/${encodeURIComponent(id)}`);
  }
  getCameras(): Promise<ProtectCamera[]> {
    return this.call("GET", "/cameras");
  }
  activateOutput(relayId: string, outputId: number): Promise<unknown> {
    return this.call("POST", `/relays/${encodeURIComponent(relayId)}/outputs/${outputId}/activate`);
  }
  async close(): Promise<void> {
    await this.dispatcher.close();
  }
}
