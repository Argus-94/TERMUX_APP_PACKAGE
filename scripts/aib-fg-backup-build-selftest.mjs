#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "node:url";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const build = fs.readFileSync(path.join(root, "lib/build-loop.ts"), "utf8");
assert.match(build, /withForegroundTask\("build"/);
assert.match(build, /runAssembleDebugInner/);

const ui = fs.readFileSync(path.join(root, "app/runtime.tsx"), "utf8");
assert.match(ui, /withForegroundTask\("backup"/);
assert.match(ui, /withForegroundTask\("restore"/);

const facade = fs.readFileSync(path.join(root, "core/RuntimeFacade.ts"), "utf8");
assert.match(facade, /ensureTermuxBridgeWatch/);
assert.match(facade, /termux-bridge-session/);

console.log("aib-fg-backup-build-selftest: OK");
