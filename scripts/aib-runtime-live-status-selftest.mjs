#!/usr/bin/env node
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRuntimeTs } from "./test-helpers/load-runtime-ts.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const { StatusCollector } = loadRuntimeTs(path.join(root, "core/enhancements/runtime-status/StatusCollector.ts"));
const { RuntimeLiveStatus } = loadRuntimeTs(path.join(root, "core/enhancements/runtime-status/RuntimeLiveStatus.ts"));
let calls = 0; let backendState = "up";
const collector = new StatusCollector({
  backends: () => { calls += 1; return [{ id: "termux", status: backendState, latencyMs: 4 }]; },
  containers: () => [{ id: "deb", name: "Debian", state: "sleeping" }],
  processes: () => ({ total: 3, supervised: 1, quarantined: 0 }),
  resources: () => ({}),
  portForwards: () => 1,
});
const first = await collector.collect();
assert.equal(first.backends[0]?.status, "up");
assert.equal(first.containers[0]?.state, "sleeping");
assert.equal(first.resources.memUsedMb, undefined, "unavailable metrics are not fabricated");
const failingCollector = new StatusCollector({ backends() { throw Error("backend unavailable"); }, containers() { throw Error("container unavailable"); }, processes() { throw Error("process unavailable"); }, resources() { throw Error("resource unavailable"); }, portForwards() { throw Error("forward unavailable"); }, interceptorActive() { throw Error("interceptor unavailable"); } });
const failedSnapshot = await failingCollector.collect();
assert.deepEqual([...failedSnapshot.unavailable].sort(), ["backends", "containers", "interceptor", "portForwards", "processes", "resources"].sort());
assert.equal(failedSnapshot.portForwards, 0, "fallback remains bounded but is visibly marked unavailable");
const important = [];
let maintenanceTicks = 0;
const live = new RuntimeLiveStatus(collector, (event) => important.push(event), 1000, () => { maintenanceTicks += 1; }, 1000);
const snapshots = [];
const unsubscribe = live.subscribe((snapshot) => snapshots.push(snapshot));
await new Promise((resolve) => setTimeout(resolve, 30));
assert.ok(snapshots.length >= 1);
assert.ok(live.getSnapshot());
assert.equal(maintenanceTicks, 1, "foreground subscriber starts one bounded maintenance pass");
live.setAppState("background");
const pausedCalls = calls;
const pausedMaintenanceTicks = maintenanceTicks;
await new Promise((resolve) => setTimeout(resolve, 30));
assert.equal(calls, pausedCalls, "no polling in background");
assert.equal(maintenanceTicks, pausedMaintenanceTicks, "maintenance does not run in background");
await new Promise((resolve) => setTimeout(resolve, 1010));
backendState = "down";
live.setAppState("active");
await new Promise((resolve) => setTimeout(resolve, 30));
assert.ok(calls > pausedCalls, "foreground resumes with a fresh sample");
assert.equal(maintenanceTicks, 2, "throttled maintenance resumes after foreground reactivation");
assert.ok(important.length >= 2, "initial and changed status are audited");
unsubscribe();
const stoppedCalls = calls;
await new Promise((resolve) => setTimeout(resolve, 30));
assert.equal(calls, stoppedCalls, "last unsubscribe stops polling");
assert.throws(() => new RuntimeLiveStatus(collector, undefined, 500), /INTERVAL_TOO_FAST/);
assert.throws(() => new RuntimeLiveStatus(collector, undefined, 1000, undefined, 500), /MAINTENANCE_INTERVAL_INVALID/);
console.log("AIB_RUNTIME_LIVE_STATUS_SELFTEST_OK");
