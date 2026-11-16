import assert from "node:assert/strict";
import fs from "node:fs";

const { runWithEmbeddedAbort } = await import("../lib/embedded-exec-cancellation.ts");
const { enqueueTermuxCommand } = await import("../lib/termux-command-queue.ts");
const plugin = fs.readFileSync("plugins/withTermuxBridge.js", "utf8");
const bridge = fs.readFileSync("lib/termux-bridge.ts", "utf8");
const executor = fs.readFileSync("lib/termux-executor.ts", "utf8");
const terminal = fs.readFileSync("app/terminal.tsx", "utf8");

const preAborted = new AbortController();
preAborted.abort();
let preStartCalls = 0;
await assert.rejects(
  runWithEmbeddedAbort(preAborted.signal, async () => {
    preStartCalls += 1;
    return "unexpected";
  }, async () => true),
  /ABORTED/,
);
assert.equal(preStartCalls, 0, "pre-aborted requests must not launch native work");

let resolveExecution;
const execution = new Promise((resolve) => { resolveExecution = resolve; });
const controller = new AbortController();
let cancelCalls = 0;
let settled = false;
const running = runWithEmbeddedAbort(
  controller.signal,
  () => execution,
  async () => { cancelCalls += 1; return true; },
).finally(() => { settled = true; });
controller.abort();
controller.abort();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(cancelCalls, 1, "abort must issue exactly one native cancellation request");
assert.equal(settled, false, "JS must await native execution cleanup before rejecting");
resolveExecution({ exitCode: 143 });
await assert.rejects(running, /ABORTED/);
assert.equal(settled, true);

const abortDuringFailure = new AbortController();
let resolveFailureCleanup;
let failedCancelCalls = 0;
const failureCleanup = new Promise((resolve) => { resolveFailureCleanup = resolve; });
const abortedFailure = runWithEmbeddedAbort(
  abortDuringFailure.signal,
  async () => { throw new Error("native-rejected-after-cancel"); },
  async () => { failedCancelCalls += 1; await failureCleanup; throw new Error("cancel transport failed"); },
);
abortDuringFailure.abort();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(failedCancelCalls, 1, "a rejection racing with abort must still request cancellation once");
let failureSettled = false;
void abortedFailure.then(() => { failureSettled = true; }, () => { failureSettled = true; });
await new Promise((resolve) => setImmediate(resolve));
assert.equal(failureSettled, false, "aborted rejection must await cancellation cleanup even when cancel reports failure");
resolveFailureCleanup();
await assert.rejects(abortedFailure, /ABORTED/);
assert.equal(failureSettled, true);

const nonAborted = await runWithEmbeddedAbort(
  undefined,
  async () => ({ exitCode: 0, stdout: "ok" }),
  async () => { throw new Error("must not cancel"); },
);
assert.deepEqual(nonAborted, { exitCode: 0, stdout: "ok" });

const completedController = new AbortController();
const originalAdd = completedController.signal.addEventListener.bind(completedController.signal);
const originalRemove = completedController.signal.removeEventListener.bind(completedController.signal);
let addedAbortListeners = 0;
let removedAbortListeners = 0;
completedController.signal.addEventListener = (type, listener, options) => {
  if (type === "abort") addedAbortListeners += 1;
  return originalAdd(type, listener, options);
};
completedController.signal.removeEventListener = (type, listener, options) => {
  if (type === "abort") removedAbortListeners += 1;
  return originalRemove(type, listener, options);
};
let completedCancelCalls = 0;
await runWithEmbeddedAbort(completedController.signal, async () => "done", async () => { completedCancelCalls += 1; });
completedController.abort();
assert.equal(addedAbortListeners, 1);
assert.equal(removedAbortListeners, 1, "completion must remove the abort listener");
assert.equal(completedCancelCalls, 0, "a later abort after cleanup must not cancel a completed request");

