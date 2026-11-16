#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const hints = fs.readFileSync(path.join(root, "lib/agent-repair-hints.ts"), "utf8");
const agent = fs.readFileSync(path.join(root, "lib/termux-agent.ts"), "utf8");
const repair = fs.readFileSync(path.join(root, "lib/repair-script-runner.ts"), "utf8");
const errors = [];
if (!hints.includes("export function suggestRepairFromBuildLog")) errors.push("missing suggestRepairFromBuildLog");
if (!agent.includes("suggestRepairFromBuildLog")) errors.push("agent not wired");
if (!agent.includes("auto-repair recipe=")) errors.push("auto-repair not injected");
if (!hints.includes("NO_FLUTTER") || !hints.includes("NO_MAVEN")) errors.push("NO_FLUTTER/NO_MAVEN mapping missing");
if (!repair.includes("{ [ -d .dart_tool ]")) errors.push("flutter-pub REPAIR_OK precedence fix missing");
if (!repair.includes('if (id === "expo-deps")') || !repair.includes("EMBEDDED_SIGNED_FEED_REQUIRED")) errors.push("expo-deps must fail closed before unqualified installation");
if (/pkg install|apt-get (?:update|install)|yarn install|pnpm install/.test(repair)) errors.push("repair must not bypass the embedded package qualification gate");
if (!repair.includes("NO_POM") && !repair.includes("../pom.xml")) errors.push("maven-deps should resolve parent pom");
if (!agent.includes("assemble retry after auto-repair")) errors.push("post-repair assemble retry missing");
if (!agent.includes("assemblePassed")) errors.push("assemblePassed flag missing");
if (!agent.includes("Collect runs for initial success OR post-repair")) errors.push("collect must run after assemblePassed (not only else of !assemblePassed)");
if (!hints.includes("CAP_ANDROID_MISSING") || !agent.includes("isCapacitorBuild")) errors.push("capacitor platform-missing diagnosis missing");
if (!hints.includes("CORDOVA_ANDROID_MISSING") || !agent.includes("isCordovaBuild")) errors.push("cordova platform-missing diagnosis missing");
for (const p of ["gradle-wrapper", "gradle-cache", "local-properties", "flutter-pub", "maven-deps", "expo-deps", "ndk-path"]) {
  if (!hints.includes(`add("${p}")`)) errors.push("pattern missing: " + p);
}
if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
console.log("AIB_BUILD_LOG_REPAIR_SELFTEST_OK wired=1 capacitor_diagnosed=1 cordova_diagnosed=1");
