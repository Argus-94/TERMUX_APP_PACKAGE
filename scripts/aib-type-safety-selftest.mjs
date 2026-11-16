import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const files = [
  "hooks/useLLM.ts",
  "hooks/useAppSettings.ts",
  "lib/termux-bridge.ts",
  "lib/agent-tools.ts",
  "lib/termux-agent.ts",
];
for (const rel of files) {
  const text = fs.readFileSync(path.join(root, rel), "utf8");
  if (/catch\s*\([^)]*:\s*any\)/.test(text)) throw new Error(`UNTYPED_CATCH_ANY:${rel}`);
}
const agentTools = fs.readFileSync(path.join(root, "lib/agent-tools.ts"), "utf8");
if (!/validateAgentToolCall\(spec:\s*unknown\)/.test(agentTools)) throw new Error("AGENT_TOOL_BOUNDARY_NOT_UNKNOWN");
if (!/executeAgentTool\(name:AgentToolName,args:Record<string, unknown>/.test(agentTools)) throw new Error("AGENT_TOOL_ARGS_NOT_TYPED");
const bridge = fs.readFileSync(path.join(root, "lib/termux-bridge.ts"), "utf8");
if (!/TermuxCommandOutputEvent/.test(bridge) || !/\(ev: TermuxCommandOutputEvent\)/.test(bridge)) throw new Error("TERMUX_EVENT_BOUNDARY_NOT_TYPED");
const agent = fs.readFileSync(path.join(root, "lib/termux-agent.ts"), "utf8");
if (/__reverseActivity as \{ stages: any\[\]/.test(agent)) throw new Error("REVERSE_ACTIVITY_ANY_BOUNDARY");
console.log("AIB_TYPE_SAFETY_SELFTEST_OK critical_boundaries=5 catches=unknown");
