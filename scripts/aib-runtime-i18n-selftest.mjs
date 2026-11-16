import fs from "node:fs";

const runtime = fs.readFileSync("app/runtime.tsx", "utf8");
const copy = fs.readFileSync("lib/runtime-i18n.ts", "utf8");
const agent = fs.readFileSync("lib/termux-agent.ts", "utf8");

const requiredRuntimeKeys = [
  "title", "supervisor", "linuxTermux", "containerManager", "deviceBridge",
  "connectAdb", "factory", "activeProject", "backupRestore", "diagnostics",
];
for (const key of requiredRuntimeKeys) {
  if (!new RegExp(`\\b${key}:`).test(copy)) throw new Error(`runtime i18n key missing: ${key}`);
}

for (const bad of ["colors.bg", "colors.inkMuted"]) {
  if (runtime.includes(bad)) throw new Error(`stale theme key in runtime.tsx: ${bad}`);
}

for (const bad of [
  "Runtime supervisor",
  "Linux Runtime / Termux",
  "Container Manager / proot",
  "Device / ADB bridge",
  "One-Click App Factory",
  "Create full backup",
]) {
  if (runtime.includes(`>${bad}<`)) throw new Error(`hardcoded runtime UI text remains: ${bad}`);
}

if (!agent.includes("gradle=OK:path=") || !agent.includes("gradle=BROKEN:path=") || !agent.includes("gradle=MISSING")) {
  throw new Error("Termux Gradle probe is not explicit enough");
}
if (!agent.includes("never treat empty command output as success")) {
  throw new Error("Termux agent prompt lacks empty-output guard");
}
if (!agent.includes("one explicit status line per required tool")) {
  throw new Error("Termux agent prompt lacks per-tool status rule");
}

console.log("AIB_RUNTIME_I18N_AND_TOOLCHAIN_REGRESSION_OK");
