#!/usr/bin/env node
// Runs every component's test suite and prints a summary table.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { IS_WIN, ROOT, color } from "./lib.mjs";

const make = spawnSync(IS_WIN ? "where" : "which", ["make"], { stdio: "ignore", shell: IS_WIN }).status === 0 ? "make" : "mingw32-make";

const suites = [
  ["firmware (C)", make, ["CC=gcc", "test"], "firmware"],
  ["ingest (Go)", "go", ["test", "./..."], "services/ingest-go"],
  ["rules (Java)", join(ROOT, "services/rules-java", IS_WIN ? "mvnw.cmd" : "mvnw"), ["-q", "-B", "test"], "services/rules-java"],
  ["gateway (TS)", "npm", ["test"], "services/gateway-node"],
  ["web (TS)", "npm", ["test"], "web"],
];

const results = [];
for (const [name, cmd, args, dir] of suites) {
  console.log(color("36", `\n== ${name} ==`));
  const started = Date.now();
  const quoted = IS_WIN && cmd.includes(" ") ? `"${cmd}"` : cmd;
  const r = spawnSync(quoted, args, { cwd: join(ROOT, dir), stdio: "inherit", shell: IS_WIN });
  results.push([name, r.status === 0, ((Date.now() - started) / 1000).toFixed(1)]);
}

console.log("\n" + color("1", "summary"));
for (const [name, ok, secs] of results) {
  console.log(`  ${ok ? color("32", "PASS") : color("31", "FAIL")}  ${name.padEnd(14)} ${secs}s`);
}
process.exit(results.every(([, ok]) => ok) ? 0 : 1);
