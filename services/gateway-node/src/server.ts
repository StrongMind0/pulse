import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import websocket from "@fastify/websocket";
import client from "prom-client";
import { z } from "zod";
import type { Authenticator, LoginRateLimiter, Session } from "./auth.js";
import type { Hub } from "./hub.js";
import { UpstreamError, type Upstream } from "./upstream.js";

export interface Deps {
  auth: Authenticator;
  limiter: LoginRateLimiter;
  hub: Hub;
  upstream: Upstream;
  corsOrigin: string;
  brokerConnected: () => boolean;
  logLevel?: string;
}

declare module "fastify" {
  interface FastifyRequest {
    session?: Session;
  }
}

const DEVICE_ID = /^[a-z0-9][a-z0-9-]{1,62}$/;
const WS_AUTH_TIMEOUT_MS = 5000;
const WS_PING_MS = 30_000;

const loginBody = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(256) });
const readingsQuery = z.object({
  since: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(5000).optional(),
});
const alertsQuery = z.object({
  state: z.enum(["FIRING", "RESOLVED"]).optional(),
  deviceId: z.string().regex(DEVICE_ID).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});
const wsMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("auth"), token: z.string().min(1).max(4096) }),
  z.object({ type: z.literal("subscribe"), devices: z.array(z.string().regex(DEVICE_ID)).max(500).nullable() }),
]);

