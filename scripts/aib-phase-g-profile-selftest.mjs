#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "node:url";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const backend = fs.readFileSync(path.join(root, "core/runtime/RuntimeBackend.ts"), "utf8");
assert.match(backend, /aib-native-accel/);

const accel = fs.readFileSync(path.join(root, "core/runtime/backends/NativeAccelBackend.ts"), "utf8");
assert.match(accel, /priority = 5/);
assert.match(accel, /unavailable/);

const userspace = fs.readFileSync(path.join(root, "core/runtime/AibUserspaceRuntime.ts"), "utf8");
assert.match(userspace, /NativeAccelBackend/);

const rules = fs.readFileSync(path.join(root, "core/diagnostics/rules/BuiltinRules.ts"), "utf8");
assert.match(rules, /privilege\.shizuku/);

const probes = fs.readFileSync(path.join(root, "core/diagnostics/LiveProbes.ts"), "utf8");
assert.match(probes, /probeShizuku/);

const facade = fs.readFileSync(path.join(root, "core/RuntimeFacade.ts"), "utf8");
assert.match(facade, /exportProfile/);
assert.match(facade, /importProfile/);
assert.match(facade, /createShizukuRule/);

const transfer = fs.readFileSync(path.join(root, "lib/profile-transfer.ts"), "utf8");
assert.match(transfer, /PROFILE_EXPORT_OK/);
assert.match(transfer, /PROFILE_IMPORT_OK/);

const ui = fs.readFileSync(path.join(root, "app/runtime.tsx"), "utf8");
assert.match(ui, /exportProfile/);
assert.match(ui, /importProfile/);

console.log("aib-phase-g-profile-selftest: OK");
