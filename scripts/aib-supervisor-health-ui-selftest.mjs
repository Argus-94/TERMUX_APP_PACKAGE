#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "node:url";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const rules = fs.readFileSync(path.join(root, "core/diagnostics/rules/BuiltinRules.ts"), "utf8");
assert.match(rules, /runtime\.supervisor/);

const facade = fs.readFileSync(path.join(root, "core/RuntimeFacade.ts"), "utf8");
assert.match(facade, /createSupervisorRule/);
assert.match(facade, /id === "runtime\.supervisor"/);

const status = fs.readFileSync(path.join(root, "core/RuntimeStatus.ts"), "utf8");
assert.match(status, /watchdog\?: boolean/);

const ui = fs.readFileSync(path.join(root, "app/runtime.tsx"), "utf8");
assert.match(ui, /processList.*filter.*watchdog/);

const build = fs.readFileSync(path.join(root, "lib/build-loop.ts"), "utf8");
assert.match(build, /notePossibleBuildKill/);

console.log("aib-supervisor-health-ui-selftest: OK");
