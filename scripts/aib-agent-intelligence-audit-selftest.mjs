#!/usr/bin/env node
import fs from "node:fs";
const fail = (m) => { console.error("AIB_INTEL_AUDIT_FAIL", m); process.exit(1); };
const protocol = fs.readFileSync("lib/termux-agent-protocol.ts", "utf8");
const agent = fs.readFileSync("lib/termux-agent.ts", "utf8");
const intel = fs.readFileSync("lib/agent-intelligence.ts", "utf8");
const llm = fs.readFileSync("hooks/useLLM.ts", "utf8");
const orch = fs.readFileSync("lib/agent-orchestrator.ts", "utf8");
if (!protocol.includes("emulated") || !protocol.includes("sdcard")) fail("hashline_shared_storage");
if (!protocol.includes("isDirectSourceMutationCommand")) fail("hashline_fn");
for (const x of ["INTELLIGENCE_DISABLED", "github tools are OFF", "AST tools are OFF", "LSP tools are OFF"]) {
  if (!agent.includes(x)) fail("gate:" + x);
}
if (!intel.includes("DISABLED_TOOLS") || !intel.includes("disabledTools")) fail("prompt_disabled");
if (!llm.includes("buildPreflightContext(")) fail("preflight_not_called");
if (!llm.includes("intelligenceSettings.subagents")) fail("subagents_trigger");
if (!orch.includes("runSubagents") || !orch.includes("buildPreflightContext")) fail("orch");
if (!intel.includes("hashline: false") || !intel.includes("subagents: false")) fail("defaults");
console.log("AIB_AGENT_INTELLIGENCE_AUDIT_SELFTEST_OK gates+hashline+preflight+prompt");
