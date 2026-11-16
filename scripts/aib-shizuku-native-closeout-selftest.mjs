#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "node:url";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const bridge = fs.readFileSync(path.join(root, "lib/shizuku-bridge.ts"), "utf8");
assert.match(bridge, /probeShizukuBridge/);
assert.match(bridge, /shizukuExec/);
assert.match(bridge, /shizukuSelfCheck/);
assert.match(bridge, /rish/);

const loader = fs.readFileSync(path.join(root, "core/runtime/native-accel-loader.ts"), "utf8");
assert.match(loader, /AibNativeAccel/);
assert.match(loader, /isNativeAccelLinked/);

const accel = fs.readFileSync(path.join(root, "core/runtime/backends/NativeAccelBackend.ts"), "utf8");
assert.match(accel, /getNativeAccelModule/);
assert.match(accel, /isNativeAccelLinked/);

const facade = fs.readFileSync(path.join(root, "core/RuntimeFacade.ts"), "utf8");
assert.match(facade, /shizukuSelfCheck/);
assert.match(facade, /shizukuExec/);

const ui = fs.readFileSync(path.join(root, "app/runtime.tsx"), "utf8");
assert.match(ui, /shizukuSelfCheck/);
assert.match(ui, /Test Shizuku\/rish|Тест Shizuku/);

const det = fs.readFileSync(path.join(root, "core/privilege/DevicePrivilegeDetection.ts"), "utf8");
assert.match(det, /probeShizukuBridge/);

assert.ok(fs.existsSync(path.join(root, "docs/NATIVE_ACCEL_SLOT.md")));

console.log("aib-shizuku-native-closeout-selftest: OK");
