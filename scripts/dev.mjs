#!/usr/bin/env node
// Runs the whole Pulse stack locally with one command:
//
//   npm run dev              everything, plus a simulated fleet with faults
//   npm run dev -- --no-sim  services only
//
// Start order follows the dependency graph: the ingest service hosts the
// MQTT broker, so it must be ready before anything else connects.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { IS_WIN, ROOT, color, loadEnv, simBinary, waitForHttp } from "./lib.mjs";

const args = new Set(process.argv.slice(2));
const env = { ...process.env, ...loadEnv() };
const children = [];
let shuttingDown = false;

const PALETTE = { ingest: "36", rules: "35", gateway: "33", web: "34", sim: "32" };

function start(name, command, cmdArgs, cwd, extraEnv = {}) {
  // with shell: true, a path containing spaces must be quoted
  const cmd = IS_WIN && command.includes(" ") ? `"${command}"` : command;
  const child = spawn(cmd, cmdArgs, {
    cwd,
    env: { ...env, ...extraEnv },
    shell: IS_WIN, // .cmd shims (npm, mvnw) need a shell on Windows
    stdio: ["ignore", "pipe", "pipe"],
  });
  const prefix = color(PALETTE[name] ?? "37", name.padEnd(8)) + "| ";
  const pipe = (stream) => {
    let buf = "";
    stream.on("data", (chunk) => {
      buf += chunk;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const l of lines) if (l.trim()) process.stdout.write(prefix + l + "\n");
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);
  child.on("exit", (code) => {
    if (!shuttingDown) {
      console.log(color("31", `${name} exited with code ${code}; stopping everything`));
      shutdown(1);
    }
  });
  children.push({ name, child });
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(color("2", "\nstopping..."));
  for (const { child } of children.reverse()) {
    if (child.exitCode !== null) continue;
    if (IS_WIN) {
      // child.kill() leaves grandchildren (java, go, node) running on Windows
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      child.kill("SIGTERM");
    }
  }
  setTimeout(() => process.exit(code), 500);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

function preflight() {
  const missing = [];
  if (!existsSync(join(ROOT, "services/gateway-node/node_modules"))) missing.push("gateway dependencies");
  if (!existsSync(join(ROOT, "web/node_modules"))) missing.push("web dependencies");
  if (!args.has("--no-sim") && !existsSync(simBinary())) missing.push("device simulator binary");
  if (missing.length) {
    console.error(color("31", `missing: ${missing.join(", ")}. Run: npm run setup`));
    process.exit(1);
  }
}

async function main() {
  preflight();
  const dataDir = join(ROOT, ".data");
  mkdirSync(dataDir, { recursive: true });

  const ingest = start("ingest", "go", ["run", "./cmd/ingest"], join(ROOT, "services/ingest-go"), {
    PULSE_DB_PATH: join(dataDir, "ingest.db"),
  });
  if (!(await waitForHttp("http://127.0.0.1:8081/readyz", 120_000, () => ingest.exitCode === null))) {
    console.error(color("31", "ingest did not become ready"));
    return shutdown(1);
  }

  const rulesDir = join(ROOT, "services/rules-java");
  start("rules", join(rulesDir, IS_WIN ? "mvnw.cmd" : "mvnw"), ["-q", "spring-boot:run"], rulesDir);
  start("gateway", "npm", ["run", "dev"], join(ROOT, "services/gateway-node"));
  start("web", "npm", ["run", "dev"], join(ROOT, "web"), { NEXT_PUBLIC_GATEWAY_URL: "http://localhost:8080" });

  const [rulesUp, gatewayUp] = await Promise.all([
    waitForHttp("http://127.0.0.1:8082/actuator/health", 180_000),
    waitForHttp("http://127.0.0.1:8080/healthz", 60_000),
  ]);
  if (!rulesUp || !gatewayUp) {
    console.error(color("31", `services not ready (rules: ${rulesUp}, gateway: ${gatewayUp})`));
    return shutdown(1);
  }

  if (!args.has("--no-sim")) {
    start("sim", simBinary(), ["--devices", "9", "--chaos", "--net-chaos", "0.002"], ROOT);
  }

  console.log(
    "\n" +
      color("1", "  Pulse is running\n") +
      `  Dashboard   http://localhost:3000\n` +
      `  Login       ${env.PULSE_ADMIN_USER} / ${env.PULSE_ADMIN_PASSWORD}   (from .env)\n` +
      `  Gateway     http://localhost:8080/healthz\n` +
      `  Metrics     :8081/metrics  :8082/actuator/prometheus  :8080/metrics\n` +
      color("2", "  Ctrl+C to stop\n"),
  );
}

main().catch((err) => {
  console.error(err);
  shutdown(1);
});
