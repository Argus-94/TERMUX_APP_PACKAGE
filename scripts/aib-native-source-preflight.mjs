#!/usr/bin/env node
import path from "node:path";
import { createRequire } from "node:module";

if (process.env.EAS_BUILD_PLATFORM && process.env.EAS_BUILD_PLATFORM !== "android") {
  process.exit(0);
}

const require = createRequire(import.meta.url);
const { assertRequiredNativeSourceAssets } = require("../plugins/native-source-manifest.cjs");
try {
  assertRequiredNativeSourceAssets(path.resolve(process.cwd()));
  console.log("AIB_NATIVE_SOURCE_PREFLIGHT_OK required Android source assets are present and in-project.");
} catch (error) {
  console.error(error instanceof Error ? error.message : "AIB_NATIVE_SOURCE_MISSING: source preflight failed.");
  process.exit(1);
}
