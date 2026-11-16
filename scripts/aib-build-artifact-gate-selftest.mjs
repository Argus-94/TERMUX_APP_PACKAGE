#!/usr/bin/env node
import assert from "node:assert/strict";
import { evaluateBuildArtifactGate } from "../lib/build-artifact-gate.ts";

const apkPath = "/work/project/app/build/outputs/apk/debug/app-debug-signed.apk";
const apkSuccess = {
  buildOk: true,
  collectExitCode: 0,
  collectLog: `SIGNED_V1_V2_V3_OK=${apkPath}\nAPK_PATH=${apkPath}`,
  artifactPath: apkPath,
  validationOk: true,
  expectedKind: "apk",
};

assert.deepEqual(evaluateBuildArtifactGate(apkSuccess), {
  ok: true,
  kind: "apk",
  reason: "VERIFIED_SIGNED_ARTIFACT",
}, "valid signed APK must pass");

const noApk = evaluateBuildArtifactGate({
  ...apkSuccess,
  artifactPath: null,
  collectLog: "BUILD SUCCESSFUL\n",
});
assert.equal(noApk.ok, false, "successful Gradle with no APK must fail");
assert.equal(noApk.reason, "ARTIFACT_PATH_MISSING_OR_INVALID");

for (const [label, overrides] of [
  ["unsigned APK", { collectLog: `ARTIFACT_COPIED=${apkPath}`, validationOk: false }],
  ["zero-size or empty APK", { collectLog: `SIGNED_V1_V2_V3_OK=${apkPath}`, validationOk: false }],
  ["corrupt APK", { collectLog: `SIGNED_V1_V2_V3_OK=${apkPath}`, validationOk: false }],
  ["invalid signature", { collectLog: `SIGNED_V1_V2_V3_OK=${apkPath}`, validationOk: false }],
]) {
  const result = evaluateBuildArtifactGate({ ...apkSuccess, ...overrides });
  assert.equal(result.ok, false, `${label} must fail closed`);
}

assert.equal(evaluateBuildArtifactGate({
  ...apkSuccess,
  collectLog: `SIGNED_V1_V2_V3_OK=/work/old.apk`,
}).ok, false, "stale or foreign artifact marker must not validate another path");
assert.equal(evaluateBuildArtifactGate({
  ...apkSuccess,
  collectExitCode: 23,
}).reason, "COLLECT_EXIT_NONZERO", "collector failure cannot be soft-accepted");
assert.equal(evaluateBuildArtifactGate({
  ...apkSuccess,
  buildOk: false,
}).reason, "BUILD_NOT_VERIFIED", "compiler failure cannot be masked by artifact markers");
assert.equal(evaluateBuildArtifactGate({
  ...apkSuccess,
  buildOk: false,
  artifactPath: null,
  collectLog: "NDK_READY=1\nGRADLE_NOT_STARTED=1\n",
}).reason, "BUILD_NOT_VERIFIED", "NDK readiness without a Gradle run cannot be accepted as an APK build");
assert.equal(evaluateBuildArtifactGate({
  ...apkSuccess,
  artifactPath: "/work/project/output.jar",
  collectLog: "ARTIFACT_COPIED=/work/project/output.jar",
}).reason, "ARTIFACT_EXTENSION_UNSUPPORTED", "non-APK artifacts cannot satisfy APK build gate");

const aabPath = "/work/project/app/build/outputs/bundle/release/app-release.aab";
const aab = evaluateBuildArtifactGate({
  buildOk: true,
  collectExitCode: 0,
  collectLog: `AAB_OK=${aabPath}`,
  artifactPath: aabPath,
  validationOk: true,
  expectedKind: "aab",
});
assert.equal(aab.ok, true, "verified signed AAB remains supported");
assert.equal(evaluateBuildArtifactGate({
  buildOk: true,
  collectExitCode: 0,
  collectLog: `AAB_OK=${aabPath}`,
  artifactPath: aabPath,
  validationOk: true,
  expectedKind: "apk",
}).reason, "ARTIFACT_KIND_MISMATCH", "AAB cannot masquerade as APK");

console.log("AIB_BUILD_ARTIFACT_GATE_SELFTEST_OK signed_apk=PASS missing=FAIL unsigned=FAIL empty=FAIL corrupt=FAIL invalid_signature=FAIL stale_path=FAIL ndk_ready_without_gradle=FAIL nonzero_collect=FAIL nonapk=FAIL signed_aab=PASS");
