#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "node:url";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const ui = fs.readFileSync(path.join(root, "app/runtime.tsx"), "utf8");
assert.match(ui, /refreshPrivileges/);
assert.match(ui, /aib-native-accel/);
assert.match(ui, /accel=/);

const accel = fs.readFileSync(path.join(root, "core/runtime/backends/NativeAccelBackend.ts"), "utf8");
assert.match(accel, /MIT\/Apache/);

console.log("aib-privilege-accel-ui-selftest: OK");
