#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadTs, setTsModuleMocks } from "./test-helpers/load-ts-module.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
setTsModuleMocks("lib/agent-shell-backend.ts", {
  "./termux-bootstrap-install": {
    buildProotDistroRootfsCheckCommand: (alias) => `printf 'CHECK_${alias}'`,
  },
  "./writable-path-policy": {
    AI_BUILDER_SHARED_ROOT: "/storage/emulated/0/AIBuilderTermux",
    isWithinSharedAppRoot: (value) => String(value).startsWith("/storage/emulated/0/AIBuilderTermux"),
  },
});

const {
  isAndroidSharedStorageOnlyCommand,
  resolveAgentExecutionBackend,
  shouldFallbackSharedStorageToHost,
  wrapCommandForAgentShell,
  agentShellBackendPromptHint,
  setBuildBackend,
  shellRunMarker,
  shellDoneMarker,
} = loadTs("lib/agent-shell-backend.ts");
const { buildAgentEnvState, formatEnvStateBlock } = loadTs("lib/agent-env-state.ts");

setBuildBackend("termux");
const termuxState = buildAgentEnvState();
assert.equal(termuxState.pkgManager, "pkg");
assert.deepEqual(termuxState.shellMarkers, { run: "TERMUX_RUN", done: "TERMUX_DONE" });
assert.doesNotMatch(formatEnvStateBlock(termuxState), /Debian|apt-get/);
assert.match(agentShellBackendPromptHint(), /ACTIVE ENVIRONMENT = Termux/);
assert.match(agentShellBackendPromptHint(), /Package manager = pkg \(NOT apt\)/);
assert.equal(shellRunMarker(), "TERMUX_RUN:");
assert.equal(shellDoneMarker(), "TERMUX_DONE:");

setBuildBackend("ubuntu-proot");
const ubuntuState = buildAgentEnvState();
assert.equal(ubuntuState.pkgManager, "apt");
assert.deepEqual(ubuntuState.shellMarkers, { run: "UBUNTU_RUN", done: "UBUNTU_DONE" });
assert.doesNotMatch(formatEnvStateBlock(ubuntuState), /Debian|pkg on Ubuntu/);
assert.match(agentShellBackendPromptHint(), /ACTIVE ENVIRONMENT = Ubuntu/);
assert.match(agentShellBackendPromptHint(), /Package manager = apt\/apt-get only/);
assert.match(agentShellBackendPromptHint(), /Packages and builds stay in Ubuntu/);
assert.equal(shellRunMarker(), "UBUNTU_RUN:");
assert.equal(shellDoneMarker(), "UBUNTU_DONE:");

const sharedCommand = "mkdir -p /sdcard/Download && echo ok > /sdcard/Download/t.txt";
assert.equal(isAndroidSharedStorageOnlyCommand(sharedCommand), true);
assert.equal(resolveAgentExecutionBackend(sharedCommand, "ubuntu-proot"), "ubuntu-proot");
assert.equal(resolveAgentExecutionBackend(sharedCommand, "termux"), "termux");
assert.equal(resolveAgentExecutionBackend("bash gradlew assembleDebug --no-daemon", "ubuntu-proot"), "ubuntu-proot");
assert.equal(resolveAgentExecutionBackend("apt-get install -y openjdk-17-jdk", "ubuntu-proot"), "ubuntu-proot");
assert.equal(resolveAgentExecutionBackend("bash gradlew assembleDebug --no-daemon", "termux"), "termux");

const wrapped = wrapCommandForAgentShell(sharedCommand, null, "ubuntu-proot");
assert.match(wrapped, /proot-distro login ubuntu/);
assert.match(wrapped, /--bind \/storage\/emulated\/0:\/storage\/emulated\/0/);
assert.match(wrapped, /AIB_PROOT_DISTRO_MISSING/);
assert.equal(wrapCommandForAgentShell(sharedCommand, null, "termux"), sharedCommand);

assert.equal(shouldFallbackSharedStorageToHost(sharedCommand, "ubuntu-proot", 127, "AIB_PROOT_DISTRO_MISSING: install host package"), true);
assert.equal(shouldFallbackSharedStorageToHost(sharedCommand, "ubuntu-proot", 1, "AIB_UBUNTU_ROOTFS_STATE_UNVERIFIED"), true);
assert.equal(shouldFallbackSharedStorageToHost(sharedCommand, "ubuntu-proot", 1, "Permission denied"), false);
assert.equal(shouldFallbackSharedStorageToHost(sharedCommand, "ubuntu-proot", 0, "AIB_UBUNTU_ROOTFS_MISSING"), false);
assert.equal(shouldFallbackSharedStorageToHost(sharedCommand, "termux", 127, "AIB_PROOT_DISTRO_MISSING"), false);
assert.equal(shouldFallbackSharedStorageToHost("apt-get install -y git > /sdcard/Download/log", "ubuntu-proot", 127, "AIB_PROOT_DISTRO_MISSING"), false);

const agent = fs.readFileSync(path.join(root, "lib/termux-agent.ts"), "utf8");
assert.match(agent, /shouldFallbackSharedStorageToHost\(effectiveCmd, executionBackend/);
assert.match(agent, /hostTermux:\s*true/);
assert.match(agent, /AIB_SHARED_STORAGE_HOST_FALLBACK/);
assert.match(agent, /shellRunMarker\(\)/);
assert.match(agent, /shellDoneMarker\(\)/);
console.log("AIB_AGENT_SHELL_BACKEND_ROUTING_SELFTEST_OK termux=pkg/TERMUX markers ubuntu=apt/UBUNTU markers guest-first host-fallback=rootfs-only");
