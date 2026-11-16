#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const ui = fs.readFileSync(path.join(root, "app/runtime.tsx"), "utf8");
assert.match(ui, /repairHealth\(f\.component\)/);
assert.match(ui, /cloud-upload-outline/);
assert.match(ui, /folder-open-outline/);
assert.match(ui, /pre-backup/);
console.log("AIB_PER_FAILURE_REPAIR_SELFTEST_OK");
