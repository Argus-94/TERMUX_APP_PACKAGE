#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "node:url";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

assert.ok(fs.existsSync(path.join(root, "plugins/withAibNativeAccel.js")));
assert.ok(fs.existsSync(path.join(root, "native/aib-native-accel/src/aib_accel.c")));
assert.ok(fs.existsSync(path.join(root, "native/aib-native-accel/src/aib_accel_jni.c")));
assert.ok(fs.existsSync(path.join(root, "native/aib-native-accel/LICENSE")));

const plugin = fs.readFileSync(path.join(root, "plugins/withAibNativeAccel.js"), "utf8");
assert.match(plugin, /AibNativeAccelModule/);
assert.match(plugin, /AibNativeAccelPackage/);
assert.match(plugin, /getName\(\): String = "AibNativeAccel"/);
assert.match(plugin, /loadLibrary\("aibaccel"\)/);

const cfg = fs.readFileSync(path.join(root, "app.config.ts"), "utf8");
assert.match(cfg, /withAibNativeAccel/);

const loader = fs.readFileSync(path.join(root, "core/runtime/native-accel-loader.ts"), "utf8");
assert.match(loader, /AibNativeAccel/);

const c = fs.readFileSync(path.join(root, "native/aib-native-accel/src/aib_accel.c"), "utf8");
assert.match(c, /aib_map_path/);
assert.doesNotMatch(c, /proroot/i);

console.log("aib-native-accel-module-selftest: OK");
