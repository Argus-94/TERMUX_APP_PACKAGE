#!/usr/bin/env node
import fs from "node:fs";
const fail = (m) => { console.error("AIB_METRO_SYNTAX_GUARD_FAIL", m); process.exit(1); };
const anti = fs.readFileSync("lib/agent-anti-stuck.ts", "utf8");
if (/\.join\(\s*"\s*\n\s*"\s*\)/.test(anti)) fail("broken_lines_join");
const runner = fs.readFileSync("lib/agent-playbook-runner.ts", "utf8");
if (!runner.includes("resolvePlaybookToolArgs") || !runner.includes("__MATERIALIZE_BUILD__")) fail("runner");
if (!runner.includes("executeDeterministicPlaybook")) fail("exec");
const agent = fs.readFileSync("lib/termux-agent.ts", "utf8");
if (!agent.includes("executeDeterministicPlaybook")) fail("agent_not_wired");
console.log("AIB_METRO_SYNTAX_GUARD_SELFTEST_OK join+runner");
