#!/usr/bin/env node
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRuntimeTs } from "./test-helpers/load-runtime-ts.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const { TerminalSessionManager } = loadRuntimeTs(path.join(root, "core/enhancements/terminal/TerminalSessionManager.ts"));
const { TerminalQuickActions } = loadRuntimeTs(path.join(root, "core/enhancements/terminal/TerminalQuickActions.ts"));
const { applyTerminalCommandInputAction, createTerminalCommandInputState, insertTerminalCommandText } = loadRuntimeTs(path.join(root, "core/enhancements/terminal/TerminalCommandInputActions.ts"));
const storage = new Map();
const calls = { created: 0, createdRoots: [], closed: [], restored: [], sent: [] };
const attachedIds = new Set();
const makeHandle = (id, projectId, cwd, projectRoot = cwd) => ({ id, projectId, cwd, env: { AI_BUILDER_HOME: "/home/aib", PWD: cwd, PROJECT_ROOT: projectRoot, API_KEY: "must-not-persist" } });
let manager;
let emitOutputDuringSend = false;
const hooks = {
  async createProjectSession(projectId, projectRoot) { calls.createdRoots.push(projectRoot); calls.created += 1; const root = projectRoot ?? `/home/aib/projects/${projectId}`; const id = `term-${calls.created}`; attachedIds.add(id); return makeHandle(id, projectId, root, root); },
  async restoreProjectSession(projectId, cwd, env, projectRoot) { calls.restored.push({ projectId, cwd, env, projectRoot }); calls.created += 1; const id = `term-${calls.created}`; attachedIds.add(id); return makeHandle(id, projectId, cwd, projectRoot ?? env.PROJECT_ROOT); },
  async closeSession(id) { calls.closed.push(id); attachedIds.delete(id); },
  async send(id, text) {
    calls.sent.push({ id, text, scrollbackAtDispatch: (await manager.get(id))?.scrollback ?? "" });
    if (emitOutputDuringSend) await manager.appendScrollback(id, "OUTPUT\n");
  },
  isAttached: (id) => attachedIds.has(id),
};
manager = new TerminalSessionManager({ async get(key) { return storage.get(key) ?? null; }, async set(key, value) { storage.set(key, value); } }, hooks, () => 1000);
const demoRoot = "/storage/emulated/0/AIBuilderTermux/projects/demo-app-1700000000000-abc123";
const opened = await manager.openProjectSession("demo-app", demoRoot);
assert.equal(opened.state, "attached");
assert.equal(opened.projectRoot, demoRoot, "session records the exact root chosen by the project store");
assert.equal(calls.createdRoots[0], demoRoot, "runtime hook receives the exact project path, not the project ID-derived path");
assert.equal(Object.hasOwn(opened.env, "API_KEY"), false);
const prompt = "\n$ printf result\n";
emitOutputDuringSend = true;
await manager.send(opened.id, "printf result\n", prompt);
emitOutputDuringSend = false;
assert.equal(calls.sent[0].scrollbackAtDispatch, prompt, "prompt is persisted before dispatch can publish output");
assert.equal((await manager.get(opened.id)).scrollback, `${prompt}OUTPUT\n`, "persisted transcript preserves prompt-before-output order");
await manager.send(opened.id, "cd\n");
assert.equal((await manager.get(opened.id)).cwd, "/home/aib", "bare cd uses the logical app home without changing Termux HOME");
await manager.send(opened.id, "cd /tmp/work\n");
assert.equal((await manager.get(opened.id)).cwd, "/tmp/work", "cd updates the saved session cwd");
assert.equal((await manager.get(opened.id)).env.PWD, "/tmp/work", "cd keeps persisted PWD consistent with cwd");
await manager.appendScrollback(opened.id, "hello\n");
await manager.close(opened.id);
const saved = (await manager.list()).find((row) => row.id === opened.id);
assert.equal(saved?.state, "saved");
const restored = await manager.restoreSession(opened.id);
assert.equal(restored?.state, "attached");
assert.equal(restored?.scrollback, `${prompt}OUTPUT\nhello\n`);
assert.equal(calls.restored[0]?.cwd, "/tmp/work", "restore receives the cwd saved after cd");
assert.equal(calls.restored[0]?.env.PWD, "/tmp/work", "restore receives PWD consistent with the saved cwd");
assert.equal(calls.restored[0]?.projectRoot, demoRoot, "restore receives the separately saved project root even after shell cd");
assert.equal(restored?.cwd, "/tmp/work");
assert.equal(restored?.projectRoot, demoRoot, "the restored session keeps the original project identity path");
assert.equal(calls.closed[0], opened.id);
await assert.rejects(() => manager.openProjectSession("../escape"), /PROJECT_ID_INVALID/);

