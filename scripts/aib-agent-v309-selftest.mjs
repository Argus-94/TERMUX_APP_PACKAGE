#!/usr/bin/env node
import fs from "node:fs";
const fail = (m) => { console.error("AIB_AGENT_V309_FAIL", m); process.exit(1); };
for (const f of ["lib/agent-session-memory.ts", "lib/agent-policy-router.ts"]) {
  if (!fs.existsSync(f)) fail("missing " + f);
}
const mem = fs.readFileSync("lib/agent-session-memory.ts", "utf8");
const pol = fs.readFileSync("lib/agent-policy-router.ts", "utf8");
const pb = fs.readFileSync("lib/agent-playbooks.ts", "utf8");
const agent = fs.readFileSync("lib/termux-agent.ts", "utf8");
const anti = fs.readFileSync("lib/agent-anti-stuck.ts", "utf8");
for (const m of ["createSessionScratchpad", "formatScratchBlock", "[SESSION_MEMORY]"]) if (!mem.includes(m)) fail("mem:" + m);
for (const m of ["routeAgentPolicy", "formatPolicyBlock", "forceHostTermux", "interceptor.status"]) if (!pol.includes(m)) fail("pol:" + m);
if (!pb.includes("tryApkBuildPlaybook") || !pb.includes("assembleDebug")) fail("apk_pb");
if (!agent.includes("sessionScratch") || !agent.includes("agentPolicy") || !agent.includes("policyBlock")) fail("agent_wire");
if (!agent.includes("agentPolicy.forceHostTermux")) fail("host_policy");
if (!anti.includes("GOAL_AWARE")) fail("anti_goal");
console.log("AIB_AGENT_V309_SELFTEST_OK memory+policy+apk_pb+anti_goal");
