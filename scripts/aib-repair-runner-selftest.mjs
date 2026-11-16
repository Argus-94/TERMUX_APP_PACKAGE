#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const need = ["lib/repair-script-runner.ts", "lib/runtime-i18n.ts", "lib/agent-repair-hints.ts"];
for (const f of need) assert.ok(fs.existsSync(path.join(root, f)), f);

const runner = fs.readFileSync(path.join(root, "lib/repair-script-runner.ts"), "utf8");
assert.match(runner, /runRepairRecipe/);
assert.match(runner, /AUTO_ALLOW/);
assert.match(runner, /AIB_INTERNAL/);
assert.match(runner, /journal-recover/);
assert.doesNotMatch(runner, /eval\(/);

const i18n = fs.readFileSync(path.join(root, "lib/runtime-i18n.ts"), "utf8");
assert.match(i18n, /runHealth/);
assert.match(i18n, /userspaceHint/);
assert.match(i18n, /"health"/);

const facade = fs.readFileSync(path.join(root, "core/RuntimeFacade.ts"), "utf8");
assert.match(facade, /runRepairForDiagnostic/);
assert.match(facade, /lastStartupFailure/);

const ui = fs.readFileSync(path.join(root, "app/runtime.tsx"), "utf8");
assert.match(ui, /rt\("runHealth"\)/);
assert.match(ui, /rt\("userspaceRuntime"\)/);

console.log("AIB_REPAIR_RUNNER_SELFTEST_OK");
