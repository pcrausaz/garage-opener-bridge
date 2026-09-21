import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { timingSafeEqual } from "node:crypto";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import { Instance } from "../instance.js";
import { MockRegistry } from "../mock/registry.js";
import { DoorBusyError, DoorUnknownError } from "../door/service.js";
import { ProtectError } from "../protect/types.js";
import { ContractValidator } from "./validation.js";
import { attachSse } from "./sse.js";
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
  const app = Fastify({ loggerInstance: httpLog, bodyLimit: 1_048_576 });
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

  app.addHook("onRequest", async (req, reply) => {
    if (unauthenticated(req.url)) return;
    const token = tokenOf(req);
    if (!token) return err(reply, 401, "unauthorized", "missing or invalid bearer token");
    let inst: Instance;
    if (o.registry) {
      if (!config.bridge.tokens.some((t) => safeEq(t, token)) && !isDemoToken(token)) return err(reply, 401, "unauthorized", "missing or invalid bearer token");
      inst = await o.registry.get(token);
    } else inst = o.instance!;
    const member = inst.members.authenticate(token) ?? (isDemoToken(token) && !inst.members.isRevoked(token) ? { id: "demo", name: "Demo", kind: "admin" as const } : null);
    if (!member) return err(reply, 401, "unauthorized", "missing or invalid bearer token");
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
    if (error instanceof DoorUnknownError || error instanceof ProtectError) return err(reply, 503, "protect_unavailable", error.message);
    if (error.statusCode === 429) return reply.code(429).send({ error: "rate_limited", message: "too many requests" });
    if (error.validation || error.statusCode === 400) return err(reply, 400, "validation", error.message);
    app.log.error({ err: error }, "unhandled");
    return err(reply, 500, "internal", "internal error");
  });

  app.get("/healthz", { config: { operationId: "getHealth", rateLimit: false } }, async () => {
    if (o.instance) return o.instance.health();
    return { ok: true, ready: true, mode, version: (await import("../version.js")).VERSION, protect: { ok: true, applicationVersion: "mock" } };
  });

  app.get("/v1/state", { config: { operationId: "getState" } }, async (req) => req.inst!.state());

  const doorRoute = (command: DoorCommand) =>
    app.post<{ Querystring: { wait?: string; source?: string } }>(
      `/v1/door/${command}`,
      { config: { operationId: `${command}Door`, rateLimit: { max: 10, timeWindow: "1 minute" } } },
      async (req, reply) => {
        const wait = req.query.wait === undefined ? true : !/^(false|0|no)$/i.test(req.query.wait);
        const source = (req.query.source ?? "api").slice(0, 32);
        const result = await req.inst!.door[command]({ source, wait, member: req.member?.name });
        if ("accepted" in result) {
          if (validateResponses) validator.assert("CommandAccepted", result);
          return reply.code(202).send(result);
        }
        if (validateResponses) validator.assert("CommandResult", result);
        return result;
      },
    );
  doorRoute("open");
  doorRoute("close");
  doorRoute("toggle");

  app.post<{ Params: { id: string } }>("/v1/auto-actions/:id/undo", { config: { operationId: "undoAutoAction", rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const lpr = req.inst!.lpr;
    const result = lpr ? await lpr.undo(req.params.id) : null;
    if (!result) return err(reply, 404, "undo_expired", "unknown auto-action or undo window elapsed");
    if (validateResponses) validator.assert("CommandResult", result);
    return result;
  });

  app.post<{ Body: { minutes?: unknown } }>("/v1/hold", { config: { operationId: "setHold" } }, async (req, reply) => {
    const r = validator.validate("HoldRequest", req.body);
    if (!r.ok) return err(reply, 400, "validation", r.errors);
    return req.inst!.hold.set(req.body.minutes as number, "app", req.member?.name);
  });
  app.delete("/v1/hold", { config: { operationId: "clearHold" } }, async (req, reply) => {
    req.inst!.hold.clear("app", req.member?.name);
    return reply.code(204).send();
  });

  app.get("/v1/events", { config: { operationId: "streamEvents", rateLimit: false } }, async (req, reply) => {
    attachSse(reply, req.inst!.bus, req.inst!.state());
    await new Promise<void>((resolve) => reply.raw.on("close", resolve));
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
    const stamp = new Date().toISOString().slice(0, 10);
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="garage-activity-${stamp}.csv"`)
      .send(auditToCsv(entries));
  });

  app.get("/v1/discovery", { config: { operationId: "getDiscovery" } }, async (req) => req.inst!.discoveryNow());

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

  app.post<{ Body: { publicUrl?: string; name?: unknown } | undefined }>("/v1/invites", { config: { operationId: "createInvite", rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    if (req.member!.kind !== "admin") return err(reply, 403, "forbidden", "an admin token is required to create invites");
    const rawName = req.body?.name;
    if (rawName !== undefined && !validName(rawName)) return err(reply, 400, "validation", "name must be 1-48 chars");
    const name = rawName === undefined ? undefined : rawName.trim();
    const bridgeUrl = (req.body?.publicUrl ?? config.publicUrl ?? requestOrigin(req)).replace(/\/+$/, "");
    const inv = req.inst!.members.createInvite(req.member!.id);
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
      const mapping = inst.ready ? inst.door.mapping : undefined;
      const bridge: { version: string; mode: "live" | "mock"; publicUrl?: string } = { version: (await import("../version.js")).VERSION, mode };
      if (config.publicUrl) bridge.publicUrl = config.publicUrl;
      return { token: claimed.token, member: claimed.member, bridge, ...(mapping ? { mapping } : {}) };
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

  app.post<{ Params: { action: string }; Body: { plate?: string } | undefined }>("/v1/mock/:action", { config: { operationId: "mockAction" } }, async (req, reply) => {
    if (mode !== "mock") return err(reply, 404, "not_found", "not in mock mode");
    const allowed = ["vehicle-arrived", "vehicle-left", "plate-seen", "reverse-next-close", "reset"];
    if (!allowed.includes(req.params.action)) return err(reply, 400, "validation", `action must be one of ${allowed.join(", ")}`);
    try {
      return await req.inst!.mockAction(req.params.action, req.body ?? {});
    } catch (e) {
      if (e instanceof RangeError) return err(reply, 400, "validation", e.message);
      throw e;
    }
  });

  app.setNotFoundHandler((_req, reply) => err(reply, 404, "not_found", "no such route"));
  return app;
}
