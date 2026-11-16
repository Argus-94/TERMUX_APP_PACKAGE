#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const ui = fs.readFileSync(path.join(root, "app/runtime.tsx"), "utf8");
assert.match(ui, /onInstallProotDistro/);
assert.match(ui, /pkg install proot-distro/);
assert.match(ui, /lastBootInfo/);
assert.match(ui, /lastStartupFailure/);
assert.match(ui, /runHealthChecks/);
assert.match(ui, /initUserspaceRuntime/);
assert.match(ui, /linuxHelp/);
assert.match(ui, /cardHeader/);
console.log("AIB_RUNTIME_UX_SELFTEST_OK");
