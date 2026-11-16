#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const health = fs.readFileSync(path.join(root, "core/diagnostics/RuntimeHealth.ts"), "utf8");
assert.match(health, /constructor\(failures\?: FailureJournal\)/);
assert.match(health, /new RepairManager\(failures\)/);
const facade = fs.readFileSync(path.join(root, "core/RuntimeFacade.ts"), "utf8");
assert.match(facade, /new RuntimeHealth\(this\.failureJournal\)/);
const ui = fs.readFileSync(path.join(root, "app/runtime.tsx"), "utf8");
assert.match(ui, /phone-portrait-outline/);
assert.match(ui, /analytics-outline/);
assert.match(ui, /listOpenFailures/);
console.log("AIB_REPAIR_JOURNAL_WIRE_SELFTEST_OK");
