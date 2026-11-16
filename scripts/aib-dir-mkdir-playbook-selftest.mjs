#!/usr/bin/env node
import fs from "node:fs";
const fail = (m) => { console.error("AIB_DIR_MKDIR_FAIL", m); process.exit(1); };
const goal = fs.readFileSync("lib/agent-goal.ts", "utf8");
const pb = fs.readFileSync("lib/agent-playbooks.ts", "utf8");
const agent = fs.readFileSync("lib/termux-agent.ts", "utf8");
if (!goal.includes('"dir_mkdir"') || !goal.includes("test -d")) fail("goal");
if (!pb.includes("tryDirMkdirPlaybook") || !pb.includes("preferGuest")) fail("playbook");
if (!agent.includes("preferGuest") || !agent.includes("retry host Termux")) fail("runner");
console.log("AIB_DIR_MKDIR_PLAYBOOK_SELFTEST_OK guest_first+host_fallback");
