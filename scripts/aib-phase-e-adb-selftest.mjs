#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "node:url";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const mod = fs.readFileSync(path.join(root, "lib/adb-pairing.ts"), "utf8");
assert.match(mod, /adbPair/);
assert.match(mod, /adbConnect/);
assert.match(mod, /adbListDevices/);
assert.match(mod, /humanizeAdbError|unauthorized/);
assert.match(mod, /Wireless debugging|Беспроводная/);
const ui = fs.readFileSync(path.join(root, "app/runtime.tsx"), "utf8");
assert.match(ui, /onAdbPair/);
assert.match(ui, /onAdbConnect/);
assert.match(ui, /adbWizardHelp/);
assert.match(ui, /adbPairHost/);
console.log("AIB_PHASE_E_ADB_SELFTEST_OK");
