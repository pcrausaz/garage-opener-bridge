import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { timingSafeEqual } from "node:crypto";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import { Instance, type DoorUnit } from "../instance.js";
import { MockRegistry } from "../mock/registry.js";
import { DoorBusyError, DoorDirectionError, DoorNotMovingError, DoorUnknownError } from "../door/service.js";
import { ProtectError } from "../protect/types.js";
import { ContractValidator } from "./validation.js";
import { openSse } from "./sse.js";
import { classifyAlarmPayload, stripThumbnails } from "../webhooks/classify.js";
import type { ApiError, DoorCommand } from "../types.js";
import type { MemberIdentity } from "../members.js";
import { AUDIT_KINDS, auditToCsv, type AuditKind } from "../store/db.js";

export interface ServerOptions {
  config: Config;
  logger: Logger;
  /** Live mode: the single instance. */
  instance?: Instance;
  /** Mock mode: per-token registry. */
  registry?: MockRegistry;
  validateResponses?: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    token?: string;
    inst?: Instance;
    member?: MemberIdentity;
  }
  interface FastifyContextConfig {
    operationId?: string;
  }
  interface FastifyInstance {
    routeList: Set<string>;
  }
}

const RESPONSE_SCHEMAS: Record<string, string> = {
  getHealth: "Health",
  getState: "State",
  listDoors: "DoorList",
  setDefaultDoor: "DefaultDoor",
  getDoorState: "State",
  setDoorHold: "Hold",
  getDiscovery: "Discovery",
  setHold: "Hold",
  createInvite: "Invite",
  claimInvite: "InviteClaim",
  mockAction: "State",
};

function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function err(reply: FastifyReply, status: number, error: string, message: string, details?: Record<string, unknown>) {
  const body: ApiError = { error, message };
  if (details) body.details = details;
  return reply.code(status).send(body);
}

function notReady(reply: FastifyReply, inst: Instance) {
  return err(reply, 503, "protect_unavailable", inst.startError ? `bridge not ready: ${inst.startError}` : "bridge starting");
}

export type BridgeServer = Awaited<ReturnType<typeof buildServer>>;

