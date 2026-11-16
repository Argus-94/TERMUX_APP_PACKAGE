#!/usr/bin/env node
import assert from "node:assert/strict";
const { BootstrapPipeline } = await import("../core/runtime/BootstrapPipeline.ts");
const { FirstRunOrchestrator } = await import("../core/enhancements/onboarding/FirstRunOrchestrator.ts");
const { recommendSmartDefaults } = await import("../core/enhancements/onboarding/SmartDefaults.ts");
const okDiagnostics = async () => ({ overall: "ready", generatedAt: 1, entries: [], humanReadable: "ready", json: "{}" });
const recommendation = recommendSmartDefaults({ backends: [{ id: "termux-native", healthy: true, capabilities: ["termux-native-execution"] }], online: true });
assert.equal(recommendation.backend, "termux-native");
assert.equal(recommendation.security, "strict");

function fixture({ failOnce = false, diagnostics = okDiagnostics } = {}) {
  const state = { marker: null, pipeline: null, recoveredMarker: null };
  const counts = new Map();
  let shouldFail = failOnce;
  const markerStore = { async read() { return state.marker; }, async write(value) { state.marker = value; }, async quarantine(value) { state.recoveredMarker = value; } };
  const pipelineStore = { async read() { return state.pipeline; }, async write(value) { state.pipeline = value; } };
  const pipeline = new BootstrapPipeline(pipelineStore, async (id) => {
    counts.set(id, (counts.get(id) ?? 0) + 1);
    if (id === "proot-distro" && shouldFail) { shouldFail = false; return { ok: false, message: "mock failure" }; }
    return { ok: true, fingerprint: `fp:${id}` };
  });
  let diagnosticRuns = 0;
  let defaultsRuns = 0;
  const orchestrator = new FirstRunOrchestrator(markerStore, pipeline, {
    async diagnostics() { diagnosticRuns++; return diagnostics(); },
    async safeDefaults() { defaultsRuns++; return recommendation; },
  });
  return { orchestrator, counts, get marker() { return state.marker; }, set marker(value) { state.marker = value; }, get recoveredMarker() { return state.recoveredMarker; }, get diagnosticRuns() { return diagnosticRuns; }, get defaultsRuns() { return defaultsRuns; } };
}

const success = fixture();
assert.deepEqual(await success.orchestrator.inspect("3.0.0"), { required: true, kind: "first-run" }, "startup inspection reports a first run without executing stages");
assert.equal(success.counts.size, 0, "inspection does not run bootstrap");
const progress = [];
const first = await success.orchestrator.run({ targetVersion: "3.0.0", onProgress: (event) => progress.push(event) });
assert.equal(first.error, undefined);
assert.equal(first.state.kind, "first-run");
assert.deepEqual(first.state.stages, { diagnostics: "ok", bootstrap: "ok", "safe-defaults": "ok" });
assert.equal(success.counts.size, 6);
assert.ok(progress.some((event) => event.stage === "bootstrap"));
const settled = await success.orchestrator.run({ targetVersion: "3.0.0" });
assert.equal(settled.error, undefined);
assert.equal(success.counts.size, 6, "completed stages must not run again");
assert.equal((await success.orchestrator.inspect("3.0.0")).required, false, "completed same-major setup no longer prompts at startup");
const secondLaunch = fixture();
secondLaunch.marker = success.marker;
assert.equal((await secondLaunch.orchestrator.inspect("3.0.0")).required, false, "a fresh orchestrator instance reads the completed marker on the next launch");
assert.equal((await success.orchestrator.inspect("4.0.0")).kind, "major-update");

const concurrent = fixture();
const [concurrentA, concurrentB] = await Promise.all([
  concurrent.orchestrator.run({ targetVersion: "3.0.0" }),
  concurrent.orchestrator.run({ targetVersion: "3.0.0" }),
]);
assert.equal(concurrentA.error, undefined);
assert.deepEqual(concurrentA.state, concurrentB.state);
assert.equal(concurrent.counts.size, 6, "simultaneous first-run triggers share exactly one bootstrap pass");
assert.equal(concurrent.diagnosticRuns, 1);
assert.equal(concurrent.defaultsRuns, 1);