async function assertQueueOrder(first, second) {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const started = [];
  const firstJob = enqueueTermuxCommand(async () => { started.push(first); await blocked; });
  const secondJob = enqueueTermuxCommand(async () => { started.push(second); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [first], `${first} owns the exclusive slot before ${second}`);
  release();
  await Promise.all([firstJob, secondJob]);
  assert.deepEqual(started, [first, second]);
}
await assertQueueOrder("candidate", "shell");
await assertQueueOrder("shell", "candidate");

let releaseQueueOwner;
const queueOwner = enqueueTermuxCommand(() => new Promise((resolve) => { releaseQueueOwner = resolve; }));
await new Promise((resolve) => setImmediate(resolve));
const queuedCandidateAbort = new AbortController();
let queuedCandidateNativeStarts = 0;
const queuedCandidate = enqueueTermuxCommand(() => runWithEmbeddedAbort(
  queuedCandidateAbort.signal,
  async () => { queuedCandidateNativeStarts += 1; return "unexpected"; },
  async () => true,
));
queuedCandidateAbort.abort();
releaseQueueOwner();
await queueOwner;
await assert.rejects(queuedCandidate, /ABORTED/);
assert.equal(queuedCandidateNativeStarts, 0, "queued abort must settle without launching native candidate work");

assert.match(plugin, /val pending = ConcurrentHashMap\.newKeySet<String>\(\)/);
assert.match(plugin, /val cancelRequested = ConcurrentHashMap\.newKeySet<String>\(\)/);
assert.match(plugin, /val rootPids = ConcurrentHashMap<String, AibEmbeddedTrackedRoot>\(\)/);
assert.match(plugin, /val descendants = ConcurrentHashMap<String, ConcurrentHashMap<Int, String>>\(\)/);
assert.match(plugin, /fun cancelEmbeddedTermuxCommand\(/);
assert.match(plugin, /private fun stopAibEmbeddedProcess\(/);
assert.match(plugin, /private fun trackAibEmbeddedDescendants\(/);
assert.match(plugin, /AibEmbeddedProcessRegistry\.pending\.toList\(\)/);
assert.match(plugin, /AibEmbeddedProcessRegistry\.active\[id\]/);
assert.match(plugin, /stopAibEmbeddedProcess\(process, root, tracked\)/);
assert.match(plugin, /awaitAibEmbeddedRootPid\(process!!, rootPidFile, 1_000L\)/);
assert.doesNotMatch(plugin, /getMethod\("pid"\)|\.pid\(\)/, "cancellation tracking must not reflect on API-26-only Process.pid()");
assert.match(plugin, /cancelRequested\.contains\(id\)/);
const candidate = plugin.slice(plugin.indexOf("fun runEmbeddedCandidateFullTransaction("), plugin.indexOf("/** Reads only a bounded apply.log"));
const reserveHelper = plugin.slice(plugin.indexOf("private fun reserveAibEmbeddedRequest("), plugin.indexOf("/** Remove cancellation state"));
const releaseHelper = plugin.slice(plugin.indexOf("private fun releaseAibEmbeddedRequest("), plugin.indexOf("private fun requestAibEmbeddedCancellation("));
const internalRunner = plugin.slice(plugin.indexOf("private fun runEmbeddedTermuxCommandInternal("), plugin.indexOf("/** Read the app-private dpkg registry"));
assert.match(reserveHelper, /pending\.add\(id\)/);
assert.match(candidate, /reserveAibEmbeddedRequest\(requestId\)/);
assert.ok(candidate.indexOf("reserveAibEmbeddedRequest(requestId)") < candidate.indexOf("AibCandidateFullFeed.stage("), "candidate request ID is pending before asset staging begins");
assert.match(candidate, /cancelRequested\.contains\(requestId\)[\s\S]*?runEmbeddedTermuxCommandInternal\(command, null, 900000\.0, requestId, promise, 900000L, true\)/);
assert.match(candidate, /finally\s*\{\s*if \(!ownershipTransferred\) releaseAibEmbeddedRequest\(requestId\)/);
assert.match(internalRunner, /requestAlreadyReserved: Boolean = false/);
assert.match(internalRunner, /if \(requestAlreadyReserved\)[\s\S]*?pending\.contains\(id\)[\s\S]*?\} else \{[\s\S]*?reserveAibEmbeddedRequest\(id\)/);
assert.doesNotMatch(internalRunner, /pending\.add\(id\)/, "an already reserved candidate ID is not re-registered by the command runner");
assert.match(releaseHelper, /if \(AibEmbeddedProcessRegistry\.pending\.remove\(id\)\)[\s\S]*?cancelRequested\.remove\(id\)[\s\S]*?slots\.release\(\)/);
assert.match(plugin, /if \(!requestAibEmbeddedCancellation\(id\)\) \{ promise\.resolve\(false\); return \}/);

// Exercise the staging race: cancellation is accepted while stage is blocked, and the
// post-stage gate prevents runner dispatch while the reservation is released exactly once.
const registry = { slots: 1, pending: new Set(), cancelRequested: new Set(), releases: 0 };
function reserve(id) {
  if (registry.pending.has(id)) return false;
  if (registry.slots < 1) return false;
  registry.slots -= 1;
  registry.pending.add(id);
  return true;
}
function cancel(id) {
  if (!registry.pending.has(id)) return false;
  registry.cancelRequested.add(id);
  return true;
}
function release(id) {
  if (registry.pending.delete(id)) {
    registry.cancelRequested.delete(id);
    registry.slots += 1;
    registry.releases += 1;
  }
}
assert.equal(reserve("stage-cancel"), true);
let releaseStage;
const stagingGate = new Promise((resolve) => { releaseStage = resolve; });
let transactionRunnerCalls = 0;
const stagingRequest = (async () => {
  try {
    await stagingGate;
    if (registry.cancelRequested.has("stage-cancel")) throw new Error("cancelled");
    transactionRunnerCalls += 1;
  } catch (error) {
    assert.match(error.message, /cancelled/);
  } finally {
    release("stage-cancel");
  }
})();
assert.equal(registry.pending.has("stage-cancel"), true, "the staging request is already cancelable");
assert.equal(cancel("stage-cancel"), true, "cancel endpoint accepts a pending staging request");
releaseStage();
await stagingRequest;
assert.equal(transactionRunnerCalls, 0, "cancelled staging never dispatches the transaction runner");
assert.equal(registry.pending.has("stage-cancel"), false, "staging cancellation clears pending");
assert.equal(registry.cancelRequested.has("stage-cancel"), false, "staging cancellation clears cancelRequested");
assert.equal(registry.slots, 1, "staging cancellation returns its owned slot");
release("stage-cancel");
assert.equal(registry.releases, 1, "the slot is released exactly once");

assert.match(bridge, /runWithEmbeddedAbort\(/);
assert.match(bridge, /EMBEDDED_CANCEL_UNAVAILABLE/);
assert.match(executor, /signal: options\.signal/);
const probeSource = terminal.slice(terminal.indexOf("const runEmbeddedRuntimeProbe"), terminal.indexOf("const toolbarActions"));
assert.match(probeSource, /const controller = new AbortController\(\)/, "the visible private probe owns its AbortController");
assert.match(probeSource, /privateRuntimeProvider\.execute\(probe,[\s\S]*signal: controller\.signal/, "only the private-provider probe receives the cancellation signal");
assert.match(probeSource, /probeAbortControllerRef\.current === controller/, "probe cleanup clears only its own controller");
assert.match(probeSource, /controller\.signal\.aborted[\s\S]*Probe cancellation requested/, "cancellation has a distinct user-visible result");
assert.match(terminal, /Cancel private runtime probe[\s\S]*onPress=\{cancelEmbeddedRuntimeProbe\}[\s\S]*probeCancelling/, "a dedicated Cancel control is shown while the probe runs");
assert.match(terminal, /screenMountedRef\.current = false;\s*probeAbortControllerRef\.current\?\.abort\(\)/, "leaving the screen requests cleanup for the probe only");
assert.match(terminal, /terminalUx\.send\(id, `\$\{input\}\\n`, prompt\)/, "regular terminal command dispatch remains unchanged");
assert.match(terminal, /if \(busy \|\| probeAbortControllerRef\.current\) \{/, "mode switch cannot hide pending probe cancellation");
assert.match(terminal, /const \[embeddedMode, setEmbeddedMode\] = useState\(true\)/, "both views use the embedded runtime");

console.log("AIB_EMBEDDED_TERMUX_CANCEL_SELFTEST_OK abort lifecycle, queue ordering both directions, queued candidate cancellation, and native active/pending tree cancellation verified");
