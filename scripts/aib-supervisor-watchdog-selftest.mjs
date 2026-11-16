#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "node:url";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const facade = fs.readFileSync(path.join(root, "core/RuntimeFacade.ts"), "utf8");
assert.match(facade, /WATCHDOG_HEALTH_FAILED/);
assert.match(facade, /this\.supervisor\.start\(intervalMs, async \(\) => \{[\s\S]*?this\.maintenance\.tick\(\)/);
assert.ok(facade.split('watchdog: "true"').length >= 4, "expected multiple watchdog registrations");

const policy = fs.readFileSync(path.join(root, "core/runtime/SupervisorPolicy.ts"), "utf8");
assert.match(policy, /maxRestartsPerProcess/);
assert.match(policy, /RestartBudget/);

const ui = fs.readFileSync(path.join(root, "app/runtime.tsx"), "utf8");
assert.match(ui, /startSupervisor\(\)/);
assert.match(ui, /soft-start process supervisor/);

console.log("aib-supervisor-watchdog-selftest: OK");