export async function buildServer(o: ServerOptions) {
  const { config } = o;
  const mode = config.bridge.mode;
  const validator = new ContractValidator();
  const validateResponses = o.validateResponses ?? config.validateResponses;
  const httpLog = o.logger.child({ component: "http" });
  if (config.logLevel !== "debug" && config.logLevel !== "trace") httpLog.level = "warn"; // request logging only at debug
  const app = Fastify({ loggerInstance: httpLog, bodyLimit: 1_048_576, trustProxy: config.trustProxy });
  // "METHOD /path" for every registered route (contract tests diff this against the OpenAPI).
  const routeList = new Set<string>();
  app.decorate("routeList", routeList);
  app.addHook("onRoute", (r) => {
    for (const m of Array.isArray(r.method) ? r.method : [r.method]) if (m !== "HEAD") routeList.add(`${m} ${r.url}`);
  });

  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    if (typeof body !== "string" || body.trim() === "") return done(null, undefined);
    try {
      done(null, JSON.parse(body));
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  await app.register(rateLimit, {
    global: true,
    max: 60,
    timeWindow: "1 minute",
    keyGenerator: (req) => req.token ?? req.ip,
    errorResponseBuilder: () => ({ statusCode: 429, error: "rate_limited", message: "too many requests" }),
  });

  const tokenOf = (req: FastifyRequest): string | undefined => {
    const h = req.headers.authorization;
    if (h?.startsWith("Bearer ")) return h.slice(7).trim();
    const q = (req.query as Record<string, unknown>).token;
    return typeof q === "string" && req.url.startsWith("/v1/events") ? q : undefined;
  };

  const isDemoToken = (token: string): boolean =>
    mode === "mock" && token.startsWith(config.bridge.mockTokenPrefix) && token.length >= config.bridge.mockTokenPrefix.length + 1;
  const unauthenticated = (url: string) => !url.startsWith("/v1/") || url.startsWith("/v1/webhooks/") || /^\/v1\/invites\/[^/]+\/claim(\?|$)/.test(url);

  // Authentication is settled in this hook, which runs before the per-route rate limiter, so a request that
  // never presents a valid token is charged to no bucket at all. Failures are counted per source address so
  // that an unauthenticated caller cannot hammer the bridge indefinitely. The count is only ever consulted
  // *after* authentication has been attempted, so a valid admin or member token is never collateral damage —
  // which matters because a household behind a tunnel shares one address.
  const authFailures = new Map<string, { start: number; count: number; warned: boolean }>();
  const AUTH_FAILURE_LIMIT = 30;
  const AUTH_FAILURE_WINDOW_MS = 60_000;
  const noteAuthFailure = (req: FastifyRequest): boolean => {
    const now = Date.now();
    if (authFailures.size > 1024) for (const [k, v] of authFailures) if (now - v.start >= AUTH_FAILURE_WINDOW_MS) authFailures.delete(k);
    const cur = authFailures.get(req.ip);
    const w = !cur || now - cur.start >= AUTH_FAILURE_WINDOW_MS ? { start: now, count: 0, warned: false } : cur;
    w.count++;
    authFailures.set(req.ip, w);
    if (w.count <= AUTH_FAILURE_LIMIT) return false;
    if (!w.warned) {
      w.warned = true;
      httpLog.warn({ ip: req.ip, failures: w.count }, "repeated authentication failures; throttling this address");
    }
    return true;
  };
  const rejectAuth = (req: FastifyRequest, reply: FastifyReply) =>
    noteAuthFailure(req)
      ? err(reply, 429, "rate_limited", "too many failed authentication attempts")
      : err(reply, 401, "unauthorized", "missing or invalid bearer token");

  app.addHook("onRequest", async (req, reply) => {
    if (unauthenticated(req.url)) return;
    const token = tokenOf(req);
    if (!token) return rejectAuth(req, reply);
    let inst: Instance;
    if (o.registry) {
      if (!config.bridge.tokens.some((t) => safeEq(t, token)) && !isDemoToken(token)) return rejectAuth(req, reply);
      inst = await o.registry.get(token);
    } else inst = o.instance!;
    const member = inst.members.authenticate(token) ?? (isDemoToken(token) && !inst.members.isRevoked(token) ? { id: "demo", name: "Demo", kind: "admin" as const } : null);
    if (!member) return rejectAuth(req, reply);
    if (member.id !== "demo") inst.members.touch(member.id);
    req.token = token;
    req.member = member;
    if (!o.registry && !inst.ready && !req.url.startsWith("/v1/audit")) return notReady(reply, inst);
    req.inst = inst;
  });

  if (validateResponses) {
    app.addHook("preSerialization", async (req, _reply, payload) => {
      const name = RESPONSE_SCHEMAS[req.routeOptions.config?.operationId ?? ""];
      if (name && payload && typeof payload === "object" && !("error" in (payload as object))) validator.assert(name, payload);
      return payload;
    });
  }

  app.setErrorHandler((error: Error & { statusCode?: number; validation?: unknown }, _req, reply) => {
    if (error instanceof DoorBusyError) return err(reply, 409, "door_busy", error.message);
    if (error instanceof DoorNotMovingError) return err(reply, 409, "door_not_moving", error.message);
    if (error instanceof DoorDirectionError) return err(reply, 409, "door_direction", error.message);
    if (error instanceof DoorUnknownError || error instanceof ProtectError) return err(reply, 503, "protect_unavailable", error.message);
    if (error.statusCode === 429) return reply.code(429).send({ error: "rate_limited", message: "too many requests" });
    if (error.validation || error.statusCode === 400) return err(reply, 400, "validation", error.message);
    app.log.error({ err: error }, "unhandled");
    return err(reply, 500, "internal", "internal error");
  });

  app.get("/healthz", { config: { operationId: "getHealth", rateLimit: { max: 120, timeWindow: "1 minute", keyGenerator: (req: FastifyRequest) => req.ip } } }, async () => {
    if (o.instance) return o.instance.health();
    return { ok: true, ready: true, mode, version: (await import("../version.js")).VERSION, protect: { ok: true, applicationVersion: "mock" } };
  });

  // Every route comes in two forms (ADR-0020). Without a door id it means the caller's default door and
  // answers in exactly the shape it always had; under /v1/doors/:doorId it names the door and says so in
  // the response. `Target` is which of the two a handler is serving.
  interface Target {
    unit: DoorUnit;
    /** Addressed by id: the response carries `doorId`. */
    scoped: boolean;
  }
  const defaultDoor = (req: FastifyRequest): Target => ({ unit: req.inst!.defaultUnit(req.member?.id), scoped: false });
  /** Answers 404 `unknown_door` itself and returns null when the id names no door. */
  const doorById = (req: FastifyRequest, reply: FastifyReply): Target | null => {
    const id = (req.params as { doorId: string }).doorId;
    const unit = req.inst!.unit(id);
    if (unit) return { unit, scoped: true };
    void err(reply, 404, "unknown_door", `no door ${id}; GET /v1/doors lists them`);
    return null;
  };
  const tagged = <T extends object>(t: Target, body: T): T => (t.scoped ? { ...body, doorId: t.unit.id } : body);

  app.get("/v1/state", { config: { operationId: "getState" } }, async (req) => req.inst!.stateOf(defaultDoor(req).unit));

  app.get("/v1/doors", { config: { operationId: "listDoors" } }, async (req) => ({ doors: req.inst!.doorList(), defaultDoorId: defaultDoor(req).unit.id }));

  app.put<{ Body: { doorId?: unknown } | undefined }>("/v1/doors/default", { config: { operationId: "setDefaultDoor" } }, async (req, reply) => {
    const r = validator.validate("DefaultDoor", req.body);
    if (!r.ok) return err(reply, 400, "validation", r.errors);
    const doorId = req.body!.doorId as string;
    if (!req.inst!.unit(doorId)) return err(reply, 400, "validation", `no door ${doorId}; GET /v1/doors lists them`);
    req.inst!.setDefaultDoor(req.member!.id, doorId);
    return { doorId };
  });

  app.get<{ Params: { doorId: string } }>("/v1/doors/:doorId/state", { config: { operationId: "getDoorState" } }, async (req, reply) => {
    const t = doorById(req, reply);
    return t ? tagged(t, req.inst!.stateOf(t.unit)) : reply;
  });

  type CommandQuery = { wait?: string; source?: string };
  const runCommand = async (t: Target, command: Exclude<DoorCommand, "stop">, req: FastifyRequest<{ Querystring: CommandQuery }>, reply: FastifyReply) => {
    const wait = req.query.wait === undefined ? true : !/^(false|0|no)$/i.test(req.query.wait);
    const source = (req.query.source ?? "api").slice(0, 32);
    const result = tagged(t, await t.unit.door[command]({ source, wait, member: req.member?.name }));
    if ("accepted" in result) {
      if (validateResponses) validator.assert("CommandAccepted", result);
      return reply.code(202).send(result);
    }
    if (validateResponses) validator.assert("CommandResult", result);
    return result;
  };
  // No `wait`: a stop is answered the moment the press lands. There is nothing to wait for — the tilt sensor
  // reports the same contact for a door stopped part-way as for one standing fully open (ADR-0015).
  const runStop = async (t: Target, req: FastifyRequest<{ Querystring: CommandQuery }>) => {
    const source = (req.query.source ?? "api").slice(0, 32);
    const result = tagged(t, await t.unit.door.stopDoor({ source, member: req.member?.name }));
    if (validateResponses) validator.assert("CommandResult", result);
    return result;
  };
  const commandLimit = { max: 10, timeWindow: "1 minute" };

  const doorRoute = (command: Exclude<DoorCommand, "stop">) => {
    app.post<{ Querystring: CommandQuery }>(`/v1/door/${command}`, { config: { operationId: `${command}Door`, rateLimit: commandLimit } }, async (req, reply) =>
      runCommand(defaultDoor(req), command, req, reply),
    );
    app.post<{ Params: { doorId: string }; Querystring: CommandQuery }>(`/v1/doors/:doorId/${command}`, { config: { operationId: `${command}DoorById`, rateLimit: commandLimit } }, async (req, reply) => {
      const t = doorById(req, reply);
      return t ? runCommand(t, command, req, reply) : reply;
    });
  };
  doorRoute("open");
  doorRoute("close");
  doorRoute("toggle");

  app.post<{ Querystring: CommandQuery }>("/v1/door/stop", { config: { operationId: "stopDoor", rateLimit: commandLimit } }, async (req) => runStop(defaultDoor(req), req));
  app.post<{ Params: { doorId: string }; Querystring: CommandQuery }>("/v1/doors/:doorId/stop", { config: { operationId: "stopDoorById", rateLimit: commandLimit } }, async (req, reply) => {
    const t = doorById(req, reply);
    return t ? runStop(t, req) : reply;
  });

  app.post<{ Params: { id: string } }>("/v1/auto-actions/:id/undo", { config: { operationId: "undoAutoAction", rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const result = await req.inst!.undo(req.params.id);
    if (!result) return err(reply, 404, "undo_expired", "unknown auto-action or undo window elapsed");
    if (validateResponses) validator.assert("CommandResult", result);
    return result;
  });

  const setHold = (t: Target, req: FastifyRequest<{ Body: { minutes?: unknown } }>, reply: FastifyReply) => {
    const r = validator.validate("HoldRequest", req.body);
    if (!r.ok) return err(reply, 400, "validation", r.errors);
    return tagged(t, t.unit.hold.set(req.body.minutes as number, "app", req.member?.name));
  };
  const clearHold = (t: Target, req: FastifyRequest, reply: FastifyReply) => {
    t.unit.hold.clear("app", req.member?.name);
    return reply.code(204).send();
  };
  app.post<{ Body: { minutes?: unknown } }>("/v1/hold", { config: { operationId: "setHold" } }, async (req, reply) => setHold(defaultDoor(req), req, reply));
  app.delete("/v1/hold", { config: { operationId: "clearHold" } }, async (req, reply) => clearHold(defaultDoor(req), req, reply));
  app.put<{ Params: { doorId: string }; Body: { minutes?: unknown } }>("/v1/doors/:doorId/hold", { config: { operationId: "setDoorHold" } }, async (req, reply) => {
    const t = doorById(req, reply);
    return t ? setHold(t, req, reply) : reply;
  });
  app.delete<{ Params: { doorId: string } }>("/v1/doors/:doorId/hold", { config: { operationId: "clearDoorHold" } }, async (req, reply) => {
    const t = doorById(req, reply);
    return t ? clearHold(t, req, reply) : reply;
  });

  // Each stream pins a socket, five bus listeners and a heartbeat timer for as long as it is open, so the
  // count is capped per token and overall; without it one authenticated client can exhaust the process.
  const sseOpen = new Map<string, number>();
  let sseTotal = 0;
  app.get<{ Querystring: { doors?: string } }>("/v1/events", { config: { operationId: "streamEvents", rateLimit: false } }, async (req, reply) => {
    if (req.query.doors !== undefined && req.query.doors !== "all") return err(reply, 400, "validation", "doors must be `all` or omitted");
    const key = req.token!;
    const perToken = sseOpen.get(key) ?? 0;
    if (sseTotal >= config.sse.maxTotal || perToken >= config.sse.maxPerToken) {
      return err(reply, 429, "rate_limited", "too many open event streams");
    }
    sseOpen.set(key, perToken + 1);
    sseTotal++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      sseTotal--;
      const n = (sseOpen.get(key) ?? 1) - 1;
      if (n <= 0) sseOpen.delete(key);
      else sseOpen.set(key, n);
    };
    try {
      const inst = req.inst!;
      const stream = openSse(reply);
      if (req.query.doors === "all") {
        for (const u of inst.units) {
          stream.send("state", { ...inst.stateOf(u), doorId: u.id });
          stream.follow(u.bus, u.id);
        }
      } else {
        // One door only, and never another's: a client that knows a single door applies every event to it.
        // Which door that is can change under an open stream (another phone on the same token picks a new
        // default), and the routes without a door id switch at once — so the stream must switch with them.
        const memberId = req.member!.id;
        let unit = inst.defaultUnit(memberId);
        stream.send("state", inst.stateOf(unit));
        let off = stream.follow(unit.bus);
        const onDefault = (changed: string) => {
          const next = inst.defaultUnit(memberId);
          if (changed !== memberId || next === unit) return;
          off();
          unit = next;
          stream.send("state", inst.stateOf(unit));
          off = stream.follow(unit.bus);
        };
        inst.defaults.on("changed", onDefault);
        stream.onClose(() => inst.defaults.off("changed", onDefault));
      }
      await new Promise<void>((resolve) => {
        reply.raw.on("close", resolve);
        reply.raw.on("error", resolve);
      });
    } finally {
      release();
    }
    return reply;
  });

  /** Shared parsing for both audit routes; returns an error string instead of throwing. */
  const auditQuery = (q: { limit?: string; before?: string; kind?: string }, maxLimit: number, defaultLimit: number) => {
    const limit = q.limit ? Number(q.limit) : defaultLimit;
    const before = q.before ? Number(q.before) : undefined;
    if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) return { error: `limit must be an integer between 1 and ${maxLimit}` };
    if (before !== undefined && !Number.isInteger(before)) return { error: "before must be an integer" };
    let kinds: AuditKind[] | undefined;
    if (q.kind) {
      kinds = q.kind.split(",").map((k) => k.trim()).filter(Boolean) as AuditKind[];
      const bad = kinds.find((k) => !(AUDIT_KINDS as readonly string[]).includes(k));
      if (bad) return { error: `unknown kind ${bad}; expected one of ${AUDIT_KINDS.join(", ")}` };
      if (kinds.length === 0) kinds = undefined;
    }
    return { limit, before, kinds };
  };

  app.get<{ Querystring: { limit?: string; before?: string; kind?: string } }>("/v1/audit", { config: { operationId: "listAudit" } }, async (req, reply) => {
    const q = auditQuery(req.query, 500, 50);
    if (q.error) return err(reply, 400, "validation", q.error);
    const entries = req.inst!.store.listAudit(q.limit!, q.before, q.kinds);
    if (validateResponses) for (const e of entries) validator.assert("AuditEntry", e);
    return { entries };
  });

  // Separate path rather than ?format=csv on /v1/audit: one media type per operation keeps the generated
  // Swift client's response handling (and the contract validator) simple.
  app.get<{ Querystring: { limit?: string; before?: string; kind?: string } }>("/v1/audit.csv", { config: { operationId: "exportAuditCsv" } }, async (req, reply) => {
    const q = auditQuery(req.query, 20_000, 5000);
    if (q.error) return err(reply, 400, "validation", q.error);
    const entries = req.inst!.store.listAudit(q.limit!, q.before, q.kinds);
    const doors = req.inst!.units.length > 1 ? new Map(req.inst!.doorList().map((d) => [d.id, d.name])) : undefined;
    const stamp = new Date().toISOString().slice(0, 10);
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="garage-activity-${stamp}.csv"`)
      .send(auditToCsv(entries, doors));
  });

  app.get("/v1/discovery", { config: { operationId: "getDiscovery" } }, async (req) => {
    // "No suggestion" is an absent field, not a null one: the contract says a mapping or nothing.
    const { suggested, suggestedDoors, ...rest } = await req.inst!.discoveryNow(defaultDoor(req).unit);
    return { ...rest, ...(suggested ? { suggested } : {}), ...(suggestedDoors ? { suggestedDoors } : {}) };
  });

  const webhook = async (req: FastifyRequest<{ Params: { secret: string } }>, reply: FastifyReply) => {
    const secret = config.bridge.webhookSecret;
    if (!secret || !safeEq(secret, req.params.secret)) return reply.code(404).send();
    const inst = o.instance ?? (o.registry ? await o.registry.get(config.bridge.tokens[0] ?? `${config.bridge.mockTokenPrefix}webhook`) : undefined);
    if (!inst) return reply.code(404).send();
    if (!inst.ready) return notReady(reply, inst);
    const body = req.method === "POST" ? req.body : undefined;
    const events = classifyAlarmPayload(body, req.query as Record<string, unknown>);
    app.log.debug({ payload: stripThumbnails(body), query: req.query, events }, "alarm manager webhook");
    for (const e of events) inst.bus.emit("protect-event", e);
    return reply.code(204).send();
  };
  app.post<{ Params: { secret: string } }>("/v1/webhooks/alarm-manager/:secret", { config: { operationId: "alarmManagerWebhookPost", rateLimit: { max: 120, timeWindow: "1 minute" } } }, webhook);
  app.get<{ Params: { secret: string } }>("/v1/webhooks/alarm-manager/:secret", { config: { operationId: "alarmManagerWebhookGet", rateLimit: { max: 120, timeWindow: "1 minute" } } }, webhook);
  // Protect may send multipart when "attach thumbnail" is on; accept and ignore the body.
  app.addContentTypeParser(/^multipart\//, { parseAs: "buffer" }, (_req, _body, done) => done(null, undefined));
  app.addContentTypeParser("*", { parseAs: "string" }, (_req, body, done) => {
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(null, undefined);
    }
  });

  const requestOrigin = (req: FastifyRequest) => `${req.protocol}://${req.headers.host ?? `localhost:${config.port}`}`;

  const validName = (v: unknown): v is string => typeof v === "string" && v.trim().length >= 1 && v.length <= 48;

  app.post<{ Body: { publicUrl?: string; name?: unknown; defaultDoorId?: unknown } | undefined }>("/v1/invites", { config: { operationId: "createInvite", rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    if (req.member!.kind !== "admin") return err(reply, 403, "forbidden", "an admin token is required to create invites");
    const rawName = req.body?.name;
    if (rawName !== undefined && !validName(rawName)) return err(reply, 400, "validation", "name must be 1-48 chars");
    const name = rawName === undefined ? undefined : rawName.trim();
    const defaultDoorId = req.body?.defaultDoorId;
    if (defaultDoorId !== undefined && (typeof defaultDoorId !== "string" || !req.inst!.unit(defaultDoorId))) return err(reply, 400, "validation", "defaultDoorId must be one of the ids in GET /v1/doors");
    const bridgeUrl = (req.body?.publicUrl ?? config.publicUrl ?? requestOrigin(req)).replace(/\/+$/, "");
    const inv = req.inst!.members.createInvite(req.member!.id, defaultDoorId);
    req.inst!.store.audit({ kind: "member", source: "admin", member: req.member!.name, outcome: "ok", detail: name ? `invite created for ${name}` : "invite created" });
    const expiresUnix = Math.floor(Date.parse(inv.expiresAt) / 1000);
    let joinUrl = `garageopener://join?v=1&b=${encodeURIComponent(bridgeUrl)}&c=${inv.code}&e=${expiresUnix}`;
    if (name) joinUrl += `&n=${encodeURIComponent(name)}`;
    return reply.code(201).send({ code: inv.code, expiresAt: inv.expiresAt, bridgeUrl, joinUrl, ...(name ? { name } : {}) });
  });

  app.post<{ Params: { code: string }; Body: { deviceName?: unknown } | undefined }>(
    "/v1/invites/:code/claim",
    { config: { operationId: "claimInvite", rateLimit: { max: 5, timeWindow: "1 minute", keyGenerator: (req) => req.ip } } },
    async (req, reply) => {
      const name = req.body?.deviceName;
      if (!validName(name)) return err(reply, 400, "validation", "deviceName (1-48 chars) is required");
      let inst: Instance | undefined;
      let ownerToken: string | undefined;
      if (o.registry) {
        const found = await o.registry.findByInvite(req.params.code);
        inst = found?.inst;
        ownerToken = found?.token;
      } else inst = o.instance;
      if (!inst) return err(reply, 404, "not_found", "unknown, expired or already claimed code");
      const claimed = inst.members.claim(req.params.code, name, o.registry ? config.bridge.mockTokenPrefix : "");
      if (!claimed) return err(reply, 404, "not_found", "unknown, expired or already claimed code");
      if (o.registry && ownerToken) o.registry.alias(claimed.token, ownerToken);
      // The new phone starts on the door the invite named, else the inviter's; `mapping` is that door's.
      const unit = inst.ready ? inst.defaultUnit(claimed.member.id) : undefined;
      const bridge: { version: string; mode: "live" | "mock"; publicUrl?: string } = { version: (await import("../version.js")).VERSION, mode };
      if (config.publicUrl) bridge.publicUrl = config.publicUrl;
      return { token: claimed.token, member: claimed.member, bridge, ...(unit ? { mapping: unit.mapping, doors: inst.doorList(), defaultDoorId: unit.id } : {}) };
    },
  );

  app.get("/v1/members", { config: { operationId: "listMembers" } }, async (req) => {
    const me = req.member!;
    const all = req.inst!.members.list();
    const visible = me.kind === "admin" ? all : all.filter((m) => m.id === me.id);
    const members = visible.map((m) => ({ ...m, isCurrent: m.id === me.id }));
    if (validateResponses) for (const m of members) validator.assert("Member", m);
    return { members };
  });

  app.patch<{ Params: { id: string }; Body: { name?: unknown } | undefined }>("/v1/members/:id", { config: { operationId: "renameMember" } }, async (req, reply) => {
    const name = req.body?.name;
    if (!validName(name)) return err(reply, 400, "validation", "name (1-48 chars) is required");
    const r = req.inst!.members.rename(req.params.id, name, req.member!);
    if (r === "not_found") return err(reply, 404, "not_found", "unknown member");
    if (r === "forbidden") return err(reply, 403, "forbidden", "admin token required, or rename your own phone");
    const member = { ...r, isCurrent: r.id === req.member!.id };
    if (validateResponses) validator.assert("Member", member);
    return member;
  });

  app.delete<{ Params: { id: string } }>("/v1/members/:id", { config: { operationId: "revokeMember" } }, async (req, reply) => {
    const r = req.inst!.members.revoke(req.params.id, req.member!);
    if (r === "not_found") return err(reply, 404, "not_found", "unknown member");
    if (r === "forbidden") return err(reply, 403, "forbidden", "admin token required, or revoke your own token");
    return reply.code(204).send();
  });

  app.post<{ Params: { action: string }; Body: { plate?: string; doorId?: string } | undefined }>("/v1/mock/:action", { config: { operationId: "mockAction" } }, async (req, reply) => {
    if (mode !== "mock") return err(reply, 404, "not_found", "not in mock mode");
    const allowed = ["vehicle-arrived", "vehicle-left", "plate-seen", "reverse-next-close", "reset"];
    if (!allowed.includes(req.params.action)) return err(reply, 400, "validation", `action must be one of ${allowed.join(", ")}`);
    const doorId = req.body?.doorId;
    const unit = doorId === undefined ? defaultDoor(req).unit : req.inst!.unit(doorId);
    if (!unit) return err(reply, 404, "unknown_door", `no door ${doorId}; GET /v1/doors lists them`);
    try {
      return await req.inst!.mockAction(req.params.action, req.body ?? {}, unit, doorId !== undefined);
    } catch (e) {
      if (e instanceof RangeError) return err(reply, 400, "validation", e.message);
      throw e;
    }
  });

  app.setNotFoundHandler((_req, reply) => err(reply, 404, "not_found", "no such route"));
  return app;
}
