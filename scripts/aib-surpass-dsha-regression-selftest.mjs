#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __AIB_VER = (await import("node:fs")).readFileSync(new URL("../core/runtime/RuntimeIdentity.ts", import.meta.url), "utf8").match(/appVersion: "([^"]+)"/)[1]; // v407: single source of truth (RuntimeIdentity == package.json)

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const suite = spawnSync(process.execPath, ["--experimental-transform-types", path.join(root, "scripts/aib-enhancements-regression-selftest.mjs")], {
  cwd: root,
  encoding: "utf8",
  timeout: 900_000,
  maxBuffer: 16 * 1024 * 1024,
});
if (suite.stdout) process.stdout.write(suite.stdout);
if (suite.stderr) process.stderr.write(suite.stderr);
if (suite.error || suite.status !== 0) {
  throw new Error(`PHASE_REGRESSION_FAILED status=${suite.status} ${suite.error ?? ""}`);
}

const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const appConfig = fs.readFileSync(path.join(root, "app.config.ts"), "utf8");
const androidIdentity = JSON.parse(fs.readFileSync(path.join(root, "AI_BUILDER_ANDROID_IDENTITY.json"), "utf8"));
assert.equal(androidIdentity.applicationId, "com.karat.aibuilder", "application id is a release invariant");
assert.equal(androidIdentity.namespace, "com.karat.aibuilder", "Android namespace is a release invariant");
assert.match(appConfig, /name:\s*"AI Builder"/);
assert.match(appConfig, /slug:\s*"ai-builder"/);
assert.match(appConfig, /package:\s*"com\.karat\.aibuilder"/);
assert.equal(packageJson.version, __AIB_VER, "package/app version is a release invariant");

const coordinator = fs.readFileSync(path.join(root, "core/enhancements/toolchain/AndroidToolchainCoordinator.ts"), "utf8");
assert.match(coordinator, /INSTALL_REQUIRES_EXPLICIT_PERMISSION_AND_CONSENT/);
assert.match(coordinator, /PROJECT_IDENTITY_CHANGED/);
assert.match(coordinator, /BUILD_ARTIFACT_OUTSIDE_PROJECT/);
const offlineRuntime = fs.readFileSync(path.join(root, "core/RuntimeFacade.ts"), "utf8");
assert.match(offlineRuntime, /OFFLINE_AGENT_PROJECT_NOT_ACTIVE/);
assert.match(offlineRuntime, /checkedActiveProjectRoot\(activeProject\.path\)/);
console.log(`AIB_SURPASS_DSHA_REGRESSION_SELFTEST_OK appId=${androidIdentity.applicationId} slug=ai-builder appName=AI Builder packageVersion=${packageJson.version}`);
