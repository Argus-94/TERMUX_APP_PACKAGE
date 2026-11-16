#!/usr/bin/env node
/**
 * AI Builder — automatic Android native generation for cloud/CI builds.
 *
 * The source archive intentionally does not carry a generated android/ tree.
 * Expo CNG normally generates it during EAS Build, but some generic online
 * builders only run `pnpm install` and then look for Gradle. This postinstall
 * hook closes that gap by generating the native tree when missing and then
 * applying the source-pinned, environment-only release signing configuration.
 *
 * It is intentionally idempotent. If the Android tree and Gradle wrapper are
 * already present, only the idempotent release-signing patch is checked/applied;
 * Expo prebuild itself is not rerun.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const root = process.cwd();
const require = createRequire(import.meta.url);
const { assertRequiredNativeSourceAssets } = require("../plugins/native-source-manifest.cjs");

// On a remote iOS EAS build, do not create an unrelated Android project.
if (process.env.EAS_BUILD_PLATFORM && process.env.EAS_BUILD_PLATFORM !== "android") {
  process.exit(0);
}

try {
  assertRequiredNativeSourceAssets(root);
} catch (error) {
  console.error(`[aib-auto-prebuild] ${error instanceof Error ? error.message : "AIB_NATIVE_SOURCE_MISSING"}`);
  process.exit(1);
}

const android = path.join(root, "android");
const gradlew = path.join(android, "gradlew");

function applyReleaseSigningConfig() {
  const script = path.join(root, "scripts", "aib-apply-android-release-signing.mjs");
  const result = spawnSync(process.execPath, [script], { cwd: root, stdio: "inherit", shell: false });
  if (result.error) {
    console.error(`[aib-auto-prebuild] Release signing configuration failed: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[aib-auto-prebuild] Release signing configuration failed with exit code ${result.status ?? 1}.`);
    process.exit(result.status ?? 1);
  }
}

if (fs.existsSync(gradlew)) {
  applyReleaseSigningConfig();
  process.exit(0);
}

console.log("[aib-auto-prebuild] Android native tree is missing.");
console.log("[aib-auto-prebuild] Running Expo prebuild automatically (no manual command required)…");

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const pnpmVersion = spawnSync(pnpm, ["--version"], { cwd: root, encoding: "utf8", shell: false });
let command;
let args;

if (!pnpmVersion.error && pnpmVersion.status === 0 && String(pnpmVersion.stdout || "").trim() === "9.15.0") {
  // Preferred path: honor the project's pinned package manager when the CI image provides it.
  command = pnpm;
  args = ["exec", "expo", "prebuild", "--platform", "android", "--no-install"];
  console.log("[aib-auto-prebuild] Using pinned pnpm 9.15.0.");
} else {
  // Generic CI builders commonly invoke `npm install` and do not install pnpm first.
  // postinstall already runs after dependencies are installed, so use the project's local
  // Expo binary instead of failing solely because pnpm is absent. This does not alter the
  // package manager pin or lockfile and avoids an unpinned package-manager download.
  const localExpo = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "expo.cmd" : "expo");
  if (!fs.existsSync(localExpo)) {
    console.error("[aib-auto-prebuild] pnpm 9.15.0 is unavailable and local Expo CLI is missing.");
    process.exit(1);
  }
  command = localExpo;
  args = ["prebuild", "--platform", "android", "--no-install"];
  console.log("[aib-auto-prebuild] pnpm 9.15.0 is not provided by CI; using installed local Expo CLI.");
}

const result = spawnSync(command, args, { cwd: root, stdio: "inherit", shell: false });

if (result.error) {
  console.error(`[aib-auto-prebuild] Failed to start Expo: ${result.error.message}`);
  process.exit(1);
}

if (result.status !== 0) {
  console.error(`[aib-auto-prebuild] Expo prebuild failed with exit code ${result.status ?? 1}.`);
  process.exit(result.status ?? 1);
}

if (!fs.existsSync(gradlew)) {
  console.error("[aib-auto-prebuild] Prebuild finished, but android/gradlew is still missing.");
  process.exit(1);
}

applyReleaseSigningConfig();
console.log("[aib-auto-prebuild] Android project is ready.");
