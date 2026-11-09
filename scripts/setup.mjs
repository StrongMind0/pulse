#!/usr/bin/env node
// One-time setup: installs JS dependencies and builds the C simulator.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { IS_WIN, ROOT, color } from "./lib.mjs";

function run(label, cmd, args, cwd) {
  console.log(color("36", `→ ${label}`));
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: IS_WIN });
  return r.status === 0;
}

const has = (cmd) => spawnSync(IS_WIN ? "where" : "which", [cmd], { stdio: "ignore", shell: IS_WIN }).status === 0;

const steps = [
  () => run("gateway: npm ci", "npm", ["ci"], join(ROOT, "services/gateway-node")),
  () => run("web: npm ci", "npm", ["ci"], join(ROOT, "web")),
  () => run("ingest: go mod download", "go", ["mod", "download"], join(ROOT, "services/ingest-go")),
  () => {
    const make = has("make") ? "make" : has("mingw32-make") ? "mingw32-make" : null;
    if (!make) {
      console.log(color("33", "  no make found: install a C compiler (gcc/clang + make) to build the simulator"));
      return false;
    }
    return run("firmware: build simulator", make, ["CC=" + (has("gcc") ? "gcc" : "cc")], join(ROOT, "firmware"));
  },
];

let ok = true;
for (const step of steps) ok = step() && ok;
console.log(ok ? color("32", "\nsetup complete. Next: npm run dev") : color("31", "\nsetup finished with errors (see above)"));
process.exit(ok ? 0 : 1);
