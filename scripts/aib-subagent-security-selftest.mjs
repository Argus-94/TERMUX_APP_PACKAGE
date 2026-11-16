import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const subagents = fs.readFileSync(path.join(root, "lib/subagents.ts"), "utf8");
const executor = fs.readFileSync(path.join(root, "lib/termux-executor.ts"), "utf8");
const agentTools = fs.readFileSync(path.join(root, "lib/agent-tools.ts"), "utf8");
const termuxAgent = fs.readFileSync(path.join(root, "lib/termux-agent.ts"), "utf8");
const modelHelpers = ["lib/agent-tools.ts","lib/ast-tools.ts","lib/lsp.ts","lib/github-tools.ts","lib/agent-skills.ts"].map(f => fs.readFileSync(path.join(root,f),"utf8")).join("\n");

if (/from\s+["']\.\/termux-bridge["']/.test(subagents) || /runShellCommand\s*\(/.test(subagents)) {
  throw new Error("A01_FAIL_SUBAGENT_DIRECT_TERMUX_BRIDGE");
}
if (!subagents.includes("executeReadOnlyTermuxCommand")) throw new Error("A01_FAIL_SUBAGENT_NO_CENTRAL_EXECUTOR");
if (!executor.includes("guardTermuxCommand") || !executor.includes("runShellCommand")) {
  throw new Error("A01_FAIL_EXECUTOR_NOT_BOUND_TO_GUARD_AND_BRIDGE");
}
if (!agentTools.includes("executeGuardedTermuxCommand(command")) throw new Error("A01_FAIL_BUILD_TOOL_BYPASS");
if (!termuxAgent.includes("executeGuardedTermuxCommand(effectiveCmd")) throw new Error("A01_FAIL_MAIN_AGENT_BYPASS");
if (/runShellCommand\s*\(/.test(modelHelpers)) throw new Error("A01_FAIL_MODEL_TOOL_HELPER_BYPASS");
if (!/termux-executor/.test(modelHelpers)) throw new Error("A01_FAIL_MODEL_TOOL_HELPER_NO_EXECUTOR");
if (termuxAgent.includes("guardTermuxCommand(command")) throw new Error("A01_FAIL_DUPLICATE_MAIN_GUARD");
console.log("AIB_SUBAGENT_SECURITY_SELFTEST_OK");
