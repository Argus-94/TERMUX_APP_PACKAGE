#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const { choosePerformanceMode, PerformanceModeController } = await import("../core/enhancements/performance/PerformanceMode.ts");
const { BackendTuner } = await import("../core/enhancements/performance/BackendTuner.ts");
const { NativeAccelSlot } = await import("../core/enhancements/performance/NativeAccelSlot.ts");
const { RuntimeBackendRouter } = await import("../core/runtime/RuntimeBackendRouter.ts");
const expected = { Performance: "prefer-fastest-healthy", Balanced: "prefer-priority", Battery: "sticky", Compatibility: "prefer-priority" };
const expectedThreshold = { Performance: 2, Balanced: 3, Battery: 4, Compatibility: 1 };
for (const [mode, policy] of Object.entries(expected)) {
  assert.equal(choosePerformanceMode(mode).routerPolicy, policy);
  assert.equal(choosePerformanceMode(mode).failureThreshold, expectedThreshold[mode]);
}
assert.equal(choosePerformanceMode(undefined, { lowPowerMode: true }).mode, "Battery");
assert.equal(choosePerformanceMode(undefined, { availableMemoryBytes: 100 }).mode, "Compatibility");
assert.equal(choosePerformanceMode(undefined, { totalMemoryBytes: 2_000_000_000, architectureSupported: true }).mode, "Compatibility");
assert.equal(choosePerformanceMode(undefined, { totalMemoryBytes: 4_000_000_000, architectureSupported: true }).mode, "Battery");
assert.equal(choosePerformanceMode(undefined, { totalMemoryBytes: 12_000_000_000, architectureSupported: true, pluggedIn: true, batteryPercent: 80 }).mode, "Performance");
assert.equal(choosePerformanceMode(undefined, { architectureSupported: false, totalMemoryBytes: 16_000_000_000 }).mode, "Compatibility");

function backend(probe = async () => ({ id: "termux-native", health: "ready", latencyMs: 5, detail: "ok", capabilities: ["termux-native-execution"], checkedAt: Date.now() })) {
  return { id: "termux-native", priority: 1, capabilities: ["termux-native-execution"], probe, async exec() { return { exitCode: 0, stdout: "", stderr: "", durationMs: 1, backendId: "termux-native" }; } };
}
function measuredBackend(id, priority, latencyMs) {
  return { id, priority, capabilities: [], async probe() { return { id, health: "ready", latencyMs, detail: "ok", capabilities: [], checkedAt: Date.now() }; }, async exec() { return { exitCode: 0, stdout: "", stderr: "", durationMs: 1, backendId: id }; } };
}
for (const policy of Object.values(expected)) {
  const router = new RuntimeBackendRouter({ policy: "prefer-priority" });
  router.register(backend());
  const result = await new BackendTuner(router).apply(policy);
  assert.equal(result.applied, true);
  assert.equal(router.snapshot().policy, policy);
}
const measuredRouter = new RuntimeBackendRouter({ policy: "prefer-priority" });
measuredRouter.register(measuredBackend("proot-distro", 1, 80));
measuredRouter.register(measuredBackend("termux-native", 2, 10));
const measuredTune = await new BackendTuner(measuredRouter).apply("prefer-priority", { failureThreshold: 2, priorityStrategy: "fastest" });
assert.equal(measuredTune.applied, true);
assert.equal(measuredRouter.snapshot().failureThreshold, 2);
assert.deepEqual(measuredRouter.snapshot().priorityOrder, ["termux-native", "proot-distro"]);
assert.equal((await measuredRouter.probeAll()).at(-1)?.id, "termux-native", "measured mode priority must affect actual routing, not only report state");
const thresholdRouter = new RuntimeBackendRouter({ policy: "prefer-priority" });
thresholdRouter.register({ id: "proot-distro", priority: 1, capabilities: [], async probe() { return { id: "proot-distro", health: "ready", latencyMs: 5, detail: "ok", capabilities: [], checkedAt: Date.now() }; }, async exec() { return { exitCode: 1, stdout: "", stderr: "expected failure", durationMs: 1, backendId: "proot-distro" }; } });
thresholdRouter.register(measuredBackend("termux-native", 2, 10));
thresholdRouter.setFailureThreshold(1);
await thresholdRouter.probeAll();
assert.equal((await thresholdRouter.exec({ command: "true" })).backendId, "termux-native", "threshold=1 triggers immediate failover");
thresholdRouter.resetMetrics();
thresholdRouter.setFailureThreshold(4);
await thresholdRouter.probeAll();
assert.equal((await thresholdRouter.exec({ command: "true" })).backendId, "proot-distro", "threshold=4 retains the primary until four consecutive failures");
const emptyRouter = new RuntimeBackendRouter({ policy: "sticky" });
const missing = await new BackendTuner(emptyRouter).apply("prefer-fastest-healthy");
assert.equal(missing.applied, false);
assert.equal(missing.reason, "no-healthy-backend");
assert.equal(emptyRouter.snapshot().policy, "sticky");
const throwingRouter = new RuntimeBackendRouter({ policy: "sticky" });
throwingRouter.register(backend(async () => { throw new Error("probe failed"); }));
const throwing = await new BackendTuner(throwingRouter).apply("prefer-priority");
assert.equal(throwing.applied, false);
assert.equal(throwing.reason, "probe-failed");
assert.equal(throwingRouter.snapshot().policy, "sticky");

