import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { Authenticator, LoginRateLimiter } from "./auth.js";
import { Hub } from "./hub.js";
import { buildServer } from "./server.js";
import { UpstreamError, type Upstream } from "./upstream.js";

const ALERT_ID = "0b8e7a52-6f3e-4c1a-9a51-2d2b0f6c9e11";

class FakeUpstream implements Upstream {
  calls: { method: string; service: string; path: string; body?: unknown }[] = [];
  failWith: UpstreamError | null = null;
  async get(service: "ingest" | "rules", path: string) {
    this.calls.push({ method: "GET", service, path });
    if (this.failWith) throw this.failWith;
    return { ok: true, service, path };
  }
  async post(service: "rules", path: string, body: unknown) {
    this.calls.push({ method: "POST", service, path, body });
    if (this.failWith) throw this.failWith;
    return { acknowledgedBy: (body as { by: string }).by };
  }
}

let app: FastifyInstance;
let upstream: FakeUpstream;
let hub: Hub;

beforeEach(async () => {
  upstream = new FakeUpstream();
  hub = new Hub();
  app = await buildServer({
    auth: await Authenticator.create({ admin: "s3cret-pass" }, "k".repeat(32)),
    limiter: new LoginRateLimiter(3, 60_000),
    hub,
    upstream,
    corsOrigin: "http://localhost:3000",
    brokerConnected: () => true,
    logLevel: "silent",
  });
});

afterEach(async () => {
  await app.close();
});

async function login(): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "s3cret-pass" } });
  expect(res.statusCode).toBe(200);
  return res.json().token as string;
}

describe("REST API", () => {
  it("requires a token for the API", async () => {
    for (const url of ["/api/devices", "/api/alerts", "/api/me"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(401);
    }
    const bad = await app.inject({ method: "GET", url: "/api/devices", headers: { authorization: "Bearer nope" } });
    expect(bad.statusCode).toBe(401);
    expect(upstream.calls).toHaveLength(0);
  });

  it("logs in and proxies to the right service", async () => {
    const token = await login();
    const auth = { authorization: `Bearer ${token}` };
    expect((await app.inject({ url: "/api/me", headers: auth })).json().user).toBe("admin");
    await app.inject({ url: "/api/devices", headers: auth });
    await app.inject({ url: "/api/devices/pump-01/readings?since=10&limit=50", headers: auth });
    await app.inject({ url: "/api/alerts?state=FIRING", headers: auth });
    expect(upstream.calls.map((c) => `${c.service} ${c.path}`)).toEqual([
      "ingest /api/v1/devices",
      "ingest /api/v1/devices/pump-01/readings?since=10&limit=50",
      "rules /api/v1/alerts?state=FIRING",
    ]);
  });

  it("takes the acknowledging user from the token, not the request body", async () => {
    const token = await login();
    const res = await app.inject({
      method: "POST",
      url: `/api/alerts/${ALERT_ID}/ack`,
      headers: { authorization: `Bearer ${token}` },
      payload: { by: "someone-else" },
    });
    expect(res.statusCode).toBe(200);
    expect(upstream.calls[0]?.body).toEqual({ by: "admin" });
  });

  it("validates input before calling upstream", async () => {
    const auth = { authorization: `Bearer ${await login()}` };
    expect((await app.inject({ url: "/api/devices/BAD..ID/readings", headers: auth })).statusCode).toBe(400);
    expect((await app.inject({ url: "/api/devices/pump-01/readings?limit=0", headers: auth })).statusCode).toBe(400);
    expect((await app.inject({ url: "/api/alerts?state=MAYBE", headers: auth })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/alerts/../ack", headers: auth })).statusCode).toBe(404);
    expect(upstream.calls).toHaveLength(0);
  });

  it("maps upstream failures to clean gateway errors", async () => {
    const auth = { authorization: `Bearer ${await login()}` };
    upstream.failWith = new UpstreamError("ingest", 504, "ingest timed out");
    const res = await app.inject({ url: "/api/devices", headers: auth });
    expect(res.statusCode).toBe(504);
    expect(res.json()).toEqual({ error: "upstream_unavailable" });
  });

  it("locks out brute-force login attempts", async () => {
    const attempt = () => app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "guess" } });
    for (let i = 0; i < 3; i++) expect((await attempt()).statusCode).toBe(401);
    expect((await attempt()).statusCode).toBe(429);
    // even the right password is refused while locked
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "s3cret-pass" } });
    expect(res.statusCode).toBe(429);
  });

  it("only reflects the configured CORS origin", async () => {
    const ok = await app.inject({ method: "OPTIONS", url: "/api/devices", headers: { origin: "http://localhost:3000" } });
    expect(ok.statusCode).toBe(204);
    expect(ok.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    const evil = await app.inject({ method: "OPTIONS", url: "/api/devices", headers: { origin: "https://evil.example" } });
    expect(evil.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("serves health and metrics without auth", async () => {
    expect((await app.inject({ url: "/healthz" })).json().broker).toBe("connected");
    const m = await app.inject({ url: "/metrics" });
    expect(m.body).toContain("pulse_gateway_ws_clients");
  });
});

describe("WebSocket", () => {
  async function open(): Promise<{ ws: WebSocket; messages: unknown[]; closed: Promise<number> }> {
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const ws = new WebSocket(address.replace("http", "ws") + "/ws");
    const messages: unknown[] = [];
    ws.on("message", (m) => messages.push(JSON.parse(m.toString())));
    const closed = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
    await new Promise((resolve) => ws.on("open", resolve));
    return { ws, messages, closed };
  }

  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  };

  it("authenticates with the first message and then streams events", async () => {
    const token = await login();
    const { ws, messages } = await open();
    ws.send(JSON.stringify({ type: "auth", token }));
    await until(() => messages.length > 0);
    expect(messages[0]).toEqual({ type: "ready", user: "admin" });

    hub.broadcast({ type: "reading", data: { deviceId: "pump-01", seq: 7 } });
    await until(() => messages.length > 1);
    expect(messages[1]).toEqual({ type: "reading", data: { deviceId: "pump-01", seq: 7 } });
    ws.close();
  });

  it("closes the socket on a bad token", async () => {
    const { ws, closed } = await open();
    ws.send(JSON.stringify({ type: "auth", token: "forged" }));
    expect(await closed).toBe(4401);
    expect(hub.stats().clients).toBe(0);
  });

  it("refuses commands before authentication", async () => {
    const { ws, closed } = await open();
    ws.send(JSON.stringify({ type: "subscribe", devices: null }));
    expect(await closed).toBe(4401);
  });

  it("closes the socket on garbage input", async () => {
    const { ws, closed } = await open();
    ws.send("{not json");
    expect(await closed).toBe(4400);
  });
});
