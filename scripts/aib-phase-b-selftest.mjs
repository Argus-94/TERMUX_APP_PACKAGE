#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "node:url";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
for (const f of ["java-openjdk17.sh", "android-tools.sh", "nodejs.sh", "unzip.sh", "proot-distro.sh", "git.sh"]) {
  assert.ok(fs.existsSync(path.join(root, "scripts/repair", f)), f);
}
const dr = fs.readFileSync(path.join(root, "core/recovery/DeterministicRepair.ts"), "utf8");
assert.match(dr, /proot-distro-pkg/);
assert.match(dr, /toolchain\.git/);
assert.match(dr, /runtime\.debian/);
const rules = fs.readFileSync(path.join(root, "core/diagnostics/rules/BuiltinRules.ts"), "utf8");
assert.match(rules, /createGitRule/);
assert.match(rules, /createUnzipRule/);
assert.match(rules, /createDebianDistroRule/);
const facade = fs.readFileSync(path.join(root, "core/RuntimeFacade.ts"), "utf8");
assert.match(facade, /createDebianDistroRule/);
assert.match(facade, /probeGit/);
const runner = fs.readFileSync(path.join(root, "lib/repair-script-runner.ts"), "utf8");
assert.match(runner, /SCRIPT_BY_RECIPE/);
assert.match(runner, /proot-distro-pkg/);
console.log("AIB_PHASE_B_SELFTEST_OK");
