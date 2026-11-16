#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const root = process.cwd();
const src = fs.readFileSync(path.join(root, "scripts/aib-auto-prebuild.mjs"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const errors = [];
if (pkg.packageManager !== "pnpm@9.15.0") errors.push("PACKAGE_MANAGER_NOT_PINNED");
if (!src.includes('["--version"]')) errors.push("PNPM_VERSION_CHECK_MISSING");
if (!src.includes('String(pnpmVersion.stdout || "").trim() === "9.15.0"')) errors.push("PNPM_VERSION_GUARD_MISSING");
if (!src.includes('["exec", "expo", "prebuild"')) errors.push("PINNED_PNPM_EXEC_MISSING");
if (/\bnpx\b|npx\.cmd/.test(src)) errors.push("NPX_REFERENCE_FORBIDDEN");
if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
if (!src.includes("local Expo CLI")) errors.push("LOCAL_EXPO_FALLBACK_MISSING");
if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
console.log("AIB_AUTO_PREBUILD_PINNED_SELFTEST_OK pnpm=9.15.0 local_expo_fallback=npx_blocked");
