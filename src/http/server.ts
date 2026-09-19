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
  }
  interface FastifyContextConfig {
    operationId?: string;
  }
}

const RESPONSE_SCHEMAS: Record<string, string> = {
  getHealth: "Health",
  getState: "State",
  getDiscovery: "Discovery",
  setHold: "Hold",
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

export type BridgeServer = Awaited<ReturnType<typeof buildServer>>;

export async function buildServer(o: ServerOptions) {
  const { config } = o;
  const mode = config.bridge.mode;
  const validator = new ContractValidator();
  const validateResponses = o.validateResponses ?? config.validateResponses;
  const httpLog = o.logger.child({ component: "http" });
  if (config.logLevel !== "debug" && config.logLevel !== "trace") httpLog.level = "warn"; // request logging only at debug
  const app = Fastify({ loggerInstance: httpLog, bodyLimit: 1_048_576 });

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

  const accepts = (token: string): boolean => {
    if (config.bridge.tokens.some((t) => safeEq(t, token))) return true;
    return mode === "mock" && token.startsWith(config.bridge.mockTokenPrefix) && token.length >= config.bridge.mockTokenPrefix.length + 1;
  };

  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/v1/") || req.url.startsWith("/v1/webhooks/")) return;
    const token = tokenOf(req);
    if (!token || !accepts(token)) return err(reply, 401, "unauthorized", "missing or invalid bearer token");
    req.token = token;
    if (o.registry) req.inst = await o.registry.get(token);
    else req.inst = o.instance!;
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
    return { ok: true, mode, version: (await import("../version.js")).VERSION, protect: { ok: true, applicationVersion: "mock" } };
  });

  app.get("/v1/state", { config: { operationId: "getState" } }, async (req) => req.inst!.state());

  const doorRoute = (command: DoorCommand) =>
    app.post<{ Querystring: { wait?: string; source?: string } }>(
      `/v1/door/${command}`,
      { config: { operationId: `${command}Door`, rateLimit: { max: 10, timeWindow: "1 minute" } } },
      async (req, reply) => {
        const wait = req.query.wait === undefined ? true : !/^(false|0|no)$/i.test(req.query.wait);
        const source = (req.query.source ?? "api").slice(0, 32);
        const result = await req.inst!.door[command]({ source, wait });
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

  app.post<{ Body: { minutes?: unknown } }>("/v1/hold", { config: { operationId: "setHold" } }, async (req, reply) => {
    const r = validator.validate("HoldRequest", req.body);
    if (!r.ok) return err(reply, 400, "validation", r.errors);
    return req.inst!.hold.set(req.body.minutes as number, req.token && config.bridge.tokens.includes(req.token) ? "app" : "app");
  });
  app.delete("/v1/hold", { config: { operationId: "clearHold" } }, async (req, reply) => {
    req.inst!.hold.clear("app");
    return reply.code(204).send();
  });

  app.get("/v1/events", { config: { operationId: "streamEvents", rateLimit: false } }, async (req, reply) => {
    attachSse(reply, req.inst!.bus, req.inst!.state());
    await new Promise<void>((resolve) => reply.raw.on("close", resolve));
    return reply;
  });

  app.get<{ Querystring: { limit?: string; before?: string } }>("/v1/audit", { config: { operationId: "listAudit" } }, async (req, reply) => {
    const limit = req.query.limit ? Number(req.query.limit) : 50;
    const before = req.query.before ? Number(req.query.before) : undefined;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500 || (before !== undefined && !Number.isInteger(before))) return err(reply, 400, "validation", "invalid limit/before");
    const entries = req.inst!.store.listAudit(limit, before);
    if (validateResponses) for (const e of entries) validator.assert("AuditEntry", e);
    return { entries };
  });

  app.get("/v1/discovery", { config: { operationId: "getDiscovery" } }, async (req) => req.inst!.discoveryNow());

  const webhook = async (req: FastifyRequest<{ Params: { secret: string } }>, reply: FastifyReply) => {
    const secret = config.bridge.webhookSecret;
    if (!secret || !safeEq(secret, req.params.secret)) return reply.code(404).send();
    const inst = o.instance ?? (o.registry ? await o.registry.get(config.bridge.tokens[0] ?? `${config.bridge.mockTokenPrefix}webhook`) : undefined);
    if (!inst) return reply.code(404).send();
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
