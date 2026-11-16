#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { typescript } from "./test-helpers/load-typescript.mjs";

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aib-agent-write-"));
try {
  for (const rel of ["core/agent/AgentTypes.ts", "core/project-manager.ts", "core/agent/AgentManager.ts"]) {
    const dest = path.join(temp, rel.replace(/\.ts$/, ".js"));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, typescript.transpile(fs.readFileSync(path.join(root, rel), "utf8"), { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 }));
  }
  const { AgentManager } = createRequire(import.meta.url)(path.join(temp, "core/agent/AgentManager.js"));
  const files = new Map();
  const dirs = new Set(["/home", "/home/projects", "/home/projects/demo"]);
  const listCommands = [];
  const readCalls = [];
  const mutationEvents = [];
  files.set("/home/projects/demo/README.md", "benign workspace documentation");
  files.set("/home/projects/demo/.env", "SYNTHETIC_SECRET_SHOULD_NOT_BE_READ");
  files.set("/home/projects/demo/.env.example", "API_KEY=replace-with-your-key");
  const env = {
    getHome() { return "/home"; },
    async resolvePath(value) { return path.posix.normalize(value); },
    async exists(value) { return files.has(value) || dirs.has(value); },
    async mkdir(value) { mutationEvents.push(`mkdir:${path.posix.normalize(value)}`); dirs.add(path.posix.normalize(value)); },
    async read(value) { readCalls.push(value); if (!files.has(value)) throw new Error("ENOENT"); return files.get(value); },
    async write(value, content) { files.set(value, content); },
    async exec(command, options) {
      listCommands.push({ command, options });
      return { exitCode: 0, stdout: [
        "/home/projects/demo/src/app.ts",
        "/home/projects/demo/.git/config",
        "/home/projects/demo/.env",
        "/home/projects/demo/config/api_key.json",
      ].join("\n"), stderr: "" };
    },
  };
  const manager = new AgentManager(env);
  const basePolicy = { projectIsolation: true, homeIsolation: true, maxConcurrentTools: 1 };
  const reader = manager.create({ id: "reader", projectId: "demo", policy: { ...basePolicy, allowedCapabilities: ["filesystem"] } });
  let result;
  result = await manager.execute(reader.id, { tool: "fs.list", args: { path: "/home/projects/demo", maxDepth: 2 }, capability: "filesystem" });
  assert.equal(result.ok, true);
  assert.equal(result.output, "/home/projects/demo/src/app.ts");
  assert.equal(listCommands.length, 1);
  assert.match(listCommands[0].command, /-maxdepth 2 -mindepth 1 -type f/);
  assert.equal(listCommands[0].options.timeoutMs, 15_000);
  result = await manager.execute(reader.id, { tool: "fs.read", args: { path: "/home/projects/demo/.env" }, capability: "filesystem" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "SENSITIVE_FILE_READ_BLOCKED");
  assert.equal(readCalls.includes("/home/projects/demo/.env"), false, "sensitive file reads must be denied before the environment is called");
  result = await manager.execute(reader.id, { tool: "fs.read", args: { path: "/home/projects/demo/README.md" }, capability: "filesystem" });
  assert.equal(result.ok, true, "benign workspace files remain readable");
  assert.equal(result.output, "benign workspace documentation");
  result = await manager.execute(reader.id, { tool: "fs.read", args: { path: "/home/projects/demo/.env.example" }, capability: "filesystem" });
  assert.equal(result.ok, true, "safe environment templates remain readable");
  result = await manager.execute(reader.id, { tool: "fs.list", args: { path: "/home/projects/other" }, capability: "filesystem" });
  assert.equal(result.ok, false);
  assert.match(result.error, /PROJECT isolation/);
  result = await manager.execute(reader.id, { tool: "fs.list", args: { path: "/home/projects/demo", maxDepth: 99 }, capability: "filesystem" });
  assert.equal(result.error, "FS_LIST_ARGUMENT_INVALID");
  assert.equal(listCommands.length, 1, "invalid and out-of-project paths must not reach the shell");
  result = await manager.execute(reader.id, { tool: "fs.mkdir", args: { path: "/home/projects/demo/new-dir" }, capability: "filesystem.write" });
  assert.equal(result.ok, false);
  assert.match(result.error, /Capability denied/);
  assert.equal(dirs.has("/home/projects/demo/new-dir"), false);
  result = await manager.execute(reader.id, { tool: "fs.write", args: { path: "/home/projects/demo/a.txt", content: "blocked" }, capability: "filesystem.write" });
  assert.equal(result.ok, false);
  assert.match(result.error, /Capability denied/);
  assert.equal(files.has("/home/projects/demo/a.txt"), false);

  const noCheckpoint = manager.create({ id: "no-checkpoint", projectId: "demo", policy: { ...basePolicy, allowedCapabilities: ["filesystem", "filesystem.write"] } });
  result = await manager.execute(noCheckpoint.id, { tool: "fs.write", args: { path: "/home/projects/demo/a.txt", content: "blocked" }, capability: "filesystem.write" });
  assert.equal(result.error, "FILE_WRITE_CHECKPOINT_UNAVAILABLE");
  assert.equal(files.has("/home/projects/demo/a.txt"), false);
  result = await manager.execute(noCheckpoint.id, { tool: "fs.mkdir", args: { path: "/home/projects/demo/no-checkpoint-dir" }, capability: "filesystem.write" });
  assert.equal(result.error, "DIRECTORY_CREATE_CHECKPOINT_UNAVAILABLE");
  assert.equal(dirs.has("/home/projects/demo/no-checkpoint-dir"), false);

  let checkpoints = 0;
  const checkpointPaths = [];
  manager.setHostHooks({ beforeFileWrite: async (_agent, candidate) => { checkpoints += 1; checkpointPaths.push(candidate); mutationEvents.push(`checkpoint:${candidate}`); } });
  const writer = manager.create({ id: "writer", projectId: "demo", policy: { ...basePolicy, allowedCapabilities: ["filesystem", "filesystem.write"] } });
  result = await manager.execute(writer.id, { tool: "fs.write", args: { path: "/home/projects/demo/a.txt", content: "safe edit" }, capability: "filesystem.write" });
  assert.equal(result.ok, true);
  assert.equal(files.get("/home/projects/demo/a.txt"), "safe edit");
  assert.equal(checkpoints, 1);
  assert.equal(checkpointPaths[0], "/home/projects/demo/a.txt");
  mutationEvents.length = 0;
  result = await manager.execute(writer.id, { tool: "fs.mkdir", args: { path: "/home/projects/demo/new-dir" }, capability: "filesystem.write" });
  assert.equal(result.ok, true);
  assert.deepEqual(mutationEvents, ["checkpoint:/home/projects/demo/new-dir", "mkdir:/home/projects/demo/new-dir"], "mkdir must not run before its durable checkpoint");
  assert.equal(checkpoints, 2);

  result = await manager.execute(writer.id, { tool: "fs.write", args: { path: "/home/projects/other/evil.txt", content: "blocked" }, capability: "filesystem.write" });
  assert.equal(result.ok, false);
  assert.match(result.error, /PROJECT isolation/);
  assert.equal(files.has("/home/projects/other/evil.txt"), false);
  result = await manager.execute(writer.id, { tool: "fs.write", args: { path: "/home/projects/demo/../outside.txt", content: "blocked" }, capability: "filesystem.write" });
  assert.equal(result.error, "FS_WRITE_ARGUMENT_INVALID");
  assert.equal(checkpoints, 2);

  // An active project may live outside the legacy HOME/projects/<id> layout.
  // The explicit root remains canonicalized beneath HOME and is the sole scope.
  const activeRoot = "/home/active-workspaces/demo-project";
  dirs.add(activeRoot);
  const activeWriter = manager.create({ id: "active-writer", projectId: "demo", projectRoot: activeRoot, policy: { ...basePolicy, allowedCapabilities: ["filesystem", "filesystem.write"] } });
  let activeCheckpointPath = "";
  manager.setHostHooks({ beforeFileWrite: async (_agent, candidate) => { activeCheckpointPath = candidate; } });
  result = await manager.execute(activeWriter.id, { tool: "fs.write", args: { path: `${activeRoot}/main.ts`, content: "active workspace" }, capability: "filesystem.write" });
  assert.equal(result.ok, true);
  assert.equal(activeCheckpointPath, `${activeRoot}/main.ts`);
  assert.equal(files.get(`${activeRoot}/main.ts`), "active workspace");
  result = await manager.execute(activeWriter.id, { tool: "fs.write", args: { path: "/home/projects/demo/other.ts", content: "blocked" }, capability: "filesystem.write" });
  assert.equal(result.ok, false);
  assert.match(result.error, /PROJECT isolation/);

  const escapedRoot = manager.create({ id: "escaped-root", projectId: "demo", projectRoot: "/outside/project", policy: { ...basePolicy, allowedCapabilities: ["filesystem"] } });
  result = await manager.execute(escapedRoot.id, { tool: "fs.exists", args: { path: "/outside/project/main.ts" }, capability: "filesystem" });
  assert.equal(result.ok, false);
  assert.match(result.error, /PROJECT isolation/);

  // Android toolchain is a separate capability and must checkpoint before host dispatch.
  const toolchainRoot = "/home/active-workspaces/toolchain-project";
  dirs.add(toolchainRoot);
  const toolchainOrder = [];
  manager.setHostHooks({
    beforeFileWrite: async (_agent, candidate) => { toolchainOrder.push(`checkpoint:${candidate}`); },
    runAndroidToolchain: async (_agent, args, rootPath) => { toolchainOrder.push(`tool:${rootPath}:${args.variant ?? "debug"}`); return { ok: true }; },
  });
  const toolchainAgent = manager.create({ id: "offline-toolchain", projectId: "demo", projectRoot: toolchainRoot, policy: { ...basePolicy, allowedCapabilities: ["filesystem", "android.toolchain"] } });
  result = await manager.execute(toolchainAgent.id, { tool: "android.toolchain.run", args: { variant: "debug" }, capability: "android.toolchain" });
  assert.equal(result.ok, true);
  assert.equal(toolchainOrder[0], `checkpoint:${toolchainRoot}/.aib-toolchain-build`);
  assert.equal(toolchainOrder[1], `tool:${toolchainRoot}:debug`);
  result = await manager.execute(toolchainAgent.id, { tool: "android.toolchain.run", args: {}, capability: "filesystem.write" });
  assert.equal(result.ok, false);
  assert.match(result.error, /TOOL_CAPABILITY_MISMATCH/);
  result = await manager.execute(toolchainAgent.id, { tool: "shell.exec", args: { command: "whoami" }, capability: "terminal" });
  assert.equal(result.ok, false);
  assert.match(result.error, /Capability denied: terminal/);

  const noToolchainCheckpoint = new AgentManager(env);
  noToolchainCheckpoint.setHostHooks({ runAndroidToolchain: async () => { throw new Error("must not dispatch"); } });
  const deniedAgent = noToolchainCheckpoint.create({ id: "offline-toolchain-no-checkpoint", projectId: "demo", projectRoot: toolchainRoot, policy: { ...basePolicy, allowedCapabilities: ["android.toolchain"] } });
  result = await noToolchainCheckpoint.execute(deniedAgent.id, { tool: "android.toolchain.run", args: {}, capability: "android.toolchain" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "ANDROID_TOOLCHAIN_CHECKPOINT_UNAVAILABLE");
  const taskCheckpointManager = new AgentManager(env);
  let shellDispatched = false;
  taskCheckpointManager.setHostHooks({ beforeTask: async () => { throw new Error("TASK_CHECKPOINT_REQUIRED"); }, runShell: async () => { shellDispatched = true; return { exitCode: 0, stdout: "should-not-run", stderr: "" }; } });
  const taskWriter = taskCheckpointManager.create({ id: "task-checkpoint-failure", projectId: "demo", projectRoot: "/home/projects/demo", policy: { ...basePolicy, homeIsolation: false, projectIsolation: false, allowedCapabilities: ["terminal"] } });
  result = await taskCheckpointManager.execute(taskWriter.id, { tool: "shell.exec", args: { command: "touch unsafe.txt", cwd: "/home/projects/demo" }, capability: "terminal" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "TASK_CHECKPOINT_REQUIRED");
  assert.equal(shellDispatched, false, "shell work must not dispatch after a failed checkpoint hook");

  let sensitiveShellDispatches = 0;
  manager.setHostHooks({ runIsolatedShell: async (command) => { sensitiveShellDispatches += 1; return { exitCode: 0, stdout: `ran:${command}`, stderr: "" }; } });
  const shellReader = manager.create({ id: "shell-reader", projectId: "demo", policy: { ...basePolicy, allowedCapabilities: ["terminal"] } });
  result = await manager.execute(shellReader.id, { tool: "shell.exec", args: { command: "cat /home/projects/demo/.env", cwd: "/home/projects/demo" }, capability: "terminal" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "SENSITIVE_FILE_ACCESS_BLOCKED");
  assert.equal(sensitiveShellDispatches, 0, "sensitive shell commands must be rejected before host dispatch");
  result = await manager.execute(shellReader.id, { tool: "shell.exec", args: { command: `python3 -c 'print(open(".env").read())'`, cwd: "/home/projects/demo" }, capability: "terminal" });
  assert.equal(result.ok, false, "quoted interpreter-based reads of a sensitive file must also be rejected");
  assert.equal(result.error, "SENSITIVE_FILE_ACCESS_BLOCKED");
  assert.equal(sensitiveShellDispatches, 0, "interpreter reads must be denied before host dispatch");
  result = await manager.execute(shellReader.id, { tool: "shell.exec", args: { command: "cat README.md", cwd: "/home/projects/demo" }, capability: "terminal" });
  assert.equal(result.ok, true, "benign project shell commands remain available");
  assert.equal(sensitiveShellDispatches, 1);

  const manifestEvents = [];
  manager.setHostHooks({
    beforeFileWrite: async (_agent, candidate) => { manifestEvents.push(`checkpoint:${candidate}`); },
    writeManifest: async (_agent, content) => { manifestEvents.push(`manifest:${content}`); },
  });
  const manifestWriter = manager.create({ id: "manifest-writer", projectId: "demo", policy: { ...basePolicy, allowedCapabilities: ["manifest.write"] } });
  result = await manager.execute(manifestWriter.id, { tool: "manifest.write", args: { content: '{"services":[]}' }, capability: "manifest.write" });
  assert.equal(result.ok, true);
  assert.deepEqual(manifestEvents, ["checkpoint:/home/projects/demo/.aib/runtime.yaml", "manifest:{\"services\":[]}"], "manifest mutation must follow its durable checkpoint");

  let uncheckpointedManifestWrites = 0;
  const noManifestCheckpoint = new AgentManager(env);
  noManifestCheckpoint.setHostHooks({ writeManifest: async () => { uncheckpointedManifestWrites += 1; } });
  const noManifestAgent = noManifestCheckpoint.create({ id: "manifest-no-checkpoint", projectId: "demo", policy: { ...basePolicy, allowedCapabilities: ["manifest.write"] } });
  result = await noManifestCheckpoint.execute(noManifestAgent.id, { tool: "manifest.write", args: { content: '{"services":[]}' }, capability: "manifest.write" });
  assert.equal(result.error, "MANIFEST_CHECKPOINT_UNAVAILABLE");
  assert.equal(uncheckpointedManifestWrites, 0, "manifest writes fail closed without a checkpoint hook");

  console.log("AIB_AGENT_FS_WRITE_SELFTEST_OK sensitive_reads=blocked benign_reads=available fs_mutations_checkpointed=write,mkdir,manifest,toolchain project_isolation=verified");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
