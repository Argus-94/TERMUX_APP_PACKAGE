import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const bridge = fs.readFileSync(path.join(root, "lib/termux-bridge.ts"), "utf8");
const tools = fs.readFileSync(path.join(root, "lib/agent-tools/index.ts"), "utf8");
const backend = fs.readFileSync(path.join(root, "lib/agent-shell-backend.ts"), "utf8");

function ok(condition, message) {
  if (!condition) throw new Error(message);
}

ok(bridge.includes("commandContexts"), "COMMAND_CONTEXT_MAP_MISSING");
ok(bridge.includes("commandStreamBuffers"), "PER_COMMAND_STREAM_BUFFER_MISSING");
ok(bridge.includes("Linux:${ctx!.label}:lifecycle"), "LINUX_LIFECYCLE_LOGGING_MISSING");
ok(bridge.includes('step: "native.heartbeat"') && bridge.includes('target: isLinux ? "ubuntu" : "termux"'), "LINUX_HEARTBEAT_TARGET_LOGGING_MISSING");
ok(bridge.includes("Linux:${label}:${commandId}:stdout"), "LINUX_STDOUT_LOGGING_MISSING");
ok(bridge.includes("Linux:${label}:${commandId}:stderr"), "LINUX_STDERR_LOGGING_MISSING");
ok(bridge.includes("backend=${backend}"), "BACKEND_CORRELATION_MISSING");
ok(bridge.includes("guest command id=${commandId}"), "GUEST_COMMAND_LOGGING_MISSING");
ok(bridge.includes("commandStreamBuffers.delete(commandId)"), "STREAM_CONTEXT_CLEANUP_MISSING");
ok(tools.includes("→ tool=${name}"), "AGENT_TOOL_START_LOGGING_MISSING");
ok(tools.includes("← tool=${name}"), "AGENT_TOOL_RESULT_LOGGING_MISSING");
ok(tools.includes("× tool=${name}"), "AGENT_TOOL_ERROR_LOGGING_MISSING");
ok(backend.includes('"ubuntu-proot"') && backend.includes('"ubuntu-proot"'), "LINUX_BACKENDS_MISSING");
ok(tools.includes("traceId=${context?.traceId"), "AGENT_TRACE_ID_LOGGING_MISSING");
ok(bridge.includes("traceId=${traceId}"), "SHELL_TRACE_ID_LOGGING_MISSING");

console.log("AIB_LINUX_LOGGING_SELFTEST_OK backend=termux|ubuntu-proot agent_tools=full output=stdout+stderr lifecycle=correlated");
