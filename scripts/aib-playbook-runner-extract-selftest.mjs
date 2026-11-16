#!/usr/bin/env node
import fs from "node:fs";
const fail = (m) => { console.error("AIB_PLAYBOOK_EXTRACT_FAIL", m); process.exit(1); };
const runner = fs.readFileSync("lib/agent-playbook-runner.ts", "utf8");
const agent = fs.readFileSync("lib/termux-agent.ts", "utf8");
if (!runner.includes("executeDeterministicPlaybook")) fail("no_exec");
if (!runner.includes("preferGuest") || !runner.includes("__MATERIALIZE_BUILD__")) fail("no_logic");
if (!agent.includes("executeDeterministicPlaybook")) fail("not_wired");
// Old inline block must be gone
if (agent.includes("preferGuest rootfs=")) fail("inline_still_present");
if (!fs.existsSync("lib/agent-anti-stuck.ts")) fail("anti");
const anti = fs.readFileSync("lib/agent-anti-stuck.ts", "utf8");
if (/\.join\(\s*"\s*\n\s*"\s*\)/.test(anti)) fail("broken_join");
console.log("AIB_PLAYBOOK_RUNNER_EXTRACT_SELFTEST_OK modular+metro_safe");
