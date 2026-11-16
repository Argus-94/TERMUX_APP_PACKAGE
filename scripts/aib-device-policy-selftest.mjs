#!/usr/bin/env node
import assert from "node:assert/strict";
import { DevicePolicy, requiredDeviceCapability } from "../core/enhancements/device/DevicePolicy.ts";

const events = [];
const policy = new DevicePolicy({ timeline: (event) => events.push(event) });
await assert.rejects(policy.run("adb.list", () => 1), /POLICY_BLOCKED/);
policy.grantByUser("device.adb");
assert.equal(await policy.run("adb.list", () => 7), 7);
policy.revokeByUser("device.adb");
await assert.rejects(policy.run("adb.list", () => 1), /POLICY_BLOCKED/);
assert.deepEqual(events.map((event) => event.outcome), ["blocked", "started", "authorized", "blocked"]);
await assert.rejects(policy.run("adb.shell", () => 1), /POLICY_BLOCKED/);
assert.equal(requiredDeviceCapability("bridge.files.read"), "device.metadata.read");
assert.equal(requiredDeviceCapability("bridge.sensors.read"), "device.sensors.read");
await assert.rejects(policy.run("bridge.sensors.read", () => "battery"), /device\.sensors\.read/);
policy.grantByUser("device.metadata.read");
assert.equal(await policy.run("bridge.files.read", () => "test-device"), "test-device");
await assert.rejects(policy.run("bridge.sensors.read", () => "battery"), /device\.sensors\.read/);

let actionRan = false;
const failingAudit = new DevicePolicy({ timeline: async (event) => { if (event.outcome === "started") throw new Error("timeline unavailable"); } });
failingAudit.grantByUser("device.accessibility");
await assert.rejects(
  failingAudit.run("accessibility.tap", () => { actionRan = true; return true; }),
  (error) => error?.code === "AUDIT_UNAVAILABLE",
);
assert.equal(actionRan, false, "device action must not run unless its pre-action audit record is durable");

const missingAudit = new DevicePolicy();
missingAudit.grantByUser("device.adb");
await assert.rejects(missingAudit.run("adb.list", () => { actionRan = true; }), (error) => error?.code === "AUDIT_UNAVAILABLE");
assert.equal(actionRan, false, "absence of an audit sink fails closed");
console.log("AIB_DEVICE_POLICY_SELFTEST_OK grant=checked revoke=checked audit_preflight=required failures=fail_closed");
