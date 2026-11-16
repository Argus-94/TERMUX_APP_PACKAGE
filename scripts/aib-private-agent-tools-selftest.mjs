#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { typescript } from "./test-helpers/load-typescript.mjs";

const root = process.cwd();
const policySource = fs.readFileSync(path.join(root, "lib/agent-private-tool-policy.ts"), "utf8");
const compiledPolicy = typescript.transpile(policySource, {
  module: typescript.ModuleKind.CommonJS,
  target: typescript.ScriptTarget.ES2022,
});
const policyPath = path.join(os.tmpdir(), `aib-private-tool-policy-${process.pid}.cjs`);
fs.writeFileSync(policyPath, compiledPolicy);
try {
  const { privateAgentToolUnsupportedReason } = createRequire(import.meta.url)(policyPath);
  const safeTools = [
    "runtime.status",
    "runtime.packages",
    "workspace.list",
    "workspace.read",
    "workspace.write",
    "diagnostics.log",
    "ctx.expand",
    "ctx.metrics",
    "github.parse",
    "interceptor.status",
    "interceptor.last",
    "interceptor.detail",
  ];
  const githubApiTools = [
    "github.read", "github.tree", "github.list", "github.diff", "github.prFiles", "github.search",
    "github.searchIssues", "github.repo", "github.branches", "github.commits", "github.commit", "github.tags",
    "github.releases", "github.release", "github.prList", "github.issue", "github.repoCreate", "github.branch",
    "github.apply", "github.prCreate", "github.prMerge", "github.issueCreate", "github.issueComment", "github.rename", "github.write",
  ];
  for (const tool of safeTools) {
    assert.equal(privateAgentToolUnsupportedReason(tool, "embedded-private"), null, `${tool} is admitted only by its declared private capability`);
  }
  for (const tool of githubApiTools) {
    assert.equal(privateAgentToolUnsupportedReason(tool, "embedded-private"), null, `${tool} is admitted only as a registered typed GitHub API operation`);
  }
  assert.equal(privateAgentToolUnsupportedReason("workspace.list", "selected-backend"), "AGENT_SHELL_TARGET_INVALID",
    "direct legacy-target injection is rejected before tool policy can dispatch externally");
  assert.equal(privateAgentToolUnsupportedReason("workspace.read", "selected-backend"), "AGENT_SHELL_TARGET_INVALID",
    "direct legacy-target injection is rejected before tool policy can dispatch externally");
  assert.equal(privateAgentToolUnsupportedReason("workspace.write", "selected-backend"), "AGENT_SHELL_TARGET_INVALID",
    "workspace.write cannot run on a selected external backend");
  assert.equal(privateAgentToolUnsupportedReason("workspace.read", "embedded-private"), null,
    "workspace.read is admitted only to the dedicated native workspace API");
  assert.equal(privateAgentToolUnsupportedReason("workspace.write", "embedded-private"), null,
    "workspace.write is admitted only to the dedicated native workspace API");
  assert.equal(privateAgentToolUnsupportedReason("build.run", "embedded-private"), null,
    "build.run is admitted only to its exact offline/private adapter");
  const denials = new Map([
    ["pkg.ensure", "AIB_TOOL_PRIVATE_PACKAGE_INSTALL_UNSUPPORTED"],
    ["toolchain.ensure", "AIB_TOOL_PRIVATE_TOOLCHAIN_UNSUPPORTED"],
    ["fs.read", "AIB_TOOL_PRIVATE_PROJECT_PATH_UNSUPPORTED"],
    ["ast.edit", "AIB_TOOL_PRIVATE_PROJECT_PATH_UNSUPPORTED"],
    ["lsp.diagnostics", "AIB_TOOL_PRIVATE_PROJECT_PATH_UNSUPPORTED"],
    ["ctx.compose", "AIB_TOOL_PRIVATE_PROJECT_PATH_UNSUPPORTED"],
    ["skills.read", "AIB_TOOL_PRIVATE_PROJECT_PATH_UNSUPPORTED"],
    ["memory.recall", "AIB_TOOL_PRIVATE_PROJECT_PATH_UNSUPPORTED"],
    ["github.materialize", "AIB_TOOL_PRIVATE_PROJECT_PATH_UNSUPPORTED"],
    ["github.downloadAsset", "AIB_TOOL_PRIVATE_PROJECT_PATH_UNSUPPORTED"],
    ["github.pack", "AIB_TOOL_PRIVATE_PROJECT_PATH_UNSUPPORTED"],
    ["github.copy", "AIB_TOOL_PRIVATE_PROJECT_PATH_UNSUPPORTED"],
    ["github.unknown", "AIB_TOOL_PRIVATE_NETWORK_UNSUPPORTED"],
    ["hardware.probe", "AIB_TOOL_PRIVATE_SHARED_STORAGE_UNSUPPORTED"],
    ["runtime.terminal", "AIB_TOOL_PRIVATE_HOST_RUNTIME_UNSUPPORTED"],
    ["runtime.proot", "AIB_TOOL_PRIVATE_HOST_RUNTIME_UNSUPPORTED"],
    ["runtime.session", "AIB_TOOL_PRIVATE_PROJECT_PATH_UNSUPPORTED"],
    ["interceptor.enable", "AIB_TOOL_PRIVATE_HOST_NETWORK_CONTROL_UNSUPPORTED"],
    ["unknown.tool", "AIB_TOOL_PRIVATE_CAPABILITY_UNSUPPORTED"],
  ]);
  for (const [tool, expected] of denials) {
    assert.equal(privateAgentToolUnsupportedReason(tool, "embedded-private"), expected, `${tool} has a typed private denial`);
    assert.equal(privateAgentToolUnsupportedReason(tool, "selected-backend"), "AGENT_SHELL_TARGET_INVALID", `${tool} rejects direct legacy-target injection before dispatch`);
  }
  assert.equal(privateAgentToolUnsupportedReason("fs.read", "bad-target"), "AGENT_SHELL_TARGET_INVALID");

  const out = fs.mkdtempSync(path.join(os.tmpdir(), "aib-private-agent-tools-"));
  try {
    const runtimeDir = path.join(out, "lib", "agent-tools", "runtime");
    const libDir = path.join(out, "lib");
    const coreDir = path.join(out, "core");
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.mkdirSync(coreDir, { recursive: true });
    const state = { snapshotCalls: 0, privateCalls: [], response: null, error: null };
    fs.writeFileSync(path.join(libDir, "runtime-facade.js"), [
      "exports.getRuntimeFacade = () => ({ facade: true });",
    ].join("\n"));
    fs.writeFileSync(path.join(coreDir, "RuntimeStatus.js"), [
      "exports.snapshotRuntimeStatus = async () => { global.__statusState.snapshotCalls += 1; return global.__statusState.snapshot; };",
    ].join("\n"));
    fs.writeFileSync(path.join(libDir, "private-runtime-provider.js"), [
      "exports.privateRuntimeProvider = {",
      "  execute: async (command, options) => {",
      "    global.__statusState.privateCalls.push({ command, options });",
      "    if (global.__statusState.error) throw global.__statusState.error;",
      "    return global.__statusState.response;",
      "  },",
      "};",
    ].join("\n"));

    const statusSource = fs.readFileSync(path.join(root, "lib/agent-tools/runtime/status.ts"), "utf8");
    const statusPath = path.join(runtimeDir, "status.js");
    fs.writeFileSync(statusPath, typescript.transpile(statusSource, {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022,
    }));
    const snapshot = { runtimeIdentity: { appVersion: "test" }, home: "runtime-home" };
    state.snapshot = snapshot;
    global.__statusState = state;
    const status = createRequire(import.meta.url)(statusPath);

    const selected = await status.execute({}, "/legacy/project", { executionTarget: "selected-backend", traceId: "legacy" });
    assert.equal(selected, snapshot, "selected-backend runtime.status returns the exact prior snapshot unchanged");
    assert.equal(state.privateCalls.length, 0, "selected-backend does not start the private probe");

    state.response = {
      stdout: "AIB_PRIVATE_RUNTIME_STATUS_V1\n",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      outputTruncated: false,
    };
    const privateStatus = await status.execute({}, "/storage/emulated/0/shared-project", {
      executionTarget: "embedded-private",
      traceId: "private-status-test",
    });
    assert.deepEqual(privateStatus.agentShellProbe, {
      target: "embedded-private",
      ready: true,
      capability: "native-bash",
    });
    assert.deepEqual(state.privateCalls.at(-1), {
      command: "printf '%s\\n' 'AIB_PRIVATE_RUNTIME_STATUS_V1'",
      options: { timeoutMs: 5000, preserveOutput: true, traceId: "private-status-test" },
    }, "private status uses one fixed command, a short timeout, no project cwd, and no caller shell input");

    const failures = [
      [{ stdout: "AIB_PRIVATE_RUNTIME_STATUS_V1\n", stderr: "", exitCode: 0, timedOut: true, outputTruncated: false }, "PRIVATE_AIB_TOOL_PROBE_TIMEOUT"],
      [{ stdout: "AIB_PRIVATE_RUNTIME_STATUS_V1\n", stderr: "", exitCode: 0, timedOut: false, outputTruncated: true }, "PRIVATE_AIB_TOOL_PROBE_OUTPUT_INCOMPLETE"],
      [{ stdout: "AIB_PRIVATE_RUNTIME_STATUS_V1\n", stderr: "", exitCode: 9, timedOut: false, outputTruncated: false }, "PRIVATE_AIB_TOOL_PROBE_NONZERO_EXIT"],
      [{ stdout: "not-the-marker\n", stderr: "", exitCode: 0, timedOut: false, outputTruncated: false }, "PRIVATE_AIB_TOOL_PROBE_MARKER_MISMATCH"],
    ];
    for (const [response, reason] of failures) {
      state.response = response;
      const value = await status.execute({}, undefined, { executionTarget: "embedded-private" });
      assert.deepEqual(value.agentShellProbe, { target: "embedded-private", ready: false, reason });
    }
    state.error = new Error("EMBEDDED_EXEC_UNAVAILABLE");
    const unavailable = await status.execute({}, undefined, { executionTarget: "embedded-private" });
    assert.deepEqual(unavailable.agentShellProbe, {
      target: "embedded-private",
      ready: false,
      reason: "EMBEDDED_EXEC_UNAVAILABLE",
    }, "provider failures are surfaced as typed private failures and never trigger legacy retry");
    assert.equal(state.privateCalls.length, 6, "every private status call makes exactly one bounded provider invocation");
  } finally {
    delete global.__statusState;
    fs.rmSync(out, { recursive: true, force: true });
  }

  const dispatcher = fs.readFileSync(path.join(root, "lib/agent-tools/index.ts"), "utf8");
  const dispatcherPolicyAt = dispatcher.indexOf("privateAgentToolUnsupportedReason(name, executionTarget)");
  const dispatcherValidationAt = dispatcher.indexOf("const validationError = definition.validate(args ?? {});");
  assert.ok(dispatcherPolicyAt >= 0 && dispatcherValidationAt > dispatcherPolicyAt,
    "canonical executeAgentTool dispatch enforces target policy before tool validation/execution");
  assert.match(dispatcher, /const executionTarget = context\?\.executionTarget \?\? "embedded-private"/,
    "missing target defaults to embedded-private execution");
  assert.match(dispatcher, /if \(privatePolicyDenial\) throw new Error\(privatePolicyDenial\)/,
    "direct dispatcher callers cannot bypass typed private capability denials");

  const agent = fs.readFileSync(path.join(root, "lib/termux-agent.ts"), "utf8");
  const gateAt = agent.indexOf("privateAgentToolUnsupportedReason(tool, commandExecutionTarget)");
  const executeAt = agent.indexOf("executeAgentTool(tool, spec.args || {}, options.projectPath, toolExecutionContext)");
  assert.ok(gateAt >= 0 && executeAt > gateAt, "production AIB_TOOL dispatch checks private capability before tool execution");
  assert.match(agent, /if \(privateToolDenial\) throw new Error\(privateToolDenial\)/,
    "unsupported private AIB_TOOL actions become explicit typed errors rather than fallback routes");
  assert.match(agent, /const toolExecutionContext = createAgentToolExecutionContext\(\{\s*traceId: agentTrace\.id,\s*executionTarget: commandExecutionTarget === "embedded-private" \? "embedded-private" : "selected-backend",\s*confirmDangerous: options\.confirmDangerous,\s*\}\)/,
    "production dispatch supplies host-owned checkpoint and per-call GitHub confirmation callbacks");
  const statusSource = fs.readFileSync(path.join(root, "lib/agent-tools/runtime/status.ts"), "utf8");
  assert.match(statusSource, /privateRuntimeProvider\.execute\(PRIVATE_STATUS_COMMAND/);
  assert.doesNotMatch(statusSource, /executeGuardedTermuxCommand|runShellCommand|RUN_COMMAND|runCommand\s*\(/,
    "private runtime.status has no legacy shell or host/proot fallback call site");

  console.log("AIB_PRIVATE_AGENT_TOOLS_SELFTEST_OK canonical-dispatch-policy=1 private-runtime-status=bounded-marker default-embedded-private=1 typed-unsupported-capabilities=1 private-no-fallback=1 shared-path-not-forwarded=1");
} finally {
  fs.rmSync(policyPath, { force: true });
}
