#!/usr/bin/env node
import fs from "node:fs";
const fail = (m) => { console.error("AIB_GOAL_GATE_FAIL", m); process.exit(1); };
const gate = fs.readFileSync("lib/agent-goal-gate.ts", "utf8");
const agent = fs.readFileSync("lib/termux-agent.ts", "utf8");
const goal = fs.readFileSync("lib/agent-goal.ts", "utf8");
if (!gate.includes("runGoalDoneGate") || !gate.includes("shouldBlockDoneForGoal")) fail("gate");
if (!agent.includes("runGoalDoneGate")) fail("agent");
if (!goal.includes("must_exist_from") && !goal.includes("mustExistTo")) fail("goal_to");
console.log("AIB_GOAL_GATE_MODULE_SELFTEST_OK");
