#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const manifestPath = path.join(root, "packaging/embedded-termux-v476/manifest.json");
const planPath = path.join(root, "packaging/embedded-termux-v476/BUILD_AND_PROVISIONING_RU.md");
const sourcesPath = path.join(root, "packaging/embedded-termux-v476/SOURCES_RU.md");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const plan = fs.readFileSync(planPath, "utf8");
const sources = fs.readFileSync(sourcesPath, "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

assert.equal(pkg.version, "1.10.113", "current app source release is v513");
assert.equal(manifest.release.label, "v476");
assert.equal(manifest.release.appVersion, "1.10.76", "v476 package plan remains historical");
assert.equal(manifest.release.androidVersionCode, 476);
assert.equal(manifest.target.applicationId, "com.karat.aibuilder");
assert.equal(manifest.target.architecture, "aarch64");
assert.equal(manifest.target.androidAbi, "arm64-v8a");
assert.equal(manifest.target.persistentProjectRoot, "/storage/emulated/0/AIBuilderTermux");
assert.equal(manifest.target.externalRuntimeTarget, false);
assert.equal(manifest.target.standardComTermuxFeedAllowed, false);
assert.equal(manifest.target.pocketForgeDebAllowed, false);
assert.match(manifest.upstreamRecipeSource.revision, /^[0-9a-f]{40}$/);
assert.equal(manifest.upstreamRecipeSource.revision, "505e06ef0c8dbd7611abfb90e9eb60826dcd01d7");
assert.equal(manifest.status.kind, "source-plan-only");
for (const key of [
  "binaryPackagesCreated",
  "packageFeedCreated",
  "packageFeedSigningKeyCreated",
  "installCapabilityEnabled",
  "appCompatibilityVerified",
  "androidSdkNdkGradleDeviceBuildVerified",
  "byteReproducibleBuildVerified",
  "sourceChecksumsIndependentlyRecomputed",
]) assert.equal(manifest.status[key], false, `${key} must remain an explicit false at v476`);

const expected = new Map([
  ["nodejs-lts", "24.18.0-1"],
  ["npm", "11.20.0"],
  ["openjdk-17", "17.0.20"],
  ["python", "3.14.6-1"],
  ["cmake", "4.4.4"],
  ["ninja", "1.13.2"],
  ["git", "2.56.0"],
  ["make", "4.4.1-1"],
  ["pkg-config", "0.29.2-3"],
]);
assert.equal(manifest.candidatePackageRoots.length, expected.size);
for (const entry of manifest.candidatePackageRoots) {
  assert.equal(expected.get(entry.name), entry.version, `unexpected version for ${entry.name}`);
  assert.ok(entry.sourceUrl || entry.sourceUrls?.length, `source URL missing for ${entry.name}`);
  const hashes = Array.isArray(entry.recipeSha256) ? entry.recipeSha256 : [entry.recipeSha256];
  assert.ok(hashes.length > 0 && hashes.every((hash) => /^[a-f0-9]{64}$/.test(hash)), `invalid recipe hash for ${entry.name}`);
  assert.ok(entry.license, `license missing for ${entry.name}`);
}
for (const name of expected.keys()) assert.ok(manifest.candidatePackageRoots.some((entry) => entry.name === name), `missing ${name}`);
assert.equal(manifest.packageBuilderEnvironment.hostImageDigestPinned, false);
assert.equal(manifest.androidBuildSupport.androidArmBionicHostStatus.startsWith("UNVERIFIED"), true);
assert.match(manifest.candidateStatus, /not a proven minimal dependency closure/i);
assert.match(plan, /source-plan-only|исходной сборки/i);
assert.match(plan, /Do not pass `-i`\/`-I`|не передавать `-i`\/`-I`/i);
assert.match(plan, /com\.karat\.aibuilder/);
assert.match(plan, /runtime\.packages/);
assert.match(sources, /TERMUX_PKG_SHA256/);
assert.match(sources, /505e06ef0c8dbd7611abfb90e9eb60826dcd01d7/);

console.log(`AIB_TERMUX_PACKAGE_PLAN_SELFTEST_OK roots=${manifest.candidatePackageRoots.length} sourceCommit=${manifest.upstreamRecipeSource.revision} artifacts=none`);
