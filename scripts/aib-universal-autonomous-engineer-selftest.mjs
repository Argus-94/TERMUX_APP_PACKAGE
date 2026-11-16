#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const source = fs.readFileSync(path.join(root, "lib/autonomous-engineer.ts"), "utf8");
const required = [
  "NO HARDCODED PATHS",
  "CREATE MODE",
  "MODIFY MODE",
  "DEBUG MODE",
  "BUILD MODE",
  "TEST MODE",
  "RELEASE MODE",
  "FIRST ACTIONABLE ERROR",
  "NO BLIND RETRIES",
  "SELF-IMPROVING REPAIRS",
  "PROTECTED COMPILATION SETTINGS",
  "DONE DEFINITION",
];
for (const needle of required) assert.ok(source.includes(needle), `MISSING:${needle}`);

const promptMatch = source.match(/export const UNIVERSAL_AUTONOMOUS_ENGINEER_PROTOCOL = `([\s\S]*?)`;/);
assert.ok(promptMatch, "PROTOCOL_NOT_FOUND");
const prompt = promptMatch[1];
assert.ok(!prompt.includes("/storage/emulated/0/AIBuilderTermux/<name>"), "HARDCODED_PROJECT_EXAMPLE");
assert.ok(prompt.includes("Never assume /storage/emulated/0/AIBuilderTermux"), "DYNAMIC_PATH_CONTRACT_MISSING");
assert.ok(source.includes('errorFingerprint(text: string)'), "FINGERPRINT_API_MISSING");
assert.ok(source.includes('recordHealingAttempt(record: HealingRecord)'), "HEALING_RECORD_API_MISSING");

const promptBuilder = fs.readFileSync(path.join(root, "lib/ide-core-prompt.ts"), "utf8");
assert.ok(promptBuilder.includes("buildUniversalAgentPrompt(\"auto\")"), "CORE_PROMPT_NOT_WIRED");
const agent = fs.readFileSync(path.join(root, "lib/termux-agent.ts"), "utf8");
assert.ok(agent.includes("buildUniversalAgentPrompt("), "TERMUX_AGENT_NOT_WIRED");
const buildLoop = fs.readFileSync(path.join(root, "lib/build-loop.ts"), "utf8");
assert.ok(buildLoop.includes('buildUniversalAgentPrompt("build")'), "BUILD_RECOVERY_NOT_WIRED");

console.log("AIB_UNIVERSAL_AUTONOMOUS_ENGINEER_SELFTEST_OK modes=create,modify,debug,build,test,release paths=dynamic healing=guarded wiring=core+agent+build");
