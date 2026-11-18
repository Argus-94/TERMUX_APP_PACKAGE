#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// Exercise the actual Expo config-plugin mods against a clean-prebuild-like
// Gradle properties file. This test deliberately does not invoke Gradle.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const withFixGradleProperties = require(path.join(root, "plugins/withFixGradleProperties.js"));
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aib-native-abi-prebuild-"));
const androidRoot = path.join(tempRoot, "android");
fs.mkdirSync(androidRoot, { recursive: true });

function propertyMap(items) {
  return new Map(items.filter((item) => item.type === "property").map(({ key, value }) => [key, value]));
}

function readProperty(text, key) {
  const matches = [...text.matchAll(new RegExp(`^${key}=([^\\r\\n]*)$`, "gm"))];
  assert.equal(matches.length, 1, `expected exactly one ${key} line in generated gradle.properties`);
  return matches[0][1];
}

try {
  const generatedByExpo = [
    { type: "comment", value: "Project-wide Gradle settings." },
    { type: "property", key: "org.gradle.jvmargs", value: "-Xmx2048m" },
    { type: "property", key: "reactNativeArchitectures", value: "armeabi-v7a,arm64-v8a,x86,x86_64" },
  ];
  fs.writeFileSync(
    path.join(androidRoot, "gradle.properties"),
    [
      "# Project-wide Gradle settings.",
      "org.gradle.jvmargs=-Xmx2048m",
      "reactNativeArchitectures=armeabi-v7a,arm64-v8a,x86,x86_64",
      "reactNativeArchitectures=x86_64",
      "",
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(path.join(androidRoot, "settings.gradle"), "pluginManagement { repositories { google(); mavenCentral() } }\n", "utf8");

  const config = withFixGradleProperties({
    name: "AI Builder",
    slug: "ai-builder",
    mods: {},
    modRequest: { platformProjectRoot: androidRoot },
  });
  assert.equal(typeof config.mods?.android?.gradleProperties, "function", "Expo gradleProperties mod must be registered");
  assert.equal(typeof config.mods?.android?.dangerous, "function", "Expo dangerous mod must be registered");

  const propertiesResult = await config.mods.android.gradleProperties({
    modRequest: { platformProjectRoot: androidRoot },
    modResults: generatedByExpo,
  });
  assert.equal(propertyMap(propertiesResult.modResults).get("reactNativeArchitectures"), "arm64-v8a");

  await config.mods.android.dangerous({
    modRequest: { platformProjectRoot: androidRoot },
    modResults: null,
  });
  const generatedGradleProperties = fs.readFileSync(path.join(androidRoot, "gradle.properties"), "utf8");
  const configuredAbis = readProperty(generatedGradleProperties, "reactNativeArchitectures")
    .split(",")
    .map((abi) => abi.trim())
    .filter(Boolean);
  assert.deepEqual(configuredAbis, ["arm64-v8a"], "generated root Gradle property must allow ARM64 only");

  // React Native and Hermes both feed this property into Android's native ABI
  // filters. CMake's per-ABI configure task set is therefore the same single ABI.
  const reactNativeRoot = path.dirname(require.resolve("react-native/package.json"));
  for (const relative of ["ReactAndroid/build.gradle.kts", "ReactAndroid/hermes-engine/build.gradle.kts"]) {
    const source = fs.readFileSync(path.join(reactNativeRoot, relative), "utf8");
    assert.match(source, /project\.properties\["reactNativeArchitectures"\]/, `${relative} must read the root ABI property`);
    assert.match(source, /abiFilters\.addAll\(reactNativeArchitectures\(\)\)/, `${relative} must apply that list as native ABI filters`);
  }
  const configureCMakeAbiTaskSet = [...new Set(configuredAbis)].sort();
  assert.deepEqual(configureCMakeAbiTaskSet, ["arm64-v8a"], "configureCMake ABI task set must be ARM64-only");

  console.log("AIB_ANDROID_NATIVE_ABI_PREBUILD_SELFTEST_OK generated=arm64-v8a configureCMake_abis=arm64-v8a gradle_launched=false");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
