#!/usr/bin/env node
import fs from "node:fs";
const fail = (m) => { console.error("AIB_AGENT_ENV_GOAL_FAIL", m); process.exit(1); };
for (const f of ["lib/agent-env-state.ts", "lib/agent-goal.ts", "lib/agent-playbooks.ts"]) {
  if (!fs.existsSync(f)) fail("missing:" + f);
}
const env = fs.readFileSync("lib/agent-env-state.ts", "utf8");
const goal = fs.readFileSync("lib/agent-goal.ts", "utf8");
const pb = fs.readFileSync("lib/agent-playbooks.ts", "utf8");
const agent = fs.readFileSync("lib/termux-agent.ts", "utf8");
const types = fs.readFileSync("lib/agent-tools/types.ts", "utf8");
const idx = fs.readFileSync("lib/agent-tools/index.ts", "utf8");
const protocol = fs.readFileSync("lib/agent-engine.ts", "utf8");
const runner = fs.readFileSync("lib/agent-playbook-runner.ts", "utf8");
for (const m of ["buildAgentEnvState", "formatEnvStateBlock", "[ENV_STATE]"]) if (!env.includes(m)) fail("env:" + m);
for (const m of ["parseAgentGoal", "formatGoalBlock", "file_write", "interceptor", "AIB_GOAL_OK"]) if (!goal.includes(m)) fail("goal:" + m);
for (const m of ["tryFileWritePlaybook", "tryPlaybook", "AIB_GOAL_OK"]) if (!pb.includes(m)) fail("pb:" + m);
if (!agent.includes("tryPlaybook") || !agent.includes("executeDeterministicPlaybook") || !runner.includes('resultMarker: "PLAYBOOK_OK"')) fail("agent_playbook");
if (!agent.includes("envStateBlock") || !agent.includes("goalBlock")) fail("agent_env_goal_inject");
for (const t of ["interceptor.status", "interceptor.enable", "interceptor.disable", "interceptor.last", "interceptor.detail", "interceptor.command", "interceptor.ruleToggle", "interceptor.rulesDisable"]) {
  if (!types.includes(`"${t}"`)) fail("type:" + t);
  if (!idx.includes(`"${t}"`)) fail("idx:" + t);
}
if (!protocol.includes("interceptor.status") || !protocol.includes("ENV_STATE")) fail("protocol");
if (!fs.existsSync("lib/agent-tools/interceptor/status.ts")) fail("interceptor_tool_files");
console.log("AIB_AGENT_ENV_GOAL_SELFTEST_OK env+goal+playbook+interceptor=8");
