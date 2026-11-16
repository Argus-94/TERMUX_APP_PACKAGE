#!/usr/bin/env node
/**
 * Startup safety: ensureBackgroundSurvival must NOT be auto-called from
 * usePermissions (or any other cold-start path). Opening system Settings on
 * every relaunch was a reported UX regression.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const perm = fs.readFileSync(path.join(root, "hooks/usePermissions.ts"), "utf8");
const errors = [];

// Real call sites (not comments)
const callRe = /(?<!\/\/[^\n]*)\bensureBackgroundSurvival\s*\(/g;
const importRe = /import\s+\{[^}]*ensureBackgroundSurvival[^}]*\}\s+from\s+["'][^"']*background-survival["']/;
if (importRe.test(perm)) {
  errors.push("usePermissions still imports background-survival");
}
// Strip comments then look for calls
const noComments = perm.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
if (/\bensureBackgroundSurvival\s*\(/.test(noComments)) {
  errors.push("usePermissions still calls ensureBackgroundSurvival on startup");
}
// The helper itself must still exist for explicit Settings use.
const survival = fs.readFileSync(path.join(root, "lib/background-survival.ts"), "utf8");
if (!survival.includes("export async function ensureBackgroundSurvival")) {
  errors.push("ensureBackgroundSurvival helper missing");
}
if (!survival.includes("requestIgnoreBatteryOptimizations")) {
  errors.push("requestIgnoreBatteryOptimizations missing");
}

if (errors.length) {
  console.error("AIB_STARTUP_SAFETY_SELFTEST_FAIL");
  for (const e of errors) console.error(" -", e);
  process.exit(1);
}
console.log("AIB_STARTUP_SAFETY_SELFTEST_OK checks=4");
