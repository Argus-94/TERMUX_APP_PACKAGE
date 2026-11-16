#!/usr/bin/env node
import fs from "node:fs";
const fail = (m) => { console.error("AIB_AGENT_V310_FAIL", m); process.exit(1); };
const anti = fs.readFileSync("lib/agent-anti-stuck.ts", "utf8");
const agent = fs.readFileSync("lib/termux-agent.ts", "utf8");
const protocol = fs.readFileSync("lib/agent-engine.ts", "utf8");
if (!anti.includes("AntiStuckGoalHint") || !anti.includes("GOAL_CONTEXT")) fail("anti_goal_hint");
if (!anti.includes("Honest DONE example")) fail("anti_honest_done");
if (!agent.includes("mustExist: agentGoal.mustExist")) fail("agent_pass_goal");
if (!agent.includes("anti-stuck forceDone")) fail("scratch_forceDone");
if (!agent.includes("formatScratchBlock(sessionScratch)")) fail("scratch_refresh");
if (!protocol.includes("SESSION_MEMORY") || !protocol.includes("anti-stuck forceDone")) fail("protocol");
// Full stack still present
for (const f of [
  "lib/agent-env-state.ts",
  "lib/agent-goal.ts",
  "lib/agent-playbooks.ts",
  "lib/agent-session-memory.ts",
  "lib/agent-policy-router.ts",
]) {
  if (!fs.existsSync(f)) fail("missing " + f);
}
console.log("AIB_AGENT_V310_SELFTEST_OK anti_stuck↔goal+scratch+protocol FINAL");
