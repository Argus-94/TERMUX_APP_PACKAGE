#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { typescript } from "./test-helpers/load-typescript.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helperSource = fs.readFileSync(path.join(root, "lib/explicit-agent-tool-request.ts"), "utf8");
const compiled = typescript.transpile(helperSource, {
  module: typescript.ModuleKind.CommonJS,
  target: typescript.ScriptTarget.ES2022,
});
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aib-explicit-tool-route-"));
const modulePath = path.join(temp, "explicit-tool-request.cjs");
fs.writeFileSync(modulePath, compiled);
try {
  const { isExplicitAgentToolRequest } = createRequire(import.meta.url)(modulePath);
  for (const input of [
    "AIB_TOOL runtime.packages",
    "Please run AIB_TOOL runtime.status with the read-only status tool",
    'AIB_TOOL: {"tool":"runtime.packages","args":{"limit":10}}',
  ]) assert.equal(isExplicitAgentToolRequest(input), true, `explicit tool call should route to Agent: ${input}`);
  for (const input of [
    "What does AIB_TOOL mean?",
    "Explain runtime.packages in the source code",
    "Can you tell me whether the runtime is ready?",
    "AIB_TOOL",
  ]) assert.equal(isExplicitAgentToolRequest(input), false, `ordinary informational text must remain chat: ${input}`);

  const useLLM = fs.readFileSync(path.join(root, "hooks/useLLM.ts"), "utf8");
  const i18n = fs.readFileSync(path.join(root, "lib/i18n.ts"), "utf8");
  assert.match(useLLM, /const explicitAgentToolRequest = isExplicitAgentToolRequest\(message\)/);
  assert.match(useLLM, /if \(explicitAgentToolRequest && mode === "manus"\)[\s\S]*?explicitToolCloudModeRequired/);
  assert.match(useLLM, /if \(explicitAgentToolRequest && !termuxEnabled\)[\s\S]*?explicitToolAgentModeRequired/);
  assert.match(useLLM, /const chatOnly =\s*!explicitAgentToolRequest &&/);
  assert.match(useLLM, /intent\.needed \|\| strongCreate \|\| isSharedStorageOnlyUserTask\(message\) \|\| explicitAgentToolRequest/);
  assert.match(useLLM, /if \(!explicitAgentToolRequest && \(chatOnly \|\| isSmallTalkMessage/,
    "explicit tool calls must bypass the chat-only safety net after Agent routing");
  assert.match(useLLM, /if \(explicitAgentToolRequest\) return t\("agentBusy"\)/,
    "an explicit tool call must not silently downgrade to a normal model if another session owns the Agent");
  assert.equal((i18n.match(/explicitToolAgentModeRequired:/g) || []).length, 3, "disabled-mode guidance must exist in every locale");
  assert.equal((i18n.match(/explicitToolCloudModeRequired:/g) || []).length, 3, "cloud-mode guidance must exist in every locale");
  console.log("AIB_V505_EXPLICIT_AGENT_TOOL_ROUTING_OK explicit=AIB_TOOL|json ordinary_chat=preserved disabled_mode=blocked manus_cloud=blocked busy=no_downgrade");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
