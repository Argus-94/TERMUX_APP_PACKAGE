#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const policy = read("lib/apk-build-safety-policy.ts");
const recovery = read("lib/agent-recovery.ts");
const agent = read("lib/termux-agent.ts");
const engine = read("lib/agent-engine.ts");
const autonomy = read("lib/agent-autonomy-policy.ts");
const hints = read("lib/agent-repair-hints.ts");
const antiStuck = read("lib/agent-anti-stuck.ts");
const runner = read("lib/script-runner-agent.ts");
const probe = read("lib/android-toolchain-script.ts");
const tool = read("lib/agent-tools/toolchain-ensure.ts");

assert.match(policy, /AUTONOMOUS BUILD POLICY/);
assert.match(policy, /sdkmanager/);
assert.match(policy, /AIB_AUTOBUILD_NEEDS_LLM=1/);
assert.match(policy, /Never stop at the first error/);
for (const [label, source, marker] of [
  ["recovery", recovery, "APK_BUILD_SAFETY_POLICY"],
  ["agent", agent, "BUILD_RECOVERY_SAFETY_POLICY"],
  ["engine", engine, "APK_BUILD_SAFETY_POLICY"],
  ["autonomy", autonomy, "APK_BUILD_SAFETY_POLICY"],
  ["repair hints", hints, "APK_BUILD_SAFETY_POLICY"],
  ["anti-stuck", antiStuck, "APK_BUILD_SAFETY_POLICY"],
  ["script runner", runner, "BUILD_RECOVERY_SAFETY_POLICY"],
]) assert.ok(source.includes(marker), `${label} prompt does not consume the shared policy`);

assert.match(agent, /Ordinary missing task utilities may use the selected backend package manager/);
assert.match(agent, /Safety policy: .*BUILD_RECOVERY_SAFETY_POLICY/);
assert.match(hints, /termuxHint: "java-install"/);
assert.doesNotMatch(hints, /apt-get install -y openjdk-17-jdk|pkg install -y openjdk-17/);
assert.match(antiStuck, /const isJdk = toolId === "openjdk-17"/);
assert.match(antiStuck, /exact allowlisted recipe ID, not a shell install command/);
assert.doesNotMatch(runner, /pkg install -y openjdk-17|pkg install -y gradle/);
assert.match(runner, /runRepairRecipe\(recipeId, \{ allowMedium: true \}\)/);
assert.doesNotMatch(autonomy, /pkg install -y openjdk-17|apt-get install -y openjdk-17-jdk/);
assert.doesNotMatch(probe, /sdkmanager|pkg install|apt-get install/);
assert.match(tool, /Read-only verification/);

console.log("AIB_APK_POLICY_CONSISTENCY_SELFTEST_OK shared_source=1 prompts=7 jdk=recipe-id sdk=autonomous");