const saved = { value: JSON.stringify({ mode: "Battery" }) };
const modeRouter = new RuntimeBackendRouter({ policy: "prefer-priority" });
modeRouter.register(backend());
const modeEvents = [];
const modeController = new PerformanceModeController(new BackendTuner(modeRouter), { async read() { return saved.value; }, async write(value) { saved.value = value; } }, { record(event) { modeEvents.push(event); } });
assert.equal(await modeController.restore(), "Battery");
assert.equal(modeRouter.snapshot().policy, "sticky");
assert.equal(modeRouter.snapshot().failureThreshold, 4);
assert.deepEqual(modeRouter.snapshot().priorityOrder, ["termux-native"]);
assert.equal(JSON.parse(saved.value).mode, "Battery");
const noBackendController = new PerformanceModeController(new BackendTuner(emptyRouter));
assert.equal((await noBackendController.apply("Performance")).applied, false);
assert.equal(noBackendController.getMode(), "Balanced", "failed backend application preserves the existing mode");
assert.equal(modeEvents.length, 1);

const persistenceRouter = new RuntimeBackendRouter({ policy: "prefer-priority" });
persistenceRouter.register(backend());
const persistenceFailureController = new PerformanceModeController(new BackendTuner(persistenceRouter), {
  async read() { return null; },
  async write() { throw new Error("simulated storage outage"); },
});
const persistenceFailure = await persistenceFailureController.apply("Battery");
assert.equal(persistenceFailure.applied, false, "a mode is not reported applied when it cannot be persisted");
assert.equal(persistenceFailure.persisted, false);
assert.equal(persistenceFailure.rollbackApplied, true);
assert.equal(persistenceFailureController.getMode(), "Balanced");
assert.equal(persistenceRouter.snapshot().policy, "prefer-priority", "persistence failure rolls the runtime policy back");
assert.equal(persistenceRouter.snapshot().failureThreshold, 3);
assert.deepEqual(persistenceRouter.snapshot().priorityOrder, []);

const policyPersistenceRouter = new RuntimeBackendRouter({ policy: "prefer-priority" });
policyPersistenceRouter.register(backend());
const policyPersistenceFailure = await new BackendTuner(policyPersistenceRouter, { async read() { return null; }, async write() { throw new Error("storage unavailable"); } })
  .apply("sticky", { failureThreshold: 4, priorityStrategy: "active-first" });
assert.equal(policyPersistenceFailure.applied, false);
assert.equal(policyPersistenceFailure.reason, "persistence-failed");
assert.equal(policyPersistenceRouter.snapshot().policy, "prefer-priority");
assert.equal(policyPersistenceRouter.snapshot().failureThreshold, 3);
assert.deepEqual(policyPersistenceRouter.snapshot().priorityOrder, []);

const runtimeSource = await readFile(new URL("../core/RuntimeFacade.ts", import.meta.url), "utf8");
const memorySource = await readFile(new URL("../plugins/android/AibMemoryPressureModule.kt", import.meta.url), "utf8");
assert.match(runtimeSource, /recommendPerformanceModeFromDevice[\s\S]*?getDevicePowerState/);
assert.match(runtimeSource, /batteryPercent[\s\S]*?pluggedIn[\s\S]*?lowPowerMode/);
assert.match(memorySource, /fun getDevicePowerState\(promise: Promise\)/);

assert.equal((await new NativeAccelSlot({ async discover() { return { linked: false, available: false }; } }).inspect()).status, "unsupported");
assert.equal((await new NativeAccelSlot({ async discover() { return { linked: false, available: true, detail: "host claimed availability" }; } }).inspect()).status, "unsupported");
assert.equal((await new NativeAccelSlot({ async discover() { return { linked: true, available: false }; } }).inspect()).status, "linked");
assert.equal((await new NativeAccelSlot({ async discover() { return { linked: true, available: true }; } }).inspect()).status, "available");
assert.equal((await new NativeAccelSlot({ async discover() { throw new Error("no host"); } }).inspect()).status, "unsupported");
console.log("AIB_PERFORMANCE_MODE_SELFTEST_OK profiles=4 restore=durable apply=rollback persistence=rollback accel=link-gated,linked,available,unsupported,throwing auto=native-power-memory");
