import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const fail = (m) => { throw new Error(`AIB_SOURCE_COMPILE_AUDIT_FAIL:${m}`); };

const index = read("core/index.ts");
if ((index.match(/launchUbuntuForProject/g) || []).length !== 1) fail("public_ubuntu_project_launcher_contract_missing_or_duplicated");

const env = read("core/environment/ExecutionEnvironment.ts");
if (!env.includes("Promise<EnvironmentExecResult>")) fail("environment_exec_result_contract_missing");

const agent = read("lib/termux-agent.ts");
if (!agent.includes("const closeAgentTrace =")) fail("closeAgentTrace_missing");
if (!agent.includes('closeAgentTrace("pass", m[1])')) fail("invalid_trace_status");
if (agent.includes("Buffer.from(lastFailure")) fail("react_native_buffer_usage");
if (!agent.includes("utf8ToBase64(lastFailure")) fail("base64_helper_missing");
if (!agent.includes('status: "pending" | "active" | "done" | "error" | "skipped"')) fail("activity_skipped_status_missing");

const facade = read("lib/agent-tools.ts");
if (!facade.includes("context?: ToolExecutionContext")) fail("agent_tool_trace_context_missing");
if (!read("lib/agent-tools/types.ts").includes("traceId?: string")) fail("agent_tool_trace_id_type_missing");

const bridge = read("lib/termux-bridge.ts");
if (!bridge.includes("traceId?: string")) fail("shell_trace_context_missing");

const runtimeI18n = read("lib/runtime-i18n.ts");
for (const key of ["runningDevice", "selfHealingRunning", "releaseGateRunning", "releaseBundleRunning", "releaseChannel", "publishingChannel", "rollingBack", "productionDeploying", "fleetDeploying", "fleetCanaryRunning", "fleetObservabilityRunning", "fleetRole", "productionPhrase", "saveFleetPolicy", "backupSecret", "unifiedControlRunning", "fleetEscalationRunning", "fleetSloRunning"]) {
  if (!new RegExp(`\\b${key}\\b`).test(runtimeI18n)) fail(`runtime_i18n_key_missing:${key}`);
}

const guide = read("lib/settings-guide.ts");
if (/\},,\s*\{/.test(guide)) fail("settings_guide_empty_element");
if (!guide.includes('kind?: "model" | "mmproj" | "archive" | "other"')) fail("guide_download_kind_missing");
if (!guide.includes("hint?: Record<GuideLang, string>")) fail("guide_download_hint_missing");

const multimodal = read("lib/multimodal-router.ts");
if (multimodal.includes('["VISION"]')) fail("invalid_model_capability_vision");
if (!multimodal.includes('"VISION_INPUT"')) fail("vision_input_capability_missing");

const protectedFiles = ["package.json", "pnpm-lock.yaml", "eas.json", "tsconfig.json", "metro.config.js", "gradle.properties"];
for (const rel of protectedFiles) {
  if (!fs.existsSync(path.join(root, rel))) fail(`protected_file_missing:${rel}`);
}

console.log("AIB_SOURCE_COMPILE_AUDIT_SELFTEST_OK blockers=fixed settings=protected runtime_contract=typed native_compat=guarded");
