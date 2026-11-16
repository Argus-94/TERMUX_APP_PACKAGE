#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";

const plugin = fs.readFileSync("plugins/withTermuxBridge.js", "utf8");
const bridge = fs.readFileSync("lib/termux-bridge.ts", "utf8");

// Private runtime readiness is based on the app-owned embedded capability; it must not discover an external Termux package.
assert.doesNotMatch(plugin, /com\.termux\.permission\.RUN_COMMAND|QUERY_ALL_PACKAGES/);
const privateStatus = fs.readFileSync("lib/agent-tools/runtime/status.ts", "utf8");
assert.doesNotMatch(privateStatus, /getPackageVersion|com\.termux|RUN_COMMAND|discover/i, "private readiness must not perform external package discovery");
assert.match(privateStatus, /PRIVATE_STATUS_MARKER = "AIB_PRIVATE_RUNTIME_STATUS_V1"/);
assert.match(privateStatus, /PRIVATE_STATUS_COMMAND = `printf/);
assert.match(privateStatus, /PRIVATE_STATUS_TIMEOUT_MS = 5_000/);
assert.match(privateStatus, /context\?\.executionTarget !== "embedded-private"/);
assert.match(privateStatus, /privateRuntimeProvider\.execute\(PRIVATE_STATUS_COMMAND/);
assert.doesNotMatch(privateStatus, /\brunCommand\(/);
assert.match(bridge, /getEmbeddedTermuxRuntimeStatus/);
assert.match(bridge, /runEmbeddedTermuxCommand/);
assert.match(bridge, /async function checkTermuxReadinessOnce/);
assert.doesNotMatch(bridge.slice(bridge.indexOf("async function checkTermuxReadinessOnce"), bridge.indexOf("export async function openRunCommandPermissionSettings")), /getPackageVersion|isTermuxInstalled|hasRunCommandPermission|native\.runCommand/);
assert.match(bridge, /EMBEDDED_EXEC_UNAVAILABLE/);
assert.match(bridge, /value\.backendId !== "embedded-termux"/);


console.log("AIB_V486_PRIVATE_RUNTIME_READINESS_SELFTEST_OK embedded_status_probe=1 no_external_discovery=1 missing_capability_fail_closed=1 NO_ANDROID_DEVICE_PROOF");
