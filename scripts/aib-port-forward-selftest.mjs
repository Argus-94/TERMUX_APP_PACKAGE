#!/usr/bin/env node
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRuntimeTs } from "./test-helpers/load-runtime-ts.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const { PortForwardPolicy } = loadRuntimeTs(path.join(root, "core/enhancements/networking/PortForwardPolicy.ts"));
const { PortForwardStore } = loadRuntimeTs(path.join(root, "core/enhancements/networking/PortForwardStore.ts"));
const { PortForwardManager } = loadRuntimeTs(path.join(root, "core/enhancements/networking/PortForwardManager.ts"));
const { SocatPortForwardTransport } = loadRuntimeTs(path.join(root, "core/enhancements/networking/SocatPortForwardTransport.ts"));
const base = { protocol: "tcp", hostPort: 8080, targetHost: "127.0.0.1", targetPort: 3000 };
const policy = new PortForwardPolicy();
assert.equal((await policy.check(base, false, "user")).reason, "CAPABILITY_REQUIRED");
assert.equal((await policy.check({ ...base, targetHost: "0.0.0.0" }, true, "user")).allowed, false);
assert.equal((await policy.check({ ...base, hostPort: 80 }, true, "user")).reason, "PRIVILEGED_PORT_DENIED");
assert.equal((await policy.check({ ...base, hostPort: 4444 }, true, "user")).reason, "PORT_NOT_ALLOWLISTED");
assert.equal((await policy.check({ ...base, targetPort: 8080 }, true, "user")).reason, "PORT_FORWARD_PORTS_IDENTICAL");
assert.equal((await policy.check(base, true, "user")).allowed, true);

let raw = null; let id = 0; let failStop = false;
const storage = { async read() { return raw; }, async write(value) { raw = value; } };
const events = [];
const processIds = new Set();
const transport = {
  async isAvailable() { return true; },
  async start(rule) { processIds.add(rule.id); return { processId: String(processIds.size + 100), verified: true }; },
  async stop(ruleId) { if (failStop) throw new Error("STOP_FAILED_INJECTED"); processIds.delete(ruleId); },
};
const makeStore = () => new PortForwardStore(storage, policy, () => 100, () => `pf-${++id}`);
const store = makeStore();
const manager = new PortForwardManager(store, policy, transport, (event) => { events.push(event); });
await assert.rejects(() => manager.add({ name: "dev-server", ...base, source: "user" }), /CAPABILITY_REQUIRED/);
const running = await manager.add({ name: "dev-server", ...base, source: "user" }, true);
assert.equal(running.state, "listening");
assert.equal(manager.activeCount, 1);
await assert.rejects(() => manager.add({ name: "duplicate", ...base, source: "user" }, true), /CONFLICT/);
await assert.rejects(() => manager.remove(running.rule.id), /CAPABILITY_REQUIRED/);
assert.equal((await store.list()).length, 1, "failed unauthorized remove retains durable rule");
failStop = true;
await assert.rejects(() => manager.remove(running.rule.id, true, "user"), /STOP_FAILED/);
assert.equal((await store.getById(running.rule.id))?.id, running.rule.id, "failed stop keeps rule for retry");
failStop = false;
assert.equal(await manager.remove(running.rule.id, true, "user"), true);
assert.equal(manager.activeCount, 0);
assert.equal((await store.list()).length, 0);

const persisted = await manager.add({ name: "web", ...base, source: "user" }, true);
await manager.stopActive("sleep");
assert.equal(manager.activeCount, 0);
assert.equal((await store.list()).length, 1, "sleep stops process but retains rule");
const restored = await manager.applyAll();
assert.equal(restored[0]?.state, "listening");
assert.equal(manager.activeCount, 1);
assert.ok(events.some((event) => event.operation === "stop" && event.source === "lifecycle"));
assert.ok(events.some((event) => event.outcome === "denied"));
await manager.clear(true, "user");
assert.equal(manager.activeCount, 0);
const reload = new PortForwardStore(storage, policy);
assert.equal((await reload.list()).length, 0);
assert.equal(manager.localUrl(3000), "http://127.0.0.1:3000");
assert.equal(manager.localUrl(4444), null);
const commands = [];
const mockEnvironment = { async exec(command) {
  commands.push(command);
  if (command === "command -v socat") return { exitCode: 0, stdout: "/usr/bin/socat\n", stderr: "" };
  if (command.includes("nohup socat -d -d")) return { exitCode: 0, stdout: "PID=345\nlistening on AF=2 127.0.0.1:8080\n", stderr: "" };
  return { exitCode: 0, stdout: "", stderr: "" };
} };
const socat = new SocatPortForwardTransport(mockEnvironment, "/tmp/aib-test-home");
const mockRule = { ...base, id: "test-forward", source: "user", name: "test", createdAt: 1 };
assert.equal((await socat.start(mockRule)).processId, "345");
await socat.stop(mockRule.id);
const badCommands = [];
const wrongBindEnvironment = { async exec(command) {
  badCommands.push(command);
  if (command === "command -v socat") return { exitCode: 0, stdout: "/usr/bin/socat\n", stderr: "" };
  if (command.includes("nohup socat -d -d")) return { exitCode: 0, stdout: "PID=346\nlistening on AF=2 0.0.0.0:8080\n", stderr: "" };
  return { exitCode: 0, stdout: "", stderr: "" };
} };
const wrongBindTransport = new SocatPortForwardTransport(wrongBindEnvironment, "/tmp/aib-test-home");
await assert.rejects(() => wrongBindTransport.start(mockRule), /PORT_FORWARD_LISTENER_UNVERIFIED/);
assert.ok(badCommands.some((command) => command.includes("rm -f --")), "an unverified listener is cleaned up without being reported active");
const startCommand = commands.find((command) => command.includes("nohup socat -d -d"));
const stopCommand = commands.at(-1);
assert.ok(startCommand?.includes("TCP4-LISTEN:8080,bind=127.0.0.1"));
assert.ok(startCommand?.includes("TCP4:127.0.0.1:3000"));
assert.ok(!startCommand?.includes("0.0.0.0"));
assert.ok(stopCommand?.includes("/proc/$pid/cmdline"));
assert.ok(stopCommand?.includes("bind=127.0.0.1"));
assert.ok(!commands.some((command) => command.includes("pkg install")));
console.log("AIB_PORT_FORWARD_SELFTEST_OK");
