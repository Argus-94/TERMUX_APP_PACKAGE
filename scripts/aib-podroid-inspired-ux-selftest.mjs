#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const protectedHashes = {
  "package.json": "d057c81ee2888b84b08264cd04c31b0432590b8f5021dd43006668ee239dbfec",
  "app.config.ts": "21877ea4fc30325711ecce2a95c30978e1d9c277ceb985d50d4d30b7317dce89",
  "babel.config.js": "ad89cf8ef20ab83fd9136fe78e9b40d5996dbf6463d33084f5a5b3bcf176e43f",
  "metro.config.js": "5c543e824439ed42dd757a4ce7deabd9f59392a870ecd93d0dc7abc859e28bac",
  "tsconfig.json": "6f61880e6963bd3c5b5ff4a0e7393797f513dccbc707b5cb268400a0a6a1fc91",
  "eas.json": "b89c0cc62bc73ed611f34733a209f2705f78293927b05c4e12fff802e09eeee5",
  "gradle.properties": "fd048ca701127912fae07cc1116c79301032c8c25fc6c520f3709de5470b6074",
  "gradlew": "1bc8581ffd9565ce928ce5bc9a15cab6044a0b4d81857ca70390449afe4556c5",
  "AI_BUILDER_ANDROID_IDENTITY.json": "35e62198b3b18f06d471c7ef0827cc06a43778b6316720784dc7076a9a58e1b3",
};
for (const [relative, expected] of Object.entries(protectedHashes)) {
  const actual = createHash("sha256").update(fs.readFileSync(path.join(root, relative))).digest("hex");
  assert.equal(actual, expected, `Prompt_3 protected file changed: ${relative}`);
}
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
assert.equal(packageJson.packageManager, "pnpm@9.15.0");
assert.equal(packageJson.dependencies?.typescript, undefined, "no runtime dependency added for enhancements");
assert.equal(packageJson.dependencies?.["expo-system-ui"], "~6.0.9", "dark native UI requires the Expo SDK-compatible system UI module");
const suites = [
  "aib-terminal-theme-selftest.mjs",
  "aib-terminal-session-selftest.mjs",
  "aib-port-forward-selftest.mjs",
  "aib-runtime-live-status-selftest.mjs",
  "aib-permissions-onboarding-selftest.mjs",
];
for (const script of suites) {
  execFileSync(process.execPath, [path.join(root, "scripts", script)], { cwd: root, stdio: "inherit" });
}
console.log(`AIB_PODROID_INSPIRED_UX_SELFTEST_OK (${suites.length} block suites; protected v269 identity hashes intact)`);
