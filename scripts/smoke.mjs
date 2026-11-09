#!/usr/bin/env node
// End-to-end smoke test against a running stack (local or docker compose).
// Exercises the real path: C devices -> Go broker -> Java rules -> Node gateway.
//
//   node scripts/smoke.mjs [gatewayUrl]
import { color, loadEnv } from "./lib.mjs";

const GATEWAY = process.argv[2] ?? "http://localhost:8080";
const env = { ...loadEnv(), ...process.env };
const step = (msg) => console.log(color("36", "• ") + msg);

async function call(path, init = {}, token) {
  const headers = { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const res = await fetch(GATEWAY + path, { ...init, headers, signal: AbortSignal.timeout(5000) });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function eventually(what, timeoutMs, fn) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)})`);
}

async function main() {
  step(`gateway ${GATEWAY}`);
  await eventually("gateway health", 120_000, async () => (await call("/healthz")).body.broker === "connected");

  const bad = await call("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "admin", password: "wrong-password" }) });
  if (bad.status !== 401) throw new Error(`wrong password should be 401, got ${bad.status}`);
  if ((await call("/api/devices")).status !== 401) throw new Error("API must require a token");
  step("auth rejects bad credentials and missing tokens");

  const login = await call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: env.PULSE_ADMIN_USER ?? "admin", password: env.PULSE_ADMIN_PASSWORD }),
  });
  if (login.status !== 200) throw new Error(`login failed: ${login.status}`);
  const token = login.body.token;
  step("logged in");

  const devices = await eventually("devices reporting", 90_000, async () => {
    const { body } = await call("/api/devices", {}, token);
    const live = (body.devices ?? []).filter((d) => d.readingCount > 0);
    return live.length >= 3 ? live : null;
  });
  step(`${devices.length} devices reporting telemetry`);

  const first = devices[0].id;
  const { body: hist } = await call(`/api/devices/${first}/readings?limit=10`, {}, token);
  if (!hist.readings?.length) throw new Error("no readings stored");
  step(`readings stored and queryable for ${first}`);

  const alert = await eventually("an alert to fire", 180_000, async () => {
    const { body } = await call("/api/alerts?state=FIRING", {}, token);
    return body.alerts?.[0] ?? null;
  });
  step(`alert fired: ${alert.ruleName} on ${alert.deviceId}`);

  const ack = await call(`/api/alerts/${alert.id}/ack`, { method: "POST", body: "{}" }, token);
  if (ack.status !== 200 || ack.body.acknowledgedBy !== (env.PULSE_ADMIN_USER ?? "admin")) {
    throw new Error(`acknowledge failed: ${ack.status} ${JSON.stringify(ack.body)}`);
  }
  step("alert acknowledged through the gateway");

  console.log(color("32", "\nsmoke test passed"));
}

main().catch((err) => {
  console.error(color("31", `\nsmoke test FAILED: ${err.message}`));
  process.exit(1);
});
