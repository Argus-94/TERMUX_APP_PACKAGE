#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const root = path.resolve(new URL("..", import.meta.url).pathname);
const src = fs.readFileSync(path.join(root, "scripts/aib-auto-prebuild.mjs"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const preflight = fs.readFileSync(path.join(root, "scripts/aib-native-source-preflight.mjs"), "utf8");
const manifest = fs.readFileSync(path.join(root, "plugins/native-source-manifest.cjs"), "utf8");
const accessibility = fs.readFileSync(path.join(root, "plugins/withAibAccessibility.js"), "utf8");
const errors = [];
if (!src.includes("node_modules") || !src.includes(".bin")) errors.push("LOCAL_EXPO_FALLBACK_MISSING");
if (!src.includes("pnpm 9.15.0 is not provided by CI")) errors.push("CI_FALLBACK_MISSING");
if (src.includes("pnpm 9.15.0 is required; cannot start pinned Expo prebuild")) errors.push("HARD_PNPM_GATE_REMAINS");
if (!src.includes("prebuild") || !src.includes("--platform") || !src.includes("--no-install")) errors.push("PREBUILD_FLAGS_MISSING");
if (pkg.scripts?.preinstall !== "node scripts/aib-native-source-preflight.mjs") errors.push("NPM_PREINSTALL_PREFLIGHT_MISSING");
if (!preflight.includes("assertRequiredNativeSourceAssets")) errors.push("NATIVE_SOURCE_PREFLIGHT_CALL_MISSING");
if (!manifest.includes("plugins/android/AibAccessibilityService.kt") || !manifest.includes("plugins/android/AibMemoryPressureModule.kt") || !manifest.includes("plugins/android/AibMemoryPressurePackage.kt") || !manifest.includes("AIB_NATIVE_SOURCE_MISSING")) errors.push("CANONICAL_ACCESSIBILITY_MANIFEST_MISSING");
if (!src.includes("assertRequiredNativeSourceAssets(root)")) errors.push("POSTINSTALL_SOURCE_PREFLIGHT_MISSING");
if (!accessibility.includes("path.join(cfg.modRequest.projectRoot, 'plugins', 'android')")) errors.push("PLUGIN_SOURCE_ROOT_NOT_PROJECT_RELATIVE");
if (/expo-cli\s+eject|\|\|\s*true/.test(`${src}\n${pkg.scripts?.postinstall ?? ""}`)) errors.push("SUPPRESSED_PREBUILD_FALLBACK_FORBIDDEN");
if (errors.length) { console.error("AIB_AUTO_PREBUILD_CI_BOOTSTRAP_SELFTEST_FAIL", errors.join(",")); process.exit(1); }
console.log("AIB_AUTO_PREBUILD_CI_BOOTSTRAP_SELFTEST_OK local_expo_fallback=pinned_no_npx");