const legacyRoot = "/storage/emulated/0/AIBuilderTermux/projects/proj_demo-app";
const legacyAttached = await manager.openProjectSession("demo-app", legacyRoot);
const migrated = await manager.restoreSession(legacyAttached.id, demoRoot);
assert.notEqual(migrated?.id, legacyAttached.id, "an attached legacy session with another root is not reused");
assert.equal(calls.restored.at(-1)?.projectRoot, demoRoot, "a live mismatched session is reopened with the selected project's exact root");
assert.equal(migrated?.projectRoot, demoRoot);
assert.equal(attachedIds.has(legacyAttached.id), true, "root mismatch does not terminate the existing process");

const ran = [];
const actions = new TerminalQuickActions(async (id) => { ran.push(id); return { ok: true, supported: true }; });
assert.ok(actions.all().some((item) => item.id === "copy-all"));
actions.setVisible(["copy-all", "new-session"]);
assert.deepEqual(actions.list().map((item) => item.id), ["copy-all", "new-session"]);
await actions.execute("copy-all");
assert.deepEqual(ran, ["copy-all"]);
assert.equal((await actions.execute("ctrl")).supported, false);
assert.throws(() => actions.setVisible(["not-allowlisted"]), /NOT_ALLOWLISTED/);

let input = createTerminalCommandInputState("git status");
input = { ...input, selection: { start: 4, end: 4 } };
input = insertTerminalCommandText(input, "\t");
assert.equal(input.value, "git \tstatus");
assert.deepEqual(input.selection, { start: 5, end: 5 });
input = applyTerminalCommandInputAction("arrow-left", input, []).state;
assert.deepEqual(input.selection, { start: 4, end: 4 }, "left arrow edits the command composer cursor");
input = applyTerminalCommandInputAction("home", { ...input, value: "first\nsecond", selection: { start: 9, end: 9 } }, []).state;
assert.deepEqual(input.selection, { start: 6, end: 6 }, "Home moves to the current input line, not a shell prompt");
const drafted = createTerminalCommandInputState("unsent draft");
const historyUp = applyTerminalCommandInputAction("arrow-up", drafted, ["npm test", "git status"]);
assert.equal(historyUp.state.value, "npm test");
assert.equal(historyUp.state.draftBeforeHistory, "unsent draft");
assert.equal(applyTerminalCommandInputAction("arrow-down", historyUp.state, ["npm test", "git status"]).state.value, "unsent draft");
assert.equal(applyTerminalCommandInputAction("escape", drafted, []).state.value, "", "Escape clears only the unsent command draft");
assert.equal(applyTerminalCommandInputAction("page-up", drafted, []).effect, "page-up", "page keys scroll output rather than sending key sequences");
assert.equal(applyTerminalCommandInputAction("ctrl", drafted, []).supported, false);
assert.equal(applyTerminalCommandInputAction("alt", drafted, []).supported, false);
assert.equal(applyTerminalCommandInputAction("kill-process", drafted, []).supported, false);

const { TermuxTerminalBackend } = loadRuntimeTs(path.join(root, "core/environment/TermuxTerminalBackend.ts"));
let finishExec;
let execOptions;
let execCommand;
const backend = new TermuxTerminalBackend({
  getHome: () => "/data/data/com.termux/files/home",
  async exec(command, options) {
    execCommand = command;
    execOptions = options;
    return new Promise((resolve) => { finishExec = () => resolve({ exitCode: 0, stdout: "finished", stderr: "" }); });
  },
});
const runningSession = await backend.createSession({ id: "term-running", cwd: "/storage/emulated/0/AIBuilderTermux/projects/demo", home: "/storage/emulated/0/AIBuilderTermux", env: { HOME: "/storage/emulated/0/AIBuilderTermux" } });
let writeFinished = false;
const pendingWrite = runningSession.write("proot-distro list\n").then(() => { writeFinished = true; });
await Promise.resolve();
assert.equal(typeof finishExec, "function", "mock one-shot execution is pending");
assert.equal(execOptions?.env?.HOME, undefined, "app-owned HOME must not replace Termux's native HOME");
assert.equal(execOptions?.env?.AI_BUILDER_HOME, "/storage/emulated/0/AIBuilderTermux", "app storage remains available through AI_BUILDER_HOME");
assert.equal(execOptions?.env?.PWD, "/storage/emulated/0/AIBuilderTermux/projects/demo");
assert.match(execCommand, /proot-distro list/);
await assert.rejects(() => runningSession.kill(), /TERMINAL_PROCESS_CONTROL_UNSUPPORTED/);
assert.equal(execOptions?.signal, undefined, "the production adapter does not pass cancellation into the Termux bridge");
assert.equal(writeFinished, false, "kill does not pretend the executing one-shot command was cancelled");
await runningSession.write("cd /tmp/still-open\n");
assert.equal(writeFinished, false, "unsupported kill leaves the logical session open");
finishExec();
await pendingWrite;
assert.equal(writeFinished, true);
console.log("AIB_TERMINAL_SESSION_SELFTEST_OK");
