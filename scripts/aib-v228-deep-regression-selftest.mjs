#!/usr/bin/env node
/** Behavior-level v228 regressions. Native boundaries are replaced with deferred fakes. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Module from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const require = createRequire(import.meta.url);
const ts = require("typescript");
const moduleCache = new Map();

function resolveTs(parent, request) {
  const base = path.resolve(path.dirname(parent), request);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, path.join(base, "index.ts")]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}
function loadTs(file) {
  file = path.resolve(file);
  if (moduleCache.has(file)) return moduleCache.get(file).exports;
  const mod = new Module(file);
  mod.filename = file;
  mod.paths = Module._nodeModulePaths(path.dirname(file));
  moduleCache.set(file, mod);
  mod.require = (request) => {
    if (request === "expo-file-system") return {
      Paths: { document: "/mock/documents" },
      Directory: class { constructor(..._args) {} get exists() { return true; } create() {} },
      File: class {
        constructor(...args) { this.name = String(args.at(-1) || "model.gguf"); this.uri = `/mock/models/${this.name}`; }
        exists = false;
        size = 0;
        open() { throw new Error("native file access intentionally mocked"); }
      },
    };
    if (request === "expo-file-system/legacy") return { EncodingType: { Base64: "base64", UTF8: "utf8" } };
    if (request === "llama.rn") return { initLlama: async () => { throw new Error("unexpected native init"); } };
    if (request === "@react-native-async-storage/async-storage") return {
      default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
      getItem: async () => null, setItem: async () => {}, removeItem: async () => {},
    };
    if (request === "expo-secure-store") return { getItemAsync: async () => null, setItemAsync: async () => {} };
    if (request === "./termux-bridge" && file.endsWith("/lib/local-model.ts")) return { getTermuxNative: () => null };
    if (request === "../core/enhancements/auth/productionProviderTransport" && file.endsWith("/lib/online-model.ts")) {
      return {
        securedProviderFetch: async (_providerId, _route, endpoint, init) => globalThis.fetch(`https://openrouter.test${endpoint}`, init),
        probeProviderModelsCredential: async () => ({ ok: true }),
      };
    }
    const resolved = request.startsWith(".") ? resolveTs(file, request) : null;
    return resolved ? loadTs(resolved) : createRequire(file)(request);
  };
  const js = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: file,
  }).outputText;
  mod._compile(js, file);
  return mod.exports;
}
function bash(command, env = {}) {
  const r = spawnSync("bash", ["-c", command], { encoding: "utf8", env: { ...process.env, ...env }, timeout: 15_000 });
  return { status: r.status ?? 1, stdout: r.stdout || "", stderr: r.stderr || r.error?.message || "" };
}
const cases = [];
async function scenario(name, fn) {
  try { await fn(); cases.push({ name, ok: true }); console.log(`PASS ${name}`); }
  catch (error) { cases.push({ name, ok: false }); console.error(`FAIL ${name}: ${error instanceof Error ? error.stack || error.message : String(error)}`); }
}
function success(stdout = "") { return { exitCode: 0, stdout, stderr: "" }; }
function fakeEnvironment(home) {
  return {
    getHome: () => home,
    async resolvePath(value) {
      try { return fs.realpathSync(value); }
      catch { return path.resolve(value); }
    },
    async exists(value) { return fs.existsSync(value); },
    async read(value) { return fs.readFileSync(value, "utf8"); },
    async mkdir(value) { fs.mkdirSync(value, { recursive: true }); },
    async write(value, content) { fs.mkdirSync(path.dirname(value), { recursive: true }); fs.writeFileSync(value, content); },
    async exec() { return success(); },
  };
}

await scenario("snippet save transports heredoc-shaped Unicode as data and quotes hostile destination", async () => {
  moduleCache.clear();
  const { buildSaveSnippetCommand } = loadTs(path.join(root, "lib/shell-snippet-save.ts"));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aib-v228-snippet-"));
  try {
    const marker = path.join(temp, "EXECUTED");
    const destination = path.join(temp, `space ' $(touch ${marker}).txt`);
    const content = `before\nAIB_EOF\ntouch ${marker}\n雪 — Привет\nafter`;
    const result = bash(buildSaveSnippetCommand(destination, content));
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(fs.readFileSync(destination, "utf8"), content);
    assert.equal(fs.existsSync(marker), false);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

await scenario("Proot command builder shell-quotes host paths, env values, rootfs and executable", async () => {
  moduleCache.clear();
  const { buildProotLaunchPlan } = loadTs(path.join(root, "core/container/ProotCommandBuilder.ts"));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aib-v228-proot-"));
  try {
    const marker = path.join(temp, "EXECUTED");
    const capture = path.join(temp, "args.txt");
    const executable = path.join(temp, "fake proot ' bin");
    fs.writeFileSync(executable, "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$CAPTURE\"\n", { mode: 0o755 });
    const spec = {
      profile: "ubuntu", instanceId: "instance-1",
      projectRoot: `${temp}/project $(touch ${marker})`, containerCwd: "/workspace",
      env: { AI_BUILDER_HOME: `${temp}/$(touch ${marker}) 'value` }, shellCommand: "true",
    };
    const plan = buildProotLaunchPlan(spec, { rootfsPath: `${temp}/root ' $(touch ${marker})`, prootBinary: executable });
    const result = bash(plan.command, { CAPTURE: capture });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(fs.existsSync(marker), false);
    const args = fs.readFileSync(capture, "utf8");
    assert.match(args, /project \$\(touch/);
    assert.match(args, /root ' \$\(touch/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

await scenario("public core barrel exports agent runtime and policy types", async () => {
  const barrel = fs.readFileSync(path.join(root, "core/index.ts"), "utf8");
  assert.match(barrel, /export \{ AgentManager, createAgentManager \} from "\.\/agent\/AgentManager"/);
  for (const type of ["AgentHostHooks", "AgentCapability", "AgentPolicy", "AgentSession", "AgentExecRequest", "AgentExecResult"]) {
    assert.match(barrel, new RegExp(`\\b${type}\\b`), `${type} should be available from the public barrel`);
  }
});

await scenario("provider timeout and parent Stop abort the in-flight request signal", async () => {
  moduleCache.clear();
  const { withAbortableTimeout } = loadTs(path.join(root, "lib/abortable-timeout.ts"));
  let timeoutAborted = false;
  await assert.rejects(withAbortableTimeout((signal) => new Promise(() => {
    signal.addEventListener("abort", () => { timeoutAborted = true; }, { once: true });
  }), 15), /MODEL_TIMEOUT/);
  assert.equal(timeoutAborted, true, "deadline must abort the provider's child signal");

  const parent = new AbortController();
  let stopAborted = false;
  let enteredResolve;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  const pending = withAbortableTimeout((signal) => new Promise(() => {
    signal.addEventListener("abort", () => { stopAborted = true; }, { once: true });
    enteredResolve();
  }), 10_000, new AbortController(), parent.signal);
  await entered;
  parent.abort();
  await assert.rejects(pending, /ABORTED/);
  assert.equal(stopAborted, true, "parent Stop must abort the active provider request");
});

await scenario("OpenRouter recovery probe abort stops the current fetch and later model probes", async () => {
  moduleCache.clear();
  const { checkOpenRouterModels } = loadTs(path.join(root, "lib/online-model.ts"));
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let calls = 0, startedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  globalThis.fetch = async (_url, init) => {
    calls++;
    startedResolve();
    return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => {
      const error = new Error("aborted"); error.name = "AbortError"; reject(error);
    }, { once: true }));
  };
  try {
    const transport = async (_provider, _route, requestPath, init) => globalThis.fetch(`https://openrouter.test/${requestPath}`, init);
    const pending = checkOpenRouterModels(
      [{ id: "model-one" }, { id: "model-two" }], undefined,
      { maxRetries: 0, staggerMs: 250, signal: controller.signal }, transport,
    );
    await started;
    controller.abort();
    await assert.rejects(pending, /ABORTED/);
    assert.equal(calls, 1, "no second probe should start after cancellation");
  } finally { globalThis.fetch = originalFetch; }
});

await scenario("chat/agent timeout plumbing uses per-provider AbortSignal and recovery receives task Stop", async () => {
  const hook = fs.readFileSync(path.join(root, "hooks/useLLM.ts"), "utf8");
  const start = hook.indexOf("const askModelForAgent = useCallback");
  const end = hook.indexOf("Общий публичный вход", start);
  const agentBody = hook.slice(start, end);
  assert.ok(agentBody.includes("withAbortableTimeout(operation, ms, new AbortController(), generationSignal)"));
  assert.ok(!agentBody.includes("Promise.race"), "agent request timeout must not abandon an active provider call");
  for (const marker of [
    "(signal) => customProviderEngine.chat(",
    "(signal) => onlineModelEngine.chat(",
    "(signal) => localModelEngine.chat(",
  ]) assert.ok(agentBody.includes(marker), `missing abort-aware provider call: ${marker}`);
  assert.ok(hook.includes("{ maxRetries: 0, staggerMs: 250, signal }"));
  assert.ok(hook.includes("recoverOnlineModel(settings.onlineModel.id, requestAbortController.signal)"));
  assert.ok(hook.includes("recoverOnlineModel(settings.onlineModel.id, imageAbortController.signal)"));
});

await scenario("project isolation confines filesystem and fails closed for host shell/terminal", async () => {
  moduleCache.clear();
  const { AgentManager } = loadTs(path.join(root, "core/agent/AgentManager.ts"));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aib-v228-agent-"));
  try {
    const home = path.join(temp, "home");
    const alpha = path.join(home, "projects", "alpha");
    const beta = path.join(home, "projects", "beta");
    const outside = path.join(temp, "outside");
    for (const dir of [alpha, beta, outside]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(alpha, "note.txt"), "alpha");
    fs.writeFileSync(path.join(beta, "note.txt"), "beta");
    fs.writeFileSync(path.join(outside, "note.txt"), "outside");
    fs.symlinkSync(outside, path.join(alpha, "escape"));
    let hostShellCalls = 0, hostTerminalCalls = 0;
    const manager = new AgentManager(fakeEnvironment(home));
    manager.setHostHooks({
      runShell: async () => { hostShellCalls++; return { exitCode: 0, stdout: "leaked" }; },
      openTerminalForProject: async () => { hostTerminalCalls++; return { id: "host-terminal" }; },
    });
    const agent = manager.create({ projectId: "alpha", policy: { allowedCapabilities: ["filesystem", "terminal"], homeIsolation: true, projectIsolation: true } });
    const inside = await manager.execute(agent.id, { tool: "fs.read", capability: "filesystem", args: { path: path.join(alpha, "note.txt") } });
    assert.equal(inside.ok, true);
    assert.equal(inside.output, "alpha");
    const mismatch = await manager.execute(agent.id, { tool: "fs.read", capability: "terminal", args: { path: path.join(alpha, "note.txt") } });
    assert.equal(mismatch.ok, false);
    assert.match(mismatch.error, /TOOL_CAPABILITY_MISMATCH:fs\.read:filesystem/);
    for (const target of [path.join(beta, "note.txt"), path.join(alpha, "escape", "note.txt")]) {
      const denied = await manager.execute(agent.id, { tool: "fs.read", capability: "filesystem", args: { path: target } });
      assert.equal(denied.ok, false);
      assert.match(denied.error, /PROJECT isolation/);
    }
    const shell = await manager.execute(agent.id, { tool: "shell.exec", capability: "terminal", args: { command: "pwd", cwd: alpha } });
    assert.equal(shell.ok, false);
    assert.equal(shell.error, "ISOLATED_SHELL_UNAVAILABLE");
    const terminal = await manager.execute(agent.id, { tool: "terminal.open", capability: "terminal", args: { projectId: "alpha" } });
    assert.equal(terminal.ok, false);
    assert.equal(terminal.error, "ISOLATED_TERMINAL_UNAVAILABLE");
    const crossTerminal = await manager.execute(agent.id, { tool: "terminal.open", capability: "terminal", args: { projectId: "beta" } });
    assert.equal(crossTerminal.ok, false);
    assert.match(crossTerminal.error, /must match agent project/);
    assert.equal(hostShellCalls, 0);
    assert.equal(hostTerminalCalls, 0);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

await scenario("device Stop aborts pending vision and prevents the next physical action", async () => {
  moduleCache.clear();
  const { AgentManager } = loadTs(path.join(root, "core/agent/AgentManager.ts"));
  const { DeviceAutomationAgent } = loadTs(path.join(root, "core/device/DeviceAutomationAgent.ts"));
  const bridge = {
    async isAvailable() { return true; }, async detectPackageName() { return success("com.example.app"); },
    async install() { return success(); }, async launch() { return success(); },
    async screenshotBase64() { return "YWJj"; }, async screenshot(p) { return p; },
    async logcat() { return success(); }, async uiHierarchy() { return success(""); },
    async tap() { tapCalls++; return success(); }, async swipe() { return success(); }, async shell() { return success(); },
    async inputText() { return success(); }, async screenSize() { return success("100x100"); },
  };
  let tapCalls = 0;
  const automation = new DeviceAutomationAgent(bridge);
  const manager = new AgentManager(fakeEnvironment("/tmp/aib-v228-home"));
  manager.setHostHooks({ runDeviceAutomation: (options) => automation.run(options) });
  const agent = manager.create({ policy: { allowedCapabilities: ["adb"], homeIsolation: false, projectIsolation: false } });
  let enteredResolve;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  const vision = async () => {
    enteredResolve();
    await new Promise((resolve) => setTimeout(resolve, 150));
    return JSON.stringify({ completed: false, action: { type: "tap", x: 1, y: 1 } });
  };
  const pending = manager.execute(agent.id, { tool: "device.automation_loop", capability: "adb", args: { apkPath: "/mock/app.apk", goal: "tap", vision } });
  await entered;
  manager.stop(agent.id);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.error, "ABORTED");
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(tapCalls, 0);
});

await scenario("Stop waits for a dispatched device action and then prevents the next effect", async () => {
  moduleCache.clear();
  const { AgentManager } = loadTs(path.join(root, "core/agent/AgentManager.ts"));
  const { DeviceAutomationAgent } = loadTs(path.join(root, "core/device/DeviceAutomationAgent.ts"));
  let tapCalls = 0, screenshots = 0, resolveTap, tapStartedResolve;
  const tapStarted = new Promise((resolve) => { tapStartedResolve = resolve; });
  const bridge = {
    async isAvailable() { return true; }, async detectPackageName() { return success("package: name='com.example.app'"); },
    async install() { return success(); }, async launch() { return success(); },
    async screenshotBase64() { screenshots++; return "YWJj"; }, async screenshot(p) { return p; },
    async logcat() { return success(); }, async uiHierarchy() { return success(""); },
    tap() { tapCalls++; tapStartedResolve(); return new Promise((resolve) => { resolveTap = resolve; }); },
    async swipe() { return success(); }, async shell() { return success(); }, async inputText() { return success(); }, async screenSize() { return success("100x100"); },
  };
  const automation = new DeviceAutomationAgent(bridge);
  const manager = new AgentManager(fakeEnvironment("/tmp/aib-v228-home"));
  manager.setHostHooks({ runDeviceAutomation: (options) => automation.run(options) });
  const agent = manager.create({ policy: { allowedCapabilities: ["adb"], homeIsolation: false, projectIsolation: false } });
  const pending = manager.execute(agent.id, { tool: "device.automation_loop", capability: "adb", args: {
    apkPath: "/mock/app.apk", goal: "tap", vision: async () => JSON.stringify({ completed: false, action: { type: "tap", x: 2, y: 3 } }),
  } });
  await tapStarted;
  manager.stop(agent.id);
  assert.equal(agent.status, "running", "status remains active until the non-cancellable native action settles");
  const denied = await manager.execute(agent.id, { tool: "device.automation_loop", capability: "adb", args: {} });
  assert.equal(denied.error, "AGENT_STOPPING");
  resolveTap(success());
  const result = await pending;
  assert.equal(result.error, "ABORTED");
  assert.equal(agent.status, "stopped");
  assert.equal(tapCalls, 1);
  assert.equal(screenshots, 1, "no capture/next action follows the dispatched tap after Stop");
});

await scenario("Stop during device availability preflight prevents a not-yet-dispatched action", async () => {
  moduleCache.clear();
  const { AgentManager } = loadTs(path.join(root, "core/agent/AgentManager.ts"));
  const { DeviceAutomationAgent } = loadTs(path.join(root, "core/device/DeviceAutomationAgent.ts"));
  let availabilityCalls = 0, resolveAvailability, availableStartedResolve, tapCalls = 0;
  let screenshots = 0;
  const availableStarted = new Promise((resolve) => { availableStartedResolve = resolve; });
  const bridge = {
    isAvailable() {
      availabilityCalls++;
      if (availabilityCalls === 1) return true;
      availableStartedResolve();
      return new Promise((resolve) => { resolveAvailability = resolve; });
    },
    async detectPackageName() { return success("com.example.app"); },
    async install() { return success(); }, async launch() { return success(); },
    async screenshotBase64() { screenshots++; return "YWJj"; }, async screenshot(p) { return p; },
    async logcat() { return success(); }, async uiHierarchy() { return success(""); },
    async tap() { tapCalls++; return success(); }, async swipe() { return success(); }, async shell() { return success(); },
    async inputText() { return success(); }, async screenSize() { return success("100x100"); },
  };
  const automation = new DeviceAutomationAgent(bridge);
  const manager = new AgentManager(fakeEnvironment("/tmp/aib-v228-home"));
  manager.setHostHooks({ runDeviceAutomation: (options) => automation.run(options) });
  const agent = manager.create({ policy: { allowedCapabilities: ["adb"], homeIsolation: false, projectIsolation: false } });
  const pending = manager.execute(agent.id, { tool: "device.automation_loop", capability: "adb", args: {
    apkPath: "/mock/app.apk", packageName: "com.example.app", goal: "tap",
    vision: async () => JSON.stringify({ completed: false, action: { type: "tap", x: 4, y: 5 } }),
  } });
  await availableStarted;
  manager.stop(agent.id);
  const result = await pending;
  assert.equal(result.error, "ABORTED");
  resolveAvailability(true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(tapCalls, 0, "a late successful availability response must not dispatch after Stop");
  assert.equal(screenshots, 1, "no follow-up capture after Stop");
  assert.equal(agent.status, "stopped");
});

await scenario("backup restore rejects actual tar symlink members before clearing active data", async () => {
  moduleCache.clear();
  const { TermuxBackupAdapter } = loadTs(path.join(root, "core/backup/TermuxBackupAdapter.ts"));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aib-v228-backup-link-"));
  try {
    const payload = path.join(temp, "payload");
    const outside = path.join(temp, "outside");
    const homeRoot = path.join(temp, "home");
    const backup = path.join(temp, "backup");
    for (const dir of [payload, outside, path.join(homeRoot, "projects"), backup]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(outside, "outside.txt"), "outside-data");
    fs.writeFileSync(path.join(homeRoot, "projects", "preserve.txt"), "active-data");
    fs.symlinkSync(outside, path.join(payload, "projects"));
    const archive = path.join(backup, "ai-builder-data.tar.gz");
    const created = spawnSync("tar", ["-czf", archive, "-C", payload, "projects"], { encoding: "utf8" });
    assert.equal(created.status, 0, created.stderr);
    const commands = [];
    const env = {
      async exec(command) {
        commands.push(command);
        const result = spawnSync("bash", ["-c", command], { encoding: "utf8", timeout: 10_000 });
        return { exitCode: result.status ?? 1, stdout: result.stdout || "", stderr: result.stderr || "" };
      },
    };
    const adapter = new TermuxBackupAdapter(env, { root: homeRoot });
    await assert.rejects(adapter.restore(backup, [path.join(homeRoot, "projects")]), /BACKUP_ARCHIVE_UNSAFE_TYPE/);
    assert.equal(fs.readFileSync(path.join(homeRoot, "projects", "preserve.txt"), "utf8"), "active-data");
    assert.equal(commands.some((command) => command.startsWith("rm -rf --")), false, "validation happens before destructive clear");
    assert.equal(commands.some((command) => command.startsWith("tar -xzf") && command.includes(" -C ")), false, "unsafe archive is never extracted to a filesystem destination");
    assert.equal(fs.readFileSync(path.join(outside, "outside.txt"), "utf8"), "outside-data");
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

await scenario("completed vision decision cannot bypass required UI assertions", async () => {
  moduleCache.clear();
  const { DeviceAutomationAgent } = loadTs(path.join(root, "core/device/DeviceAutomationAgent.ts"));
  const bridge = {
    async isAvailable() { return true; }, async install() { return success(); }, async launch() { return success(); },
    async screenshotBase64() { return "YWJj"; }, async logcat() { return success(); }, async uiHierarchy() { return success(""); },
  };
  const agent = new DeviceAutomationAgent(bridge);
  const result = await agent.run({
    apkPath: "/mock/app.apk", packageName: "com.example.app", goal: "check missing text",
    testPlan: { version: 1, goal: "check missing text", steps: [{ id: "assert", description: "must fail", assertions: [{ type: "text_present", value: "NEVER_PRESENT" }] }] },
    vision: async () => JSON.stringify({ completed: true, reason: "looks done" }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.completed, false);
  assert.match(result.reason, /^ASSERTION_FAILED:/);
});

await scenario("device suite timeout returns blocked and skips later cases; empty case is not passed", async () => {
  moduleCache.clear();
  const { runDeviceTestSuite } = loadTs(path.join(root, "core/device/DeviceTestRunner.ts"));
  const evidence = {
    root: "/evidence/run", async init() {},
    async write(testId, name, _value, kind = "artifact") { return { kind, path: `/evidence/${testId}/${name}`, sha256: "hash", bytes: 1 }; },
    async writeJson(testId, name, value) { return this.write(testId, name, JSON.stringify(value), "json"); },
    relative(ref) { return ref.path.replace("/evidence/", ""); },
  };
  const bridge = {
    async detectPackageName() { return success("package: name='com.example.app'"); },
    async install() { return success(); }, async screenshotBase64() { return "YQ=="; }, async uiHierarchy() { return success(""); },
    launch() { return new Promise(() => {}); }, async logcat() { return success(); },
  };
  const step = { id: "launch", description: "launch", action: { type: "launch" }, assertions: [] };
  const timeoutRun = await runDeviceTestSuite(bridge, {
    apkPath: "/mock/app.apk", suite: { goal: "timeout", cases: [
      { id: "first", title: "First", goal: "launch", steps: [step] },
      { id: "second", title: "Second", goal: "launch", steps: [step] },
    ] }, evidence, caseTimeoutMs: 25,
  });
  assert.equal(timeoutRun.report.cases[0].status, "blocked");
  assert.equal(timeoutRun.report.cases[0].reason, "CASE_TIMEOUT");
  assert.equal(timeoutRun.report.cases[1].reason, "SKIPPED_AFTER_CASE_TIMEOUT");
  const emptyRun = await runDeviceTestSuite(bridge, {
    apkPath: "/mock/app.apk", packageName: "com.example.app",
    suite: { goal: "empty", cases: [{ id: "empty", title: "Empty", goal: "", steps: [] }] }, evidence,
  });
  assert.equal(emptyRun.report.cases[0].status, "blocked");
  assert.equal(emptyRun.report.cases[0].reason, "EMPTY_TEST_CASE");
});

await scenario("local-model unload waits for generation and releases base context after multimodal release failure", async () => {
  moduleCache.clear();
  const { localModelEngine: engine } = loadTs(path.join(root, "lib/local-model.ts"));
  let enteredResolve, completionResolve, releaseCount = 0;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  engine.context = {
    completion: async () => { enteredResolve(); return new Promise((resolve) => { completionResolve = resolve; }); },
    stopCompletion: async () => {}, releaseMultimodal: async () => {}, release: async () => { releaseCount++; },
  };
  engine.multimodalReady = false;
  engine.appliedParams = { nCtx: 1024, nThreads: 1, nGpuLayers: 0 };
  const chat = engine.chat([{ role: "user", content: "hello" }]);
  await entered;
  const unload = engine.unload();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(releaseCount, 0, "native context must remain live until completion settles");
  completionResolve({ text: "done" });
  assert.equal(await chat, "done");
  await unload;
  assert.equal(releaseCount, 1);

  let baseReleaseAfterMmFailure = 0;
  engine.context = {
    completion: async () => ({ text: "" }), stopCompletion: async () => {},
    releaseMultimodal: async () => { throw new Error("MMPROJ_RELEASE_FAILED"); },
    release: async () => { baseReleaseAfterMmFailure++; },
  };
  engine.multimodalReady = true;
  engine.appliedParams = { nCtx: 1024, nThreads: 1, nGpuLayers: 0 };
  await assert.rejects(engine.unload(), /MODEL_UNLOAD_FAILED:MMPROJ_RELEASE_FAILED/);
  assert.equal(baseReleaseAfterMmFailure, 1);
  assert.equal(engine.isLoaded(), false);
});

await scenario("Android SDK health rejects generic HOME manifests and executable-directory placeholders", async () => {
  moduleCache.clear();
  const { discoverAndroidSdk } = loadTs(path.join(root, "core/toolchain/AndroidSdkDiscovery.ts"));
  const { discoverRuntimeToolchains } = loadTs(path.join(root, "core/toolchain/ToolDiscovery.ts"));
  const dirs = new Set([
    "/sdk-empty", "/sdk-good", "/sdk-partial", "/sdk-placeholder", "/sdk-dir-placeholders",
    "/sdk-dir-placeholders/platform-tools/adb", "/sdk-dir-placeholders/platforms/android-35",
    "/sdk-dir-placeholders/platforms/android-35/android.jar", "/sdk-dir-placeholders/build-tools/35.0.0",
    "/sdk-dir-placeholders/build-tools/35.0.0/aapt2", "/sdk-dir-placeholders/build-tools/35.0.0/zipalign",
    "/sdk-dir-placeholders/build-tools/35.0.0/d8", "/sdk-dir-placeholders/source.properties",
    "/home/toolchains/android-sdk", "/home/toolchains/android-sdk/platform-tools/adb",
    "/sdk-empty-components", "/sdk-empty-components/platforms/android-36",
    "/sdk-empty-components/build-tools/36.0.0",
  ]);
  const paths = new Set([
    "/sdk-file", "/sdk-empty", "/sdk-good", "/sdk-good/platform-tools/adb",
    "/sdk-good/platforms/android-35/android.jar", "/sdk-good/source.properties",
    "/sdk-partial", "/sdk-partial/platform-tools/adb", "/sdk-placeholder",
    "/sdk-placeholder/platform-tools/adb", "/sdk-placeholder/source.properties",
    "/sdk-empty-components", "/sdk-empty-components/platform-tools/adb",
    "/sdk-empty-components/platforms/android-36/android.jar", "/sdk-empty-components/source.properties",
    "/sdk-empty-components/build-tools/36.0.0/aapt2", "/sdk-empty-components/build-tools/36.0.0/zipalign",
    "/sdk-empty-components/build-tools/36.0.0/d8",
    "/sdk-dir-placeholders", "/sdk-dir-placeholders/platform-tools/adb",
    "/sdk-dir-placeholders/platforms/android-35/android.jar", "/sdk-dir-placeholders/source.properties",
    "/sdk-dir-placeholders/build-tools/35.0.0/aapt2", "/sdk-dir-placeholders/build-tools/35.0.0/zipalign",
    "/sdk-dir-placeholders/build-tools/35.0.0/d8", "/home/toolchains/android-sdk",
    "/home/toolchains/android-sdk/platform-tools/adb",
  ]);
  const regularFiles = new Set([
    "/sdk-good/platform-tools/adb", "/sdk-good/platforms/android-35/android.jar",
    "/sdk-good/source.properties", "/sdk-good/build-tools/35.0.0/aapt2",
    "/sdk-good/build-tools/35.0.0/zipalign", "/sdk-good/build-tools/35.0.0/d8",
    "/sdk-placeholder/source.properties",
    "/sdk-empty-components/platform-tools/adb", "/sdk-empty-components/platforms/android-36/android.jar",
    "/sdk-empty-components/source.properties", "/sdk-empty-components/build-tools/36.0.0/aapt2",
    "/sdk-empty-components/build-tools/36.0.0/zipalign", "/sdk-empty-components/build-tools/36.0.0/d8",
  ]);
  const nonEmptyFiles = new Set([
    "/sdk-good/platform-tools/adb", "/sdk-good/platforms/android-35/android.jar", "/sdk-good/source.properties",
    "/sdk-good/build-tools/35.0.0/aapt2", "/sdk-good/build-tools/35.0.0/zipalign", "/sdk-good/build-tools/35.0.0/d8",
    "/sdk-placeholder/source.properties",
  ]);
  const executablePaths = new Set([
    "/sdk-good/platform-tools/adb", "/sdk-good/build-tools/35.0.0/aapt2",
    "/sdk-good/build-tools/35.0.0/zipalign", "/sdk-good/build-tools/35.0.0/d8",
    // POSIX test -x also returns true for searchable directories.
    "/sdk-dir-placeholders/platform-tools/adb", "/sdk-dir-placeholders/build-tools/35.0.0/aapt2",
    "/sdk-dir-placeholders/build-tools/35.0.0/zipalign", "/sdk-dir-placeholders/build-tools/35.0.0/d8",
    "/home/toolchains/android-sdk/platform-tools/adb",
    "/sdk-empty-components/platform-tools/adb", "/sdk-empty-components/build-tools/36.0.0/aapt2",
    "/sdk-empty-components/build-tools/36.0.0/zipalign", "/sdk-empty-components/build-tools/36.0.0/d8",
  ]);
  const children = {
    "/sdk-good/platforms": ["android-35"],
    "/sdk-good/build-tools": ["35.0.0"],
    "/sdk-partial/platforms": [], "/sdk-partial/build-tools": [],
    "/sdk-placeholder/platforms": [], "/sdk-placeholder/build-tools": [],
    "/sdk-dir-placeholders/platforms": ["android-35"],
    "/sdk-dir-placeholders/build-tools": ["35.0.0"],
    "/home/toolchains/android-sdk/platforms": [],
    "/home/toolchains/android-sdk/build-tools": [],
    "/sdk-empty-components/platforms": ["android-36"],
    "/sdk-empty-components/build-tools": ["36.0.0"],
  };
  const probe = {
    exists: async (p) => paths.has(p),
    isDirectory: async (p) => dirs.has(p),
    isFile: async (p) => regularFiles.has(p),
    isNonEmptyFile: async (p) => nonEmptyFiles.has(p),
    isExecutable: async (p) => executablePaths.has(p),
    listDirectories: async (p) => children[p] || [],
    readText: async (p) => {
      if (["/sdk-good/source.properties", "/sdk-partial/source.properties", "/sdk-placeholder/source.properties", "/sdk-dir-placeholders/source.properties", "/sdk-empty-components/source.properties"].includes(p)) return "Pkg.Desc = Android SDK Base\nPkg.Revision = 35.0.0\n";
      throw new Error("missing");
    },
  };
  const manifests = await discoverAndroidSdk(probe, { homeSdkPath: "/sdk-empty", extraCandidates: ["/sdk-file", "/sdk-good", "/sdk-partial", "/sdk-placeholder", "/sdk-dir-placeholders", "/sdk-empty-components"] });
  assert.equal(manifests.some((item) => item.path === "/sdk-empty"), false);
  assert.equal(manifests.some((item) => item.path === "/sdk-file"), false);
  const good = manifests.find((item) => item.path === "/sdk-good");
  assert.ok(good);
  assert.equal(good.health, "healthy");
  const partial = manifests.find((item) => item.path === "/sdk-partial");
  assert.ok(partial);
  assert.equal(partial.health, "degraded");
  for (const sdkPath of ["/sdk-placeholder", "/sdk-dir-placeholders", "/sdk-empty-components"]) {
    const item = manifests.find((candidate) => candidate.path === sdkPath);
    assert.ok(item);
    assert.notEqual(item.health, "healthy", `${sdkPath} contains path/directory placeholders only`);
  }
  const routed = await discoverRuntimeToolchains(probe, "/home/toolchains", "/home/sdk");
  const genericHome = routed.find((item) => item.path === "/home/toolchains/android-sdk");
  assert.ok(genericHome, "HOME android-sdk path is still discoverable through strict SDK validation");
  assert.notEqual(genericHome.health, "healthy", "generic directory existence cannot override SDK-specific evidence");
});

await scenario("Ubuntu readiness requires a verified proot-distro login identity and rejects LSB-only or mismatched state", async () => {
  moduleCache.clear();
  const { buildProotDistroRootfsCheckCommand } = loadTs(path.join(root, "lib/termux-bootstrap-install.ts"));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aib-v228-ubuntu-id-"));
  try {
    const prefix = path.join(temp, "prefix");
    const rootfs = path.join(prefix, "var/lib/proot-distro/installed-rootfs/ubuntu");
    const bin = path.join(temp, "bin");
    fs.mkdirSync(path.join(rootfs, "bin"), { recursive: true });
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(rootfs, "bin/sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "proot-distro"), [
      "#!/bin/sh", "case \"$1\" in",
      "list) printf 'Installed distributions:\\n  ubuntu\\n'; exit 0;;",
      "login)",
      `  if grep -q '^ID=ubuntu$' \"$PREFIX/var/lib/proot-distro/installed-rootfs/ubuntu/etc/os-release\" 2>/dev/null; then`,
      "    printf 'AIB_PROBE_ID:ubuntu\\nAIB_PROBE_UID:1000\\nAIB_PROBE_UNAME:x86_64\\n'; exit 0;",
      "  fi; exit 1;;", "*) exit 1;;", "esac",
    ].join(String.fromCharCode(10)) + String.fromCharCode(10), { mode: 0o755 });
    const command = buildProotDistroRootfsCheckCommand("ubuntu");
    const env = { PREFIX: prefix, PATH: `${bin}:/usr/bin:/bin` };
    const unknown = bash(command, env);
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stdout, /UBUNTU_ROOTFS_INSTALLED_LOGIN_FAILED/);
    fs.mkdirSync(path.join(rootfs, "etc"), { recursive: true });
    fs.writeFileSync(path.join(rootfs, "etc/lsb-release"), "DISTRIB_ID=Ubuntu\nDISTRIB_RELEASE=20.04\n");
    const legacy = bash(command, env);
    assert.notEqual(legacy.status, 0, "legacy LSB metadata alone is not a live guest identity proof");
    assert.match(legacy.stdout, /UBUNTU_ROOTFS_INSTALLED_LOGIN_FAILED/);
    fs.writeFileSync(path.join(rootfs, "etc/os-release"), "ID=ubuntu\nNAME=Ubuntu\n");
    const healthy = bash(command, env);
    assert.equal(healthy.status, 0, healthy.stderr);
    assert.match(healthy.stdout, /UBUNTU_ROOTFS_OK/);
    fs.writeFileSync(path.join(rootfs, "etc/os-release"), "ID=debian\nNAME=Debian\n");
    const mismatch = bash(command, env);
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stdout, /UBUNTU_ROOTFS_INSTALLED_LOGIN_FAILED/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

console.log(`AIB_V228_DEEP_REGRESSION_SELFTEST ${cases.filter((c) => c.ok).length}/${cases.length}`);
if (cases.some((c) => !c.ok)) process.exitCode = 1;
