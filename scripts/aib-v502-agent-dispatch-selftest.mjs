#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { typescript } from "./test-helpers/load-typescript.mjs";
import { extractMarkedAibToolPayload } from "../lib/termux-agent-protocol.ts";
import { createPrivatePackageInventoryTool } from "../lib/private-package-inventory.ts";

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aib-v502-dispatch-"));
const out = path.join(temp, "compiled");
const put = (rel, source) => {
  const file = path.join(out, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
};
const compile = (rel) => typescript.transpile(fs.readFileSync(path.join(root, rel), "utf8"), {
  module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022,
});
try {
  const promptSource = fs.readFileSync(path.join(root, "lib/ide-core-prompt.ts"), "utf8");
  const agentSource = fs.readFileSync(path.join(root, "lib/termux-agent.ts"), "utf8");
  const engineSource = fs.readFileSync(path.join(root, "lib/agent-engine.ts"), "utf8");
  for (const tier of ["free", "paid", "offline"]) {
    assert.match(promptSource, new RegExp(`const ${tier.toUpperCase()} =`));
    assert.match(promptSource, /exactly one AIB_TOOL JSON call, allowed TERMUX_RUN shell marker, or TERMUX_DONE/);
  }
  assert.match(promptSource, /DEFAULT = NORMAL CHAT[\s\S]*?ordinary chat/);
  assert.match(agentSource, /If GitHub is connected in app settings[\s\S]*?fresh exact per-call user confirmation/);
  assert.match(engineSource, /active target and integration settings are authoritative[\s\S]*?github\.materialize[\s\S]*?unavailable in embedded-private mode/i);
  assert.match(engineSource, /Every remote create\/write\/merge\/comment requires a fresh exact per-call user confirmation/i);
  assert.doesNotMatch(engineSource, /UNIVERSAL RULE: any user request[\s\S]*?MUST be executed end-to-end/,
    "generic prompt must not override per-target tool policy or force unsupported actions");
  assert.match(promptSource, /AIB_TOOL: \{"tool":"runtime\.packages","args":\{"limit":50\}\}/);
  assert.match(agentSource, /createAgentToolExecutionContext\(\{/);
  const exactReply = 'AIB_TOOL: {"tool":"runtime.packages","args":{"limit":50}}';
  const payload = extractMarkedAibToolPayload(exactReply);
  assert.equal(payload, '{"tool":"runtime.packages","args":{"limit":50}}');
  const parsed = JSON.parse(payload);
  assert.deepEqual(parsed, { tool: "runtime.packages", args: { limit: 50 } });

  // Compile the real dispatcher, context factory, checkpoint wrapper, registry and package adapter.
  put("lib/agent-tools/index.js", compile("lib/agent-tools/index.ts"));
  put("lib/agent-tools/types.js", compile("lib/agent-tools/types.ts"));
  put("lib/agent-tools/mutation-checkpoint.js", compile("lib/agent-tools/mutation-checkpoint.ts"));
  put("lib/agent-tools/github-mutations.js", compile("lib/agent-tools/github-mutations.ts"));
  put("lib/agent-tool-dispatch-context.js", compile("lib/agent-tool-dispatch-context.ts"));
  put("lib/agent-tools/runtime/packages.js", compile("lib/agent-tools/runtime/packages.ts"));
  put("lib/private-package-inventory.js", compile("lib/private-package-inventory.ts"));
  put("lib/private-workspace-policy.js", `exports.AI_BUILDER_WORKSPACE_ROOT='/storage/emulated/0/AIBuilderTermux'; exports.isSafeAIBuilderWorkspaceRelativePath=(p)=>typeof p==='string'&&p.length>0&&!p.startsWith('/')&&!p.split('/').some(x=>!x||x==='.'||x==='..'); exports.isCanonicalAIBuilderWorkspacePath=(p)=>p==='/storage/emulated/0/AIBuilderTermux'||p.startsWith('/storage/emulated/0/AIBuilderTermux/');`);
  put("lib/agent-private-tool-policy.js", compile("lib/agent-private-tool-policy.ts"));
  put("lib/persistent-logger.js", `exports.persistentLogger={add(){}};`);
  put("lib/agent-tools/common.js", `exports.isArgsObject=(x)=>!!x&&typeof x==='object'&&!Array.isArray(x);`);
  put("lib/agent-tools/posix-path.js", `exports.isAbsolutePosixPath=(x)=>typeof x==='string'&&x.startsWith('/'); exports.normalizeAbsolutePosixPath=(x)=>x; exports.resolvePosixPath=(root,p)=>root+'/'+p;`);
  put("lib/termux-bridge.js", `exports.queryEmbeddedTermuxPackages=async(name,limit)=>{ global.__providerCalls.push({name,limit}); return {stdout:'bash\\t5.2.37\\tinstalled\\n',stderr:'',exitCode:0,timedOut:false,outputTruncated:false}; };`);

  const indexSrc = fs.readFileSync(path.join(root, "lib/agent-tools/index.ts"), "utf8");
  const imports = [...indexSrc.matchAll(/^import \* as (\w+) from "(\.\/[^\"]+)";/gm)];
  const toolCalls = [];
  global.__toolCalls = toolCalls;
  for (const [, symbol, spec] of imports) {
    if (spec === "./runtime/packages") continue;
    put(`lib/agent-tools/${spec.slice(2)}.js`, `exports.validate=()=>null; exports.execute=async(args,project,context)=>{ global.__toolCalls.push({tool:${JSON.stringify(symbol)},args,project,context}); return {ok:true,tool:${JSON.stringify(symbol)}}; };`);
  }
  // Replace the package bridge provider with a deterministic, offline mock response.
  global.__providerCalls = [];
  const req = createRequire(import.meta.url);
  const dispatcher = req(path.join(out, "lib/agent-tools/index.js"));
  const hostModule = req(path.join(out, "lib/agent-tool-dispatch-context.js"));
  const specCheck = dispatcher.validateAgentToolCall(parsed);
  assert.deepEqual(specCheck, { ok: true }, "canonical example resolves to a registered, valid tool");
  const roundTrip = await dispatcher.executeAgentTool(parsed.tool, parsed.args, null, {
    executionTarget: "embedded-private", traceId: "mock-round-trip",
  });
  assert.equal(roundTrip.ok, true);
  assert.deepEqual(global.__providerCalls, [{ name: null, limit: 50 }], "registry dispatch reaches only the mocked embedded-private package provider");
  assert.equal(roundTrip.source, "embedded-private");
  assert.equal(roundTrip.packages[0].name, "bash");

  const mutationArgs = { owner: "acme", repo: "demo", number: 19 };
  await assert.rejects(() => dispatcher.executeAgentTool("github.prMerge", mutationArgs, null, {
    executionTarget: "embedded-private",
  }), /GITHUB_MUTATION_CONFIRMATION_REQUIRED/);
  assert.equal(toolCalls.length, 0, "missing authorization blocks before the fake GitHub endpoint");
  await assert.rejects(() => dispatcher.executeAgentTool("github.prMerge", mutationArgs, null, {
    executionTarget: "embedded-private", authorizeExternalMutation: async () => { throw new Error("GITHUB_MUTATION_NOT_AUTHORIZED"); },
  }), /GITHUB_MUTATION_NOT_AUTHORIZED/);
  assert.equal(toolCalls.length, 0, "denied confirmation sends no fake GitHub request");
  let approval;
  await dispatcher.executeAgentTool("github.prMerge", mutationArgs, null, {
    executionTarget: "embedded-private", authorizeExternalMutation: async (r) => { approval = r; },
  });
  assert.equal(approval.target, "acme/demo PR #19");
  assert.deepEqual(approval.args, mutationArgs);
  assert.equal(toolCalls.length, 1, "approved mutation reaches one fake endpoint call");
  const beforeRead = toolCalls.length;
  await dispatcher.executeAgentTool("github.read", { owner: "acme", repo: "demo", path: "README.md" }, null, { executionTarget: "embedded-private" });
  assert.equal(toolCalls.length, beforeRead + 1, "read-only GitHub tools remain callable without the mutation gate");
  await assert.rejects(() => dispatcher.executeAgentTool("github.pack", { path: "/storage/emulated/0/AIBuilderTermux/repo" }, null, { executionTarget: "embedded-private" }), /AIB_TOOL_PRIVATE_PROJECT_PATH_UNSUPPORTED/);
  assert.equal(toolCalls.length, beforeRead + 1, "private GitHub path materialization is denied before the tool executes");

  let written = 0;
  global.__toolCalls = [];
  const sourcePath = "/storage/emulated/0/AIBuilderTermux/src/main.txt";
  const checkpoints = [];
  const fakeHost = {
    readWorkspaceFile: async (relativePath) => { assert.equal(relativePath, "src/main.txt"); return { content: "EXACT OLD VERSION" }; },
    getFacade: () => ({
      home: { projects: "/data/user/0/app/files/home/projects" },
      environment: { mkdir: async (p) => checkpoints.push(`mkdir:${p}`), write: async (p, content) => checkpoints.push(`saved:${p}:${content}`) },
      workspaceSnapshots: { createSnapshot: async (rootPath, label) => { checkpoints.push(`snapshot:${rootPath}:${label}`); return { id: "snap-mock" }; } },
    }),
    now: () => 123456,
    nonce: () => "one-shot",
  };
  const constructed = hostModule.createAgentToolExecutionContext({ traceId: "dispatch-context", executionTarget: "embedded-private", host: fakeHost });
  await dispatcher.executeAgentTool("workspace.write", { relativePath: "src/main.txt", content: "NEW" }, null, {
    ...constructed,
    // The fake registered workspace tool counts the point mutation happens.
  });
  // Dispatcher has invoked the fake native write handler only after the context callback.
  written = global.__toolCalls.filter((x) => x.tool === "workspaceWrite").length;
  assert.equal(written, 1);
  assert.ok(checkpoints.some((x) => x.includes(`saved:/data/user/0/app/files/home/projects/aib-agent-prewrite-123456-one-shot/original/src/main.txt:EXACT OLD VERSION`)));
  assert.ok(checkpoints.some((x) => x.includes("snapshot:/data/user/0/app/files/home/projects/aib-agent-prewrite-123456-one-shot:agent-prewrite-workspace.write")));
  const failingContext = hostModule.createAgentToolExecutionContext({
    traceId: "failure", executionTarget: "embedded-private",
    host: { ...fakeHost, getFacade: () => ({ ...fakeHost.getFacade(), workspaceSnapshots: { createSnapshot: async () => { throw new Error("SNAPSHOT_FAILED"); } } }) },
  });
  const beforeFailure = global.__toolCalls.length;
  await assert.rejects(() => dispatcher.executeAgentTool("workspace.write", { relativePath: "src/main.txt", content: "NO" }, null, failingContext), /SNAPSHOT_FAILED/);
  assert.equal(global.__toolCalls.length, beforeFailure, "snapshot failure blocks the native write");
  await assert.rejects(() => constructed.beforeFileMutation("/storage/emulated/0/AIBuilderTermuxElsewhere/src/main.txt", "workspace.write"), /FILE_WRITE_CHECKPOINT_TARGET_INVALID/);

  // Per-call GitHub UI adapter shows exact tool, target and serialized args; no approval is stored.
  let prompt;
  const confirmed = hostModule.createAgentToolExecutionContext({ executionTarget: "embedded-private", confirmDangerous: async (command, reason) => { prompt = { command, reason }; return true; }, host: fakeHost });
  await confirmed.authorizeExternalMutation({ tool: "github.prMerge", target: "acme/demo PR #19", args: mutationArgs });
  assert.match(prompt.command, /github\.prMerge/);
  assert.match(prompt.reason, /acme\/demo PR #19/);
  assert.match(prompt.reason, /"number":19/);

  const mutation = fs.readFileSync(path.join(root, "lib/agent-tools/github-mutations.ts"), "utf8");
  for (const tool of ["github.repoCreate", "github.branch", "github.apply", "github.prCreate", "github.prMerge", "github.issueCreate", "github.issueComment", "github.rename", "github.write", "github.copy"]) assert.match(mutation, new RegExp(`"${tool.replaceAll(".", "\\.")}"`));
  assert.doesNotMatch(mutation, /"github\.(read|repo|tree|list|diff|release|commit)"/);
  console.log("AIB_V502_AGENT_DISPATCH_SELFTEST_OK prompt=consistent exact_tool_roundtrip=mock_private checkpoint=durable fail_closed=1 github=per_call_authorized read_only=available");
} finally {
  delete global.__toolCalls;
  delete global.__providerCalls;
  fs.rmSync(temp, { recursive: true, force: true });
}
