#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAgentGoal } from "../lib/agent-goal.ts";
import { tryDirMkdirPlaybook, tryFileRenamePlaybook, tryInterceptorPlaybook } from "../lib/agent-playbooks.ts";
import { goalVerifyPassed } from "../lib/agent-goal.ts";
import { guardTermuxCommand } from "../lib/termux-guard.ts";
import { setAgentUnrestrictedShell } from "../lib/agent-unrestricted.ts";
setAgentUnrestrictedShell(false); // strict-guard scenarios; v389 default covered by aib-v389-guard-selftest
import { checkSkillPin, parseLocalSkill } from "../lib/agent-skill-registry.ts";
import { buildKnowledgeContext, projectKnowledgeSlug } from "../lib/agent-knowledge.ts";
import { createUsageMeter, recordUsageStep, finishUsageMeter } from "../lib/agent-usage-meter.ts";
import { classifyAgentOperationClass } from "../lib/agent-operation-class.ts";
import { fingerprintFailureKey } from "../lib/agent-failure-fixture.ts";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
// S1: Termux Download mkdir classifies to a deterministic shell playbook and goal gate marker.
const s1Goal = parseAgentGoal("создай папку 88888 в Download");
assert.equal(s1Goal.kind, "dir_mkdir");
assert.ok(tryDirMkdirPlaybook(s1Goal).command.includes("AIB_GOAL_OK"));
assert.ok(tryDirMkdirPlaybook(s1Goal).command.includes("/storage/emulated/0/Download/88888"));
// S2/S3: preserve selected Ubuntu guest-first and host-only fallback contract; no device command is executed.
const runner = read("lib/agent-playbook-runner.ts");
assert.match(runner, /mode === "preferGuest"/);
assert.match(runner, /rootfs=.*UNVERIFIED/);
assert.match(runner, /hostTermux: useHost/);
assert.match(runner, /buildProotDistroRootfsCheckCommand/);
// S4: rename playbook verifies old path absence and new path presence.
const rename = tryFileRenamePlaybook(parseAgentGoal("переименуй a.txt в b.txt в Download"));
assert.equal(rename.id, "file_rename_shared");
assert.match(rename.command, /test ! -e/);
assert.match(rename.command, /test -e/);
// S5: fake DONE without verified output is blocked by GOAL contract; failure fixture has a separate unmet golden.
assert.equal(goalVerifyPassed("", ""), false);
assert.match(read("lib/agent-failure-fixture.ts"), /fp-golden-goal-unmet/);
assert.match(read("lib/termux-agent.ts"), /resultMarker: "GOAL_GATE_BLOCK"/);
assert.match(read("lib/termux-agent.ts"), /await persistFailureFixture\(trajectory, failureCode\)/);
// S6/S7: materialize/build routing and intelligence-off rejection remain in the main loop.
assert.match(read("lib/agent-playbooks.ts"), /github\.materialize/);
assert.match(read("lib/agent-playbooks.ts"), /build\.run/);
assert.match(read("lib/termux-agent.ts"), /INTELLIGENCE_DISABLED: github tools are OFF/);
// S8: knowledge notes are bounded and project-keyed; live device recall is not invoked here.
assert.equal(projectKnowledgeSlug("/storage/emulated/0/Work/Demo App"), "demo-app");
assert.equal(await buildKnowledgeContext(undefined), "");
assert.match(read("lib/agent-knowledge.ts"), /last verified artifact/);
assert.match(read("lib/agent-knowledge.ts"), /fingerprint=/);
// S9: local version pin mismatch blocks verify.
const skill = parseLocalSkill("s9", "---\nname: s9\nversion: 1.0.0\ndescription: local\n---\ntext");
assert.ok(skill);
assert.equal(checkSkillPin({ ...skill, version: "1.0.1" }, { s9: { version: skill.version, hash: skill.hash, updatedAt: 1 } }).ok, false);
// S10: destructive commands confirm, ordinary shared mkdir remains allowed.
assert.equal(guardTermuxCommand("rm -rf /storage/emulated/0/Download/x").confirmable, true);
assert.equal(guardTermuxCommand("mkdir -p /storage/emulated/0/Download/x").ok, true);
assert.equal(guardTermuxCommand("proot-distro reset ubuntu").confirmable, true);
assert.equal(guardTermuxCommand("zip -FS out.zip src").confirmable, true);
assert.equal(classifyAgentOperationClass({ command: "ls -la" }), "read");
assert.equal(classifyAgentOperationClass({ command: "mkdir -p /storage/emulated/0/Download/x" }), "write-shared");
assert.equal(classifyAgentOperationClass({ tool: "fs.create", projectPath: "/workspace/app", targetPath: "/workspace/app/src/a.ts" }), "write-project");
assert.equal(classifyAgentOperationClass({ command: "rm -rf /storage/emulated/0/Download/x" }), "shell-destructive");
assert.equal(classifyAgentOperationClass({ command: "curl https://example.invalid" }), "network");
assert.equal(classifyAgentOperationClass({ tool: "github.read" }), "github");
// S11: system root mutation is rejected; shared path exception remains.
assert.equal(guardTermuxCommand("mkdir -p /data/local/tmp/x").ok, false);
assert.match(read("lib/user-storage-paths.ts"), /SYSTEM_PATH_RE/);
// S12: interceptor enable remains a tools playbook and does not request rootfs.
assert.equal(tryInterceptorPlaybook(parseAgentGoal("enable interceptor")).id, "interceptor_enable");
// S13: step ceiling / anti-stuck forceDone remain present; failed runs can freeze a fixture.
assert.match(read("lib/termux-agent.ts"), /forceDone/);
assert.match(read("lib/termux-agent.ts"), /action: "anti-stuck\.force-done"/);
const antiStuckKey = fingerprintFailureKey("build:private path and error detail");
assert.match(antiStuckKey, /^fp-[a-f0-9]{8}$/);
assert.equal(antiStuckKey, fingerprintFailureKey("build:private path and error detail"));
assert.match(read("lib/agent-anti-stuck.ts"), /MAX_SAME_CMD_STREAK/);
// S14: offline provider with no token usage still persists step/time counters.
const meter = createUsageMeter(100, null);
recordUsageStep(meter);
finishUsageMeter(meter, 240);
assert.equal(meter.steps, 1);
assert.equal(meter.durationMs, 140);
assert.equal(meter.tokens, null);
console.log("AIB_AGENT_PLAN_SCENARIOS_SELFTEST_OK S1-S14=14 structural/offline scenarios; no Android or network side effects");
