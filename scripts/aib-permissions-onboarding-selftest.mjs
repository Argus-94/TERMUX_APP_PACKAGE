#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRuntimeTs } from "./test-helpers/load-runtime-ts.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const source = (name) => fs.readFileSync(path.join(root, name), "utf8");
const { PermissionExplainer } = loadRuntimeTs(path.join(root, "core/enhancements/onboarding/PermissionExplainer.ts"));
const { PermissionsOnboarding } = loadRuntimeTs(path.join(root, "core/enhancements/onboarding/PermissionsOnboarding.ts"));
const descriptions = new PermissionExplainer().list();
assert.equal(descriptions.length, 5);
const permissionsScreen = source("app/permissions-onboarding.tsx");
assert.match(permissionsScreen, /AppState\.addEventListener\("change"/);
assert.match(permissionsScreen, /if \(id === "notifications"\)/, "only explicitly selected notifications use a normal runtime request here");
assert.doesNotMatch(permissionsScreen, /title: "Termux RUN_COMMAND"|enable RUN_COMMAND/);
assert.match(permissionsScreen, /install-packages/);
assert.match(source("plugins/withAibDeviceWatchdog.js"), /isIgnoringBatteryOptimizations/);
const battery = source("lib/background-survival.ts");
assert.match(battery, /getIgnoreBatteryOptimizationsStatus/);
assert.match(battery, /if \(await getIgnoreBatteryOptimizationsStatus\(\) === true\) return true/);
assert.doesNotMatch(battery, /ensureBackgroundSurvival[\s\S]*?await requestUnrestrictedData\(\)/, "one explicit battery action must not chain into a second settings screen");
assert.match(source("plugins/withTermuxBridge.js"), /canRequestPackageInstalls\(\)/);
assert.match(source("lib/permissions-onboarding.ts"), /native\.canInstallPackages\(\)/);
assert.match(source("lib/permissions-onboarding.ts"), /native\.openUnknownSourcesSettings\(\)/);
assert.doesNotMatch(source("app/_layout.tsx"), /ensureBackgroundSurvival/);
assert.doesNotMatch(source("lib/app-notifications.ts"), /requestIgnoreBatteryOptimizations/);
assert.match(source("app/settings.tsx"), /requestUnrestrictedData\(\)/, "background-data settings remain a separate explicit action");
const micScreen = source("app/index.tsx");
assert.match(micScreen, /Microphone access/);
assert.match(micScreen, /PermissionsAndroid\.check\(PermissionsAndroid\.PERMISSIONS\.RECORD_AUDIO\)/);
assert.match(micScreen, /PermissionsAndroid\.request\(PermissionsAndroid\.PERMISSIONS\.RECORD_AUDIO/);
assert.match(micScreen, /ExpoSpeechRecognitionModule\.getMicrophonePermissionsAsync\(\)/);
const cameraScreen = source("components/CameraCaptureModal.tsx");
assert.match(cameraScreen, /Camera access/);
assert.match(cameraScreen, /ImagePicker\.getCameraPermissionsAsync\(\)/);
assert.match(cameraScreen, /ImagePicker\.requestCameraPermissionsAsync\(\)/);
for (const item of descriptions) {
  assert.ok(item.title.length > 0 && item.shortWhy.length > 0 && item.detailedWhy.length > item.shortWhy.length);
  assert.ok(["low", "medium"].includes(item.riskLevel));
}
const saved = new Map(); const audit = []; let requests = 0; let settingsOpens = 0;
const statuses = { notifications: "denied", storage: "not-applicable", accessibility: "unavailable", "battery-optimization": "manual-required", "termux-run-command": "manual-required", "install-packages": "manual-required" };
const adapter = {
  async check(id) { return statuses[id]; },
  async request(id) { requests += 1; statuses[id] = "granted"; return "granted"; },
  async openSettings() { settingsOpens += 1; return true; },
};
const onboarding = new PermissionsOnboarding(adapter, { async get(key) { return saved.get(key) ?? null; }, async set(key, value) { saved.set(key, value); } }, undefined, (event) => audit.push(event));
const before = await onboarding.refresh();
assert.equal(requests, 0, "status review never prompts automatically");
assert.equal(before.statuses.notifications, "denied");
assert.equal(before.statuses["termux-run-command"], "unavailable", "legacy identifier is never checked or offered by onboarding");
assert.equal(descriptions.find((item) => item.id === "termux-run-command"), undefined);
assert.equal(before.statuses["install-packages"], "manual-required", "unknown-sources access is read from PackageManager, not from the Settings launch result");
assert.equal(before.granted, 1, "not-applicable counts as satisfied, not granted OS access");
assert.equal(await onboarding.request("notifications"), "granted");
await onboarding.refresh();
statuses.notifications = "denied";
const revoked = await onboarding.refresh();
assert.ok(revoked.revoked.includes("notifications"));
assert.equal(await onboarding.openSettings("accessibility"), true);
await assert.rejects(onboarding.openSettings("termux-run-command"), /PERMISSION_NOT_USED/);
await assert.rejects(onboarding.request("termux-run-command"), /PERMISSION_NOT_USED/);
assert.equal(await onboarding.openSettings("install-packages"), true);
assert.equal(requests, 1, "no automatic or fake runtime request is issued for RUN_COMMAND");
await onboarding.later();
assert.equal(await onboarding.wasDeferred(), true);
assert.ok(audit.some((event) => event.action === "request"));
assert.ok(audit.some((event) => event.action === "settings"));
assert.ok(audit.some((event) => event.action === "defer"));
assert.equal(settingsOpens, 2);
console.log("AIB_PERMISSIONS_ONBOARDING_SELFTEST_OK");
