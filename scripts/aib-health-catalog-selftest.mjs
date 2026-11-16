#!/usr/bin/env node
/**
 * Selftest: expanded Health catalog (plan.md Phase B) — rules + probes + recipes exist.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const rules = fs.readFileSync(path.join(root, "core/diagnostics/rules/BuiltinRules.ts"), "utf8");
const probes = fs.readFileSync(path.join(root, "core/diagnostics/LiveProbes.ts"), "utf8");
const facade = fs.readFileSync(path.join(root, "core/RuntimeFacade.ts"), "utf8");
const repair = fs.readFileSync(path.join(root, "core/recovery/DeterministicRepair.ts"), "utf8");
const runner = fs.readFileSync(path.join(root, "lib/repair-script-runner.ts"), "utf8");

for (const id of [
  "runtime.home-layout",
  "toolchain.ndk",
  "toolchain.aapt2",
  "runtime.termux-session",
  "runtime.disk",
  "runtime.debian",
]) {
  assert.match(rules, new RegExp(`id:\\s*"${id.replace(/\./g, "\\.")}"`));
}

for (const fn of ["probeHomeLayout", "probeNdk", "probeAapt2", "probeTermuxSession"]) {
  assert.match(probes, new RegExp(`export async function ${fn}`));
  assert.match(facade, new RegExp(fn));
}

for (const rid of ["home-layout", "ndk-path", "aapt2-sdk", "adb-server"]) {
  assert.match(repair, new RegExp(`id:\\s*"${rid}"`));
  assert.match(runner, new RegExp(`"${rid}"`));
}

const repairDir = path.join(root, "scripts/repair");
const sh = fs.readdirSync(repairDir).filter((f) => f.endsWith(".sh"));
assert.ok(sh.length >= 12, `expected >=12 repair scripts, got ${sh.length}`);
for (const need of ["home-layout.sh", "ndk-path.sh", "aapt2-sdk.sh", "adb-server.sh", "disk-cleanup.sh", "termux-session.sh"]) {
  assert.ok(sh.includes(need), `missing ${need}`);
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
assert.match(pkg.version, /^1\.(7|8|10)\.\d+$/);
const identity = fs.readFileSync(path.join(root, "core/runtime/RuntimeIdentity.ts"), "utf8");
assert.match(identity, /appVersion:\s*"1\.(7|8|10)\.\d+"/);

console.log("aib-health-catalog-selftest: OK", { rules: "home/ndk/aapt2", scripts: sh.length, version: pkg.version });
