#!/usr/bin/env node
import fs from "node:fs";
const fail = (m) => { console.error("AIB_AGENT_V311_AUDIT_FAIL", m); process.exit(1); };
const anti = fs.readFileSync("lib/agent-anti-stuck.ts", "utf8");
const agent = fs.readFileSync("lib/termux-agent.ts", "utf8");
const gh = fs.readFileSync("lib/github-tools.ts", "utf8");
const rt = fs.readFileSync("app/runtime.tsx", "utf8");
const m = anti.match(/return lines\.join\((.*?)\);/s);
if (!m) fail("join_missing");
const arg = m[1].trim();
// Accept TypeScript "\n" (backslash-n inside quotes)
if (arg !== '"\\n"' && arg !== "'\\n'" && arg.replace(/\s/g, "") !== '"\\n"') {
  // Also accept actual newline between quotes only if it's the two-char escape written as \n
  const normalized = JSON.stringify(arg);
  if (!normalized.includes("\\n")) fail("join_not_newline:" + normalized);
}
if (!anti.includes("GOAL_CONTEXT")) fail("goal_context");
if (!agent.includes("skipRootfsForGoal") || !agent.includes('earlyGoalKind === "interceptor"')) fail("preflight_interceptor_skip");
if (!agent.includes("agentPolicy.forceHostTermux")) fail("policy_host");
if (!agent.includes("GOAL_GATE_BLOCK")) fail("goal_gate");
if (gh.indexOf("export async function githubApplyFiles") > gh.indexOf("export async function githubWriteFile")) fail("write_before_apply");
if (!rt.includes("maxHeight: 52") || !rt.includes("height: 48")) fail("runtime_btn");
console.log("AIB_AGENT_V311_AUDIT_SELFTEST_OK");
