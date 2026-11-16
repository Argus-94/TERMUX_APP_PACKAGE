#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "node:url";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const must = [
  "core/runtime/BootstrapPipeline.ts",
  "core/runtime/SupervisorPolicy.ts",
  "core/runtime/backends/NativeAccelBackend.ts",
  "lib/adb-pairing.ts",
  "lib/profile-transfer.ts",
  "lib/foreground-task.ts",
  "lib/background-survival.ts",
  "scripts/repair/home-layout.sh",
];
for (const f of must) {
  assert.ok(fs.existsSync(path.join(root, f)), f);
}

const build = fs.readFileSync(path.join(root, "lib/build-loop.ts"), "utf8");
assert.match(build, /assemble-debug-/);
assert.match(build, /markBuild/);
assert.match(build, /unregister\(watchId\)/);

const layout = fs.readFileSync(path.join(root, "app/_layout.tsx"), "utf8");
assert.doesNotMatch(layout, /ensureBackgroundSurvival/);

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
assert.match(pkg.version, /^1\.(7|8|10)\./);

const plan = fs.readFileSync(path.join(root, "docs/plan-dsha-parity.md"), "utf8");
assert.match(plan, /operational closeout|Финал/);

console.log("aib-plan-closeout-selftest: OK", { version: pkg.version });