const retry = fixture({ failOnce: true });
const failed = await retry.orchestrator.run({ targetVersion: "1.0.0" });
assert.equal(failed.error?.code, "BOOTSTRAP_FAILED");
assert.equal(failed.state.stages.diagnostics, "ok");
assert.equal(failed.state.stages.bootstrap, "error");
assert.equal((await retry.orchestrator.inspect("1.0.0")).kind, "resume");
const retried = await retry.orchestrator.run({ targetVersion: "1.0.0" });
assert.equal(retried.error, undefined);
assert.equal(retry.counts.get("termux-ready"), 1, "successful stage skipped on retry");
assert.equal(retry.counts.get("proot-distro"), 2, "only failed bootstrap stage retried");
assert.equal(retry.diagnosticRuns, 1, "completed diagnostics not repeated on retry");
assert.equal(retry.defaultsRuns, 1, "defaults only applied after bootstrap succeeds");

const blocked = fixture({ diagnostics: async () => ({ overall: "blocked", generatedAt: 1, entries: [], humanReadable: "denied", json: "{}" }) });
const blockedResult = await blocked.orchestrator.run({ targetVersion: "1.0.0" });
assert.equal(blockedResult.error?.code, "DIAGNOSTICS_FAILED");
assert.equal(blocked.counts.size, 0, "blocked diagnostics must not start bootstrap");
assert.equal(blocked.defaultsRuns, 0);

const corrupt = fixture();
corrupt.marker = "{not-json";
assert.equal((await corrupt.orchestrator.inspect("1.0.0")).kind, "repair", "malformed durable marker offers repair instead of becoming stuck");
assert.equal((await corrupt.orchestrator.inspect("1.0.0")).error?.code, "STATE_CORRUPT");
const recovered = await corrupt.orchestrator.run({ targetVersion: "1.0.0" });
assert.equal(recovered.error, undefined);
assert.match(recovered.warning || "", /preserved in recovery storage/i);
assert.equal(corrupt.recoveredMarker, "{not-json", "safe recovery preserves malformed source bytes before replacement");
assert.equal(JSON.parse(corrupt.marker).version, 1, "repair replaces malformed marker with valid resumable state");

const readFailure = new FirstRunOrchestrator(
  { async read() { throw new Error("private path contents must not escape"); }, async write() {} },
  new BootstrapPipeline({ async read() { return null; }, async write() {} }, async () => ({ ok: true })),
  { async diagnostics() { return okDiagnostics(); }, async safeDefaults() { return recommendation; } },
);
const unavailable = await readFailure.inspect("1.0.0");
assert.equal(unavailable.required, true, "storage read failure offers a diagnostics/repair screen but starts no work");
assert.equal(unavailable.kind, "repair");
assert.equal(unavailable.error?.code, "STORE_FAILED");
assert.doesNotMatch(unavailable.error?.message || "", /private path contents/);

const update = fixture();
await update.orchestrator.run({ targetVersion: "4.0.0" });
const updateResult = await update.orchestrator.run({ targetVersion: "5.0.0" });
assert.equal(updateResult.state.kind, "major-update");
const minorUpdate = fixture();
await minorUpdate.orchestrator.run({ targetVersion: "2.0.0" });
const minorResult = await minorUpdate.orchestrator.run({ targetVersion: "2.1.0" });
assert.equal(minorResult.state.kind, "resume", "minor releases do not trigger major-update orchestration");
console.log("AIB_FIRST_RUN_ORCHESTRATOR_SELFTEST_OK success=inspect=corrupt-repair=retry-only-failed=blocked=major-update=read-failure");