export async function buildServer(deps: Deps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: deps.logLevel ?? "info", redact: ["req.headers.authorization", "body.password"] },
    bodyLimit: 16 * 1024,
    trustProxy: false,
  });

  // ---- metrics -------------------------------------------------------------
  const registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry, prefix: "pulse_gateway_" });
  const httpDuration = new client.Histogram({
    name: "pulse_gateway_http_request_seconds",
    help: "HTTP request latency",
    labelNames: ["method", "route", "status"],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [registry],
  });
  const loginFailures = new client.Counter({ name: "pulse_gateway_login_failures_total", help: "Failed logins", registers: [registry] });
  const upstreamErrors = new client.Counter({
    name: "pulse_gateway_upstream_errors_total",
    help: "Failed calls to internal services",
    labelNames: ["service", "status"],
    registers: [registry],
  });
  new client.Gauge({
    name: "pulse_gateway_ws_clients",
    help: "Connected, authenticated WebSocket clients",
    registers: [registry],
    collect() {
      this.set(deps.hub.stats().clients);
    },
  });
  new client.Gauge({
    name: "pulse_gateway_ws_messages_dropped",
    help: "Readings shed for slow WebSocket clients",
    registers: [registry],
    collect() {
      this.set(deps.hub.stats().dropped);
    },
  });

  app.addHook("onResponse", async (req, reply) => {
    httpDuration.observe(
      { method: req.method, route: req.routeOptions.url ?? "unmatched", status: String(reply.statusCode) },
      reply.elapsedTime / 1000,
    );
  });

  // ---- CORS + security headers --------------------------------------------
  app.addHook("onRequest", async (req, reply) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    reply.header("cache-control", "no-store");
    if (req.headers.origin === deps.corsOrigin) {
      reply.header("access-control-allow-origin", deps.corsOrigin);
      reply.header("vary", "origin");
      reply.header("access-control-allow-headers", "authorization, content-type");
      reply.header("access-control-allow-methods", "GET, POST, OPTIONS");
    }
    if (req.method === "OPTIONS") return reply.code(204).send();
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    if (err instanceof UpstreamError) {
      upstreamErrors.inc({ service: err.service, status: String(err.status) });
      const code = err.status === 404 ? "not_found" : err.status === 400 ? "bad_request" : "upstream_unavailable";
      return reply.code(err.status).send({ error: code });
    }
    if (err instanceof z.ZodError) {
      return reply.code(400).send({ error: "invalid_request", issues: err.issues.map((i) => i.path.join(".") + ": " + i.message) });
    }
    if (err.statusCode && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: err.message });
    }
    req.log.error({ err }, "unhandled error");
    return reply.code(500).send({ error: "internal_error" });
  });

  // ---- auth ----------------------------------------------------------------
  async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const session = token ? await deps.auth.verify(token) : null;
    if (!session) {
      await reply.code(401).send({ error: "unauthorized" });
      return;
    }
    req.session = session;
  }

  app.post("/api/auth/login", async (req, reply) => {
    const key = req.ip;
    if (deps.limiter.isLocked(key)) {
      return reply.code(429).send({ error: "too_many_attempts" });
    }
    const body = loginBody.parse(req.body);
    if (!(await deps.auth.checkPassword(body.username, body.password))) {
      deps.limiter.recordFailure(key);
      loginFailures.inc();
      req.log.warn({ user: body.username }, "login failed");
      return reply.code(401).send({ error: "invalid_credentials" });
    }
    deps.limiter.reset(key);
    const { token, expiresAt } = await deps.auth.issue(body.username);
    return { token, expiresAt, user: body.username };
  });

  // ---- health + metrics (unauthenticated, no sensitive data) ---------------
  app.get("/healthz", async () => ({
    status: "ok",
    broker: deps.brokerConnected() ? "connected" : "disconnected",
    ws: deps.hub.stats(),
  }));
  app.get("/metrics", async (_req, reply) => {
    reply.header("content-type", registry.contentType);
    return registry.metrics();
  });

  // ---- authenticated API (backend-for-frontend) ----------------------------
  await app.register(async (api) => {
    api.addHook("preHandler", requireAuth);

    api.get("/api/me", async (req) => ({ user: req.session!.sub, expiresAt: req.session!.exp * 1000 }));

    api.get("/api/devices", async () => deps.upstream.get("ingest", "/api/v1/devices"));

    api.get<{ Params: { id: string } }>("/api/devices/:id/readings", async (req, reply) => {
      if (!DEVICE_ID.test(req.params.id)) return reply.code(400).send({ error: "invalid_device_id" });
      const q = readingsQuery.parse(req.query);
      const qs = new URLSearchParams();
      if (q.since !== undefined) qs.set("since", String(q.since));
      if (q.limit !== undefined) qs.set("limit", String(q.limit));
      return deps.upstream.get("ingest", `/api/v1/devices/${req.params.id}/readings?${qs}`);
    });

    api.get("/api/alerts", async (req) => {
      const q = alertsQuery.parse(req.query);
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(q)) if (v !== undefined) qs.set(k, String(v));
      return deps.upstream.get("rules", `/api/v1/alerts?${qs}`);
    });

    api.post<{ Params: { id: string } }>("/api/alerts/:id/ack", async (req, reply) => {
      if (!/^[0-9a-f-]{36}$/.test(req.params.id)) return reply.code(400).send({ error: "invalid_alert_id" });
      // Identity comes from the verified token, never from the request body.
      return deps.upstream.post("rules", `/api/v1/alerts/${req.params.id}/ack`, { by: req.session!.sub });
    });

    api.get("/api/rules", async () => deps.upstream.get("rules", "/api/v1/rules"));
  });

  // ---- realtime --------------------------------------------------------------
  await app.register(websocket, { options: { maxPayload: 8 * 1024 } });

  app.get("/ws", { websocket: true }, (socket, req) => {
    // Browsers cannot set an Authorization header on a WebSocket, and tokens
    // in query strings end up in access logs, so the client authenticates
    // with its first message instead.
    let authed = false;
    let alive = true;
    const authTimer = setTimeout(() => socket.close(4401, "auth timeout"), WS_AUTH_TIMEOUT_MS);
    const ping = setInterval(() => {
      if (!alive) return socket.terminate(); // half-open TCP: peer vanished without a FIN
      alive = false;
      socket.ping();
    }, WS_PING_MS);

    socket.on("pong", () => {
      alive = true;
    });

    socket.on("message", async (raw) => {
      let msg: z.infer<typeof wsMessage>;
      try {
        msg = wsMessage.parse(JSON.parse(raw.toString()));
      } catch {
        socket.close(4400, "bad message");
        return;
      }
      if (msg.type === "auth") {
        if (authed) return;
        const session = await deps.auth.verify(msg.token);
        if (!session) {
          socket.close(4401, "unauthorized");
          return;
        }
        authed = true;
        clearTimeout(authTimer);
        deps.hub.add(socket, session.sub);
        socket.send(JSON.stringify({ type: "ready", user: session.sub }));
        req.log.info({ user: session.sub }, "ws client connected");
        return;
      }
      if (!authed) {
        socket.close(4401, "unauthorized");
        return;
      }
      deps.hub.setFilter(socket, msg.devices);
    });

    socket.on("close", () => {
      clearTimeout(authTimer);
      clearInterval(ping);
      deps.hub.remove(socket);
    });
  });

  return app;
}
