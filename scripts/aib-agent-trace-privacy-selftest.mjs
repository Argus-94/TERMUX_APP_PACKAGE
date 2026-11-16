#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import { sanitizeAgentTraceForPersistence, sanitizePromotedFixtureForPersistence } from "../lib/agent-trace-privacy.ts";
import { redactPersistentLogPayload } from "../lib/log-redaction.ts";

const privateTask = ["private", "user", "task", "fixture-7391"].join("_");
const privateModelText = ["model", "response", "fixture-1842"].join("_");
const privateCommand = ["command", "fixture", "token-mock-2947"].join("_");
const trace = {
  id: "trace-safe-1",
  task: privateTask,
  startedAt: 100,
  status: "fail",
  apkPath: "/storage/emulated/0/private-project/output.apk",
  failureCluster: "network_deps",
  recipeId: "wget-curl",
  steps: [{
    kind: "tool",
    summary: privateModelText,
    command: privateCommand,
    stdoutPreview: privateModelText,
    stderrPreview: privateCommand,
    exitCode: 1,
    ok: false,
    meta: { attempt: 2, privatePath: "/home/user/private", payload: privateModelText },
  }],
  gates: [{ id: "absolute_apk_path", pass: false, detail: "/private/user/project/output.apk" }],
};
const safe = sanitizeAgentTraceForPersistence(trace);
assert.ok(safe);
const persisted = JSON.stringify(safe);
for (const privateValue of [privateTask, privateModelText, privateCommand, "/storage/emulated/0/private-project", "/private/user/project"]) {
  assert.equal(persisted.includes(privateValue), false, "trace persistence must omit free-form private content and paths");
}
assert.equal(safe.status, "fail");
assert.equal(safe.failureCluster, "network_deps");
assert.equal(safe.steps[0].exitCode, 1);
assert.equal(safe.steps[0].command, undefined);
assert.equal(safe.steps[0].stdoutPreview, undefined);
assert.equal(safe.gates[0].pass, false);

const promoted = sanitizePromotedFixtureForPersistence({
  id: "fixture-safe-1",
  sourceTraceId: "trace-safe-1",
  task: privateTask,
  cluster: "network_deps",
  recipeId: "wget-curl",
  sampleDoneFail: privateModelText,
  sampleDonePass: privateCommand,
  note: privateTask,
  createdAt: 123,
});
assert.ok(promoted);
const promotedText = JSON.stringify(promoted);
for (const privateValue of [privateTask, privateModelText, privateCommand]) {
  assert.equal(promotedText.includes(privateValue), false, "promoted fixture storage must retain classification, not text");
}
assert.equal(promoted.cluster, "network_deps");
assert.equal(promoted.recipeId, "wget-curl");

const privateToolPayload = ["private", "tool", "result", "fixture-5937"].join("_");
const agentToolEntry = redactPersistentLogPayload(
  "AgentTool",
  `← tool=fs.read traceId=trace-safe-1 exit=0 durationMs=27 args={"path":"private/path"}\n${privateToolPayload}`,
);
assert.match(agentToolEntry, /tool=fs\.read/);
assert.match(agentToolEntry, /exit=0/);
assert.match(agentToolEntry, /TOOL_PAYLOAD_OMITTED/);
assert.equal(agentToolEntry.includes(privateToolPayload), false, "AgentTool persistence must omit raw result evidence");
assert.equal(agentToolEntry.includes("private/path"), false, "AgentTool persistence must omit raw arguments");

const traceSource = fs.readFileSync(new URL("../lib/agent-trace.ts", import.meta.url), "utf8");
const agentSource = fs.readFileSync(new URL("../lib/termux-agent.ts", import.meta.url), "utf8");
const toolDispatcher = fs.readFileSync(new URL("../lib/agent-tools/index.ts", import.meta.url), "utf8");
assert.match(traceSource, /sanitizeAgentTraceForPersistence\(trace\)/);
assert.match(traceSource, /sanitizeAgentTraceForPersistence\(JSON\.parse\(body\)\)/);
assert.match(traceSource, /sanitizePromotedFixtureForPersistence/);
assert.doesNotMatch(agentSource, /persistentLogger\.add\(\s*"info",\s*"Termux",\s*`Новая задача:\s*\$\{userTask\}/);
assert.match(agentSource, /Новая задача: \[USER_TASK_OMITTED chars=\$\{userTask\.length\}\]/);
assert.doesNotMatch(toolDispatcher, /args=\$\{safeArgs\}|\$\{evidence\}/, "tool arguments and result bodies must not be passed to persistent logs");
console.log("AIB_AGENT_TRACE_PRIVACY_SELFTEST_OK task=response=command=output=private_path=omitted classification=retained");
