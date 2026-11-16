#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const agent = fs.readFileSync(path.join(root, "lib/termux-agent.ts"), "utf8");
const errors = [];
for (const need of [
  "function buildMavenAssembleCmd",
  "function buildNativeAssembleCmd",
  "isMavenBuild",
  "isNativeBuild",
  "KIND_ASSEMBLE=maven",
  "KIND_ASSEMBLE=native",
  "mvn -B -DskipTests package",
  "ndk-build",
  "!isMavenBuild && !isNativeBuild",
  "function buildFlutterAssembleCmd",
  "isFlutterBuild",
  "KIND_ASSEMBLE=flutter",
  "AIB_FLUTTER_ARTIFACT",
]) {
  if (!agent.includes(need)) errors.push("missing: " + need);
}
if (/packages(?:-cf)?\.termux\.dev\/apt\/termux-main/.test(agent)) errors.push("forbidden mirror");
if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
console.log("AIB_MULTIKIND_ASSEMBLE_SELFTEST_OK maven=1 native=1 branch=1");
