#!/usr/bin/env node
import fs from "node:fs";
const fail = (m) => { console.error("AIB_AGENT_V308_FAIL", m); process.exit(1); };
const pb = fs.readFileSync("lib/agent-playbooks.ts", "utf8");
const goal = fs.readFileSync("lib/agent-goal.ts", "utf8");
const agent = fs.readFileSync("lib/termux-agent.ts", "utf8");
for (const m of ["tryGithubLocalPlaybook", "tryInterceptorPlaybook", "kind: \"tools\"", "github.materialize", "interceptor.enable"]) {
  if (!pb.includes(m)) fail("playbook:" + m);
}
if (!goal.includes("shouldBlockDoneForGoal")) fail("goal_gate_fn");
if (!agent.includes("GOAL_GATE_BLOCK") || !agent.includes("shouldBlockDoneForGoal")) fail("agent_goal_gate");
if (!agent.includes('playbook.kind === "tools"')) fail("agent_tool_playbook");
if (!agent.includes("github.pack")) fail("agent_pack_step");
if ((agent.match(/const agentGoal/g) || []).length !== 1) fail("duplicate_agentGoal");
console.log("AIB_AGENT_V308_SELFTEST_OK goal_gate+github_pb+interceptor_pb");
