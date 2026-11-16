#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const { RunCommandPermissionGate, isAndroidRunCommandPermissionDenied, runCommandPermissionStatus } = await import("../lib/termux-permission-gate.ts");
const gate = new RunCommandPermissionGate(5_000, 30_000);
let checks = 0;
const denied = await Promise.all(Array.from({ length: 45 }, () => gate.check(async () => { checks += 1; return false; })));
assert.equal(checks, 1, "45 simultaneous denied startup/readiness requests are coalesced to one permission query");
assert.ok(denied.every((value) => value === false));
for (let i = 0; i < 45; i += 1) assert.equal(await gate.check(async () => { checks += 1; return true; }), false);
assert.equal(checks, 1, "cached denial prevents repeated permission probes and RUN_COMMAND service dispatches");
gate.invalidate();
assert.equal(await gate.check(async () => { checks += 1; return true; }, true), true, "explicit user recheck can observe a later grant");
assert.equal(checks, 2);

const exact = "java.lang.SecurityException: Not allowed to start service Intent { act=com.termux.RUN_COMMAND } without permission com.termux.permission.RUN_COMMAND";
assert.equal(isAndroidRunCommandPermissionDenied(exact), true);
assert.match(runCommandPermissionStatus(exact), /RUN_COMMAND_PERMISSION_MISSING/);
assert.match(runCommandPermissionStatus(exact), /Settings → Apps → AI Builder → Permissions → Additional permissions → RUN_COMMAND/);
assert.equal(isAndroidRunCommandPermissionDenied("allow-external-apps is disabled"), false, "do not confuse Termux app setting with Android permission");

const bridge = fs.readFileSync(path.join(root, "lib/termux-bridge.ts"), "utf8");
assert.match(bridge, /deepReadinessProbePending/);
assert.match(bridge, /DEEP_READINESS_FAILURE_TTL_MS = 30_000/);
assert.ok(bridge.indexOf("const transcript = `${r.stderr || \"\"}\\n${r.stdout || \"\"}`.trim()") < bridge.indexOf("if (isAndroidRunCommandPermissionDenied(transcript))"));
assert.match(bridge, /Do not preemptively block on a false PackageManager read/);
assert.doesNotMatch(bridge, /if \(!permissionGranted\)[\s\S]{0,500}throw new Error\(runCommandPermissionStatus\("RUN_COMMAND_PERMISSION_MISSING"\)\)/);

const context = fs.readFileSync(path.join(root, "components/TermuxContext.tsx"), "utf8");
assert.match(context, /setEnabledState\(false\)/);
assert.match(context, /const readiness = await checkTermuxReadiness\(\{ deep: true, refreshPermission: true \}\);[\s\S]*?if \(!readiness\.ready\)[\s\S]*?setEnabledState\(false\)[\s\S]*?setEnabledState\(true\)/);
const settings = fs.readFileSync(path.join(root, "app/termux-settings.tsx"), "utf8");
assert.match(settings, /termuxReasonPermissionMissing/);
assert.match(settings, /readiness\.probeDetail/);
assert.match(settings, /Linking\.openSettings\(\)/);

console.log("AIB_TERMUX_RUN_COMMAND_GATE_SELFTEST_OK concurrent_probes=COALESCED denial_cache=PASS exact_onboarding=PASS ON_after_live_probe=PASS");
