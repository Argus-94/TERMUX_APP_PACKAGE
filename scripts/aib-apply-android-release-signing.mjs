#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildGradlePath = path.join(root, "android", "app", "build.gradle");
const require = createRequire(import.meta.url);
const { transformBuildGradle } = require("../plugins/withAndroidReleaseSigning.js");

try {
  if (!fs.existsSync(buildGradlePath)) throw new Error("AIB_RELEASE_SIGNING_GRADLE_MISSING");
  const original = fs.readFileSync(buildGradlePath, "utf8");
  const transformed = transformBuildGradle(original);
  const schemes = ["enableV1Signing", "enableV2Signing", "enableV3Signing"];
  if (schemes.some((scheme) => !new RegExp(`\\b${scheme}\\s+true\\b`).test(transformed))) {
    throw new Error("AIB_RELEASE_SIGNATURE_SCHEMES_REQUIRED");
  }
  const abiFilterLines = transformed.match(/^[\t ]*abiFilters\b[^\r\n]*$/gm) || [];
  if (abiFilterLines.length !== 1 || !/abiFilters\s+["']arm64-v8a["']/.test(abiFilterLines[0]) || !transformed.includes("AIB_RELEASE_ABI_ARM64_ONLY_V1")) {
    throw new Error("AIB_RELEASE_ARM64_ABI_FILTER_REQUIRED");
  }
  if (transformed !== original) fs.writeFileSync(buildGradlePath, transformed, "utf8");
  console.log("AIB_RELEASE_SIGNING_CONFIG_OK env_only=true schemes=v1,v2,v3 arm64_abi=true debug_signing_unchanged=true r8_release_only=true resources_release_only=true");
} catch (error) {
  console.error(error instanceof Error ? error.message : "AIB_RELEASE_SIGNING_CONFIG_FAILED");
  process.exitCode = 1;
}
