import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const plugin = fs.readFileSync("plugins/withTermuxBridge.js", "utf8");
const generatedModule = await import("node:module");
const templatePath = path.resolve("plugins/withTermuxBridge.js");
const generated = new generatedModule.default(templatePath);
generated.filename = templatePath;
generated.paths = generatedModule.default._nodeModulePaths(path.dirname(templatePath));
const originalLoad = generatedModule.default._load;
try {
  generatedModule.default._load = function(request, parent, isMain) {
    if (request === "@expo/config-plugins") return {
      withAndroidManifest: config => config,
      withMainApplication: config => config,
      withDangerousMod: config => config,
    };
    return originalLoad.call(this, request, parent, isMain);
  };
  generated._compile(plugin + "\nmodule.exports = { moduleKotlin };\n", templatePath);
} finally { generatedModule.default._load = originalLoad; }
const native = generated.exports.moduleKotlin("com.karat.aibuilder");

const status = native.slice(native.indexOf("fun getEmbeddedTermuxRuntimeStatus("), native.indexOf("private fun validatedEmbeddedRuntimeLayout()"));
const execution = native.slice(native.indexOf("private fun validatedEmbeddedRuntimeLayout()"), native.indexOf("/** Do not expose raw exception messages"));
assert.match(status, /canonicalEmbeddedRuntimeRoots\(\)/);
assert.match(execution, /canonicalEmbeddedRuntimeRoots\(\)/);
assert.match(status, /runtimeRoots != null && prefix\.isDirectory/);
assert.match(status, /runtimeRoots != null && home\.isDirectory/);
assert.match(status, /runtimeRoots != null && packageFeedSource\.isFile/);
assert.match(native, /prefix\.path != prefixExpected\.absolutePath \|\| home\.path != homeExpected\.absolutePath/);
assert.match(native, /val wrapper = "printf .*_aib_start/);
assert.match(native, /"-c", wrapper, "aib-embedded", command, rootPidFile\.absolutePath/);
assert.match(native, /awaitAibEmbeddedRootPid\(process!!, rootPidFile, 1_000L\)/);
assert.match(native, /AibEmbeddedProcessRegistry\.rootPids\[id\] = processRoot!!/);
assert.doesNotMatch(native, /getMethod\("pid"\)|\.pid\(\)/, "runtime PID tracking is API-24-compatible and avoids hidden PID reflection");
assert.match(native, /waitForAibEmbeddedProcess\(process!!, timeout, processRoot!!, trackedDescendants\)/);
const packageQuery = native.slice(native.indexOf("fun queryEmbeddedTermuxPackages("), native.indexOf("fun cancelEmbeddedTermuxCommand("));
assert.match(packageQuery, /dpkgQuery\.canonicalPath != dpkgQuery\.absolutePath \|\| !dpkgQuery\.isFile \|\| !dpkgQuery\.canExecute\(\)/, "package query retains its strict fixed executable allowlist");
assert.match(packageQuery, /AibEmbeddedTermuxBootstrapInstaller\.shellCommand\([\s\S]*?rootPidFile\.absolutePath, \*argv\.toTypedArray\(\)/, "query executable and operands are passed as argv through the private tracking wrapper");
assert.match(packageQuery, /awaitAibEmbeddedRootPid\(process!!, rootPidFile, 1_000L\)/);
assert.match(packageQuery, /waitForAibEmbeddedProcess\(process!!, 5_000L, processRoot!!, trackedDescendants\)/, "query timeout uses validated TERM-to-KILL tree cleanup");
assert.match(packageQuery, /cleanupAibEmbeddedDescendants\(processRoot!!\.pid, trackedDescendants\)/);
assert.match(packageQuery, /stopAibEmbeddedPackageReaders\(current, listOfNotNull\(stdoutThread, stderrThread\)\)[\s\S]*?releaseSlot = processTreeClean && readersClean/);
assert.doesNotMatch(packageQuery, /waitForAibEmbeddedProcess\(process!!, 5_000L\)/, "query no longer uses the TERM-only helper overload");
assert.match(native, /stopAibEmbeddedProcess\(process, root, tracked\)/, "bulk cancellation must pass the validated PID/start-time record");
assert.doesNotMatch(native, /stopAibEmbeddedProcess\(process, root\.pid, tracked\)/, "bulk cancellation must not pass a bare PID");
assert.match(native, /private fun trackAibEmbeddedDescendants\(/);
assert.match(native, /private fun cleanupAibEmbeddedDescendants\(/);
assert.match(native, /AibEmbeddedProcessRegistry\.descendants\.remove\(id\)/);
assert.match(native, /stdoutThread\.join\(1500\)/);
assert.match(native, /process!!\.inputStream\.close\(\)/);
assert.match(native, /process!!\.errorStream\.close\(\)/);

// Exercise the exact canonical identity predicate against normal and symlinked roots.
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aib-termux-root-gate-"));
try {
  const files = path.join(tempRoot, "files");
  const outside = path.join(tempRoot, "outside");
  fs.mkdirSync(files);
  fs.mkdirSync(outside);
  for (const leaf of ["usr", "home"]) fs.mkdirSync(path.join(files, leaf));
  const acceptsRoots = (root) => ["usr", "home"].every((leaf) => {
    const expected = path.join(root, leaf);
    return fs.realpathSync(expected) === expected;
  });
  assert.match(native, /val prefix = prefixExpected\.canonicalFile/);
  assert.match(native, /val home = homeExpected\.canonicalFile/);
  assert.equal(acceptsRoots(files), true, "canonical non-symlink usr/home are accepted");
  fs.renameSync(path.join(files, "usr"), path.join(outside, "usr-real"));
  fs.symlinkSync(path.join(outside, "usr-real"), path.join(files, "usr"), "dir");
  assert.equal(acceptsRoots(files), false, "a symlinked usr root fails the same canonical identity gate");
  fs.unlinkSync(path.join(files, "usr"));
  fs.mkdirSync(path.join(files, "usr"));
  fs.renameSync(path.join(files, "home"), path.join(outside, "home-real"));
  fs.symlinkSync(path.join(outside, "home-real"), path.join(files, "home"), "dir");
  assert.equal(acceptsRoots(files), false, "a symlinked home root fails the same canonical identity gate");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

function procStartTicks(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[19] ?? null;
  } catch { return null; }
}
function ownedDescendants(rootPid, tracked) {
  const visited = new Set();
  function visit(parentPid, depth = 0) {
    if (depth > 64 || visited.has(parentPid)) return;
    visited.add(parentPid);
    let childText = "";
    try { childText = fs.readFileSync(`/proc/${parentPid}/task/${parentPid}/children`, "utf8"); } catch { return; }
    for (const text of childText.trim().split(/\s+/).filter(Boolean)) {
      const pid = Number(text);
      const ticks = procStartTicks(pid);
      if (!ticks) continue;
      tracked.set(pid, ticks);
      visit(pid, depth + 1);
    }
  }
  visit(rootPid);
}
function signalOwned(tracked, signal) {
  for (const [pid, ticks] of tracked) {
    if (procStartTicks(pid) !== ticks) continue;
    try { process.kill(pid, signal); } catch { }
  }
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const wrapper = 'printf \'%s\\n\' "$$" > "$2" || exit 125; IFS= read -r _aib_start || exit 125; set +m; eval "$1"; command_status=$?; wait; exit $command_status';
const command = "trap '' TERM; (trap '' TERM; sleep 30) & child=$!; echo CHILD_PID=$child; echo STDERR_READY >&2; wait";
const lifecycleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aib-termux-lifecycle-"));
const pidFile = path.join(lifecycleRoot, "root-pid.txt");
// `$2` is the same bounded root-PID handoff used by the generated runtime wrapper.
const processChild = spawn("/bin/bash", ["--noprofile", "--norc", "-c", wrapper, "aib-host-test", command, pidFile], {
  stdio: ["pipe", "pipe", "pipe"],
  detached: true,
});
const tracked = new Map();
const stdoutChunks = [];
const stderrChunks = [];
let stdoutClosed = false;
let stderrClosed = false;
let outputText = "";
let resolveCommandStarted;
const commandStarted = new Promise((resolve) => { resolveCommandStarted = resolve; });
processChild.stdout.on("data", (chunk) => {
  stdoutChunks.push(chunk);
  outputText += chunk.toString();
  if (outputText.includes("CHILD_PID=")) resolveCommandStarted();
});
processChild.stderr.on("data", (chunk) => stderrChunks.push(chunk));
processChild.stdout.on("close", () => { stdoutClosed = true; });
processChild.stderr.on("close", () => { stderrClosed = true; });
const exitPromise = new Promise((resolve) => processChild.once("exit", resolve));
const closePromise = new Promise((resolve) => processChild.once("close", resolve));
const monitor = setInterval(() => ownedDescendants(processChild.pid, tracked), 10);
try {
  let rootPidText = "";
  const handoffDeadline = Date.now() + 1_000;
  while (Date.now() < handoffDeadline && !rootPidText) {
    try { rootPidText = fs.readFileSync(pidFile, "utf8").trim(); } catch { }
    if (!rootPidText) await wait(10);
  }
  assert.match(rootPidText, /^[1-9][0-9]{0,9}$/, "wrapper writes a bounded numeric root PID");
  assert.equal(Number(rootPidText), processChild.pid, "wrapper hands off its own root PID before user command execution");
  const rootTicks = procStartTicks(processChild.pid);
  assert.ok(rootTicks, "handed-off root PID has a validated /proc start time");
  processChild.stdin.write("\n");
  processChild.stdin.end();
  await Promise.race([commandStarted, wait(2_000).then(() => { throw new Error("fixture command did not reach its timeout"); })]);
  const outBeforeTimeout = Buffer.concat(stdoutChunks).toString();
  const spawnedPid = Number(outBeforeTimeout.match(/CHILD_PID=(\d+)/)?.[1]);
  assert.ok(Number.isInteger(spawnedPid) && spawnedPid > 0, "fixture emitted its background child PID");
  const timeoutAt = Date.now();
  ownedDescendants(processChild.pid, tracked);
  assert.ok(tracked.has(spawnedPid), "the background child is observed as a tracked descendant before cleanup");
  signalOwned(tracked, "SIGTERM");
  try { if (procStartTicks(processChild.pid) === rootTicks) process.kill(processChild.pid, "SIGTERM"); } catch { }
  await Promise.race([exitPromise, wait(400)]);
  if (processChild.exitCode === null) {
    signalOwned(tracked, "SIGKILL");
    try { if (procStartTicks(processChild.pid) === rootTicks) process.kill(processChild.pid, "SIGKILL"); } catch { }
  }
  const exitObserved = await Promise.race([exitPromise.then(() => true), wait(1_000).then(() => false)]);
  assert.equal(exitObserved, true, "shell process exits within the bounded TERM/KILL cleanup window");
  const closeObserved = await Promise.race([closePromise.then(() => true), wait(1_500).then(() => false)]);
  assert.equal(closeObserved, true, "stdout/stderr file descriptors close within the bounded cleanup window");
  clearInterval(monitor);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const start = procStartTicks(spawnedPid);
    if (start === null || start === tracked.get(spawnedPid) && (() => {
      try { return fs.readFileSync(`/proc/${spawnedPid}/stat`, "utf8").slice(fs.readFileSync(`/proc/${spawnedPid}/stat`, "utf8").lastIndexOf(")") + 1).trim().split(/\s+/)[0] === "Z"; } catch { return true; }
    })()) break;
    await wait(50);
  }
  assert.ok(Date.now() - timeoutAt < 2_500, "timeout and cleanup remain bounded");
  assert.equal(procStartTicks(spawnedPid), null, "owned background child is gone after timeout cleanup");
  assert.ok(processChild.exitCode !== null || processChild.signalCode !== null, "one-shot shell process exited and was reaped");
  assert.equal(stdoutClosed, true, "stdout pipe reader reaches close after timeout tree cleanup");
  assert.equal(stderrClosed, true, "stderr pipe reader reaches close after timeout tree cleanup");
  assert.ok(Buffer.concat(stderrChunks).toString().includes("STDERR_READY"), "stderr reader captured the fixture output before cleanup");
} finally {
  clearInterval(monitor);
  signalOwned(tracked, "SIGKILL");
  try { process.kill(-processChild.pid, "SIGKILL"); } catch { }
  if (processChild.exitCode === null) await Promise.race([closePromise, wait(1_000)]);
  fs.rmSync(lifecycleRoot, { recursive: true, force: true });
}

console.log("AIB_V502_TERMUX_RUNTIME_LIFECYCLE_SELFTEST_OK canonical symlink gate, TERM-ignoring helper SIGKILL, reap, stdout/stderr reader cleanup");
