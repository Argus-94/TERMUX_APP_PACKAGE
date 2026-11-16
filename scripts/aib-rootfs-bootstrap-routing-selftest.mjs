#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aib-rootfs-routing-"));

// Node's type stripper requires explicit .ts specifiers. Stage exact production
// modules in a disposable mirror and rewrite only those specifiers for Node.
for (const file of [
  "lib/bootstrap-stage-core.ts",
  "lib/runtime-command-routing.ts",
  "lib/proot-distro-state.ts",
  "lib/termux-bootstrap-install.ts",
  "lib/termux-apt-install.ts",
  "lib/writable-path-policy.ts",
  "lib/package-command-routing.ts",
  "lib/agent-shell-backend.ts",
  "lib/agent-autonomy-policy.ts",
  "lib/apk-build-safety-policy.ts",
  "core/enhancements/auth/types.ts",
  "core/enhancements/auth/AgentAuthProxyAccess.ts",
  "core/enhancements/auth/AgentAuthStore.ts",
  "core/enhancements/auth/CredentialProxy.ts",
  "core/enhancements/isolation/HardenedProotOptions.ts",
  "core/container/ContainerShell.ts",
  "core/container/ProotCommandBuilder.ts",
  "core/runtime/RuntimeBackend.ts",
  "core/runtime/backends/ProotDistroBackend.ts",
  "lib/proot-distro-state.ts",
]) {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  const staged = source.replace(/(from\s+["'])(\.{1,2}\/[^"']+?)(["'])/g, (_m, before, specifier, after) =>
    `${before}${specifier.endsWith(".ts") ? specifier : `${specifier}.ts`}${after}`,
  );
  const destination = path.join(temp, file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, staged);
}

try {
  const core = await import(pathToFileURL(path.join(temp, "lib/bootstrap-stage-core.ts")));
  const routing = await import(pathToFileURL(path.join(temp, "lib/runtime-command-routing.ts")));
  const { wrapCommandForAgentShell } = await import(pathToFileURL(path.join(temp, "lib/agent-shell-backend.ts")));
  const { createBootstrapPipeline } = await import(pathToFileURL(path.join(root, "core/runtime/BootstrapPipeline.ts")));
  const { ProotDistroBackend } = await import(pathToFileURL(path.join(temp, "core/runtime/backends/ProotDistroBackend.ts")));

  let selectedBackend = "ubuntu-proot";
  const installed = { debian: false, ubuntu: false };
  const executed = [];
  const stored = { value: null };
  const store = {
    async read() { return stored.value; },
    async write(value) { stored.value = value; },
  };

  const runner = core.createBootstrapStageRunner({
    getBackend: () => selectedBackend,
    async execute(command, backend, timeoutMs) {
      executed.push({ command, backend, timeoutMs });
      assert.ok(["termux", "ubuntu-proot", "ubuntu-proot"].includes(backend));

      if (command === "echo AIB_BOOTSTRAP_OK") return { exitCode: 0, stdout: "AIB_BOOTSTRAP_OK" };
      if (command.includes("tools_ok=$ok")) return { exitCode: 0, stdout: "tools_ok=1\njava=17" };
      if (command.includes("command -v proot-distro") && command.includes("EXIT:$?")) {
        return { exitCode: 0, stdout: "EXIT:0" };
      }
      if (command.includes("echo WS_OK")) return { exitCode: 0, stdout: "WS_OK" };
      if (command.includes("echo AIB_VERIFY_OK")) return { exitCode: 0, stdout: "AIB_VERIFY_OK" };

      const installDistro = command.match(/proot-distro install (ubuntu|debian)/)?.[1];
      if (installDistro) {
        assert.equal(backend, "termux", "proot-distro install must be dispatched to Termux host");
        installed[installDistro] = true;
        return { exitCode: 0, stdout: `INSTALL_EXIT:0\n${installDistro.toUpperCase()}_INSTALL_OK` };
      }

      const checkDistro = ["ubuntu", "debian"].find((distro) =>
        command.includes(`AIB_PROBE_ID:${distro}`) && command.includes(`${distro.toUpperCase()}_ROOTFS_OK`),
      );
      if (checkDistro) {
        const marker = installed[checkDistro]
          ? `AIB_${checkDistro.toUpperCase()}_ROOTFS_OK\n${checkDistro.toUpperCase()}_ROOTFS_OK`
          : `AIB_${checkDistro.toUpperCase()}_ROOTFS_MISSING\n${checkDistro.toUpperCase()}_ROOTFS_MISSING`;
        return { exitCode: installed[checkDistro] ? 0 : 1, stdout: marker };
      }

      throw new Error(`Unexpected production bootstrap command: ${command.slice(0, 180)}`);
    },
  });

  const pipeline = createBootstrapPipeline(
    store,
    runner,
    (stageId) => stageId === "environment-image" ? routing.bootstrapImageFingerprint(selectedBackend) : undefined,
  );

  const first = await pipeline.run();
  assert.equal(first.lastError, undefined, `Ubuntu pipeline failed: ${first.lastError}`);
  assert.equal(installed.ubuntu, true, "selected Ubuntu backend must install the Ubuntu image");
  assert.equal(installed.debian, false, "removed Debian backend must not be bootstrapped");
  assert.equal(first.stages.find((stage) => stage.id === "environment-image")?.fingerprint, "image:ubuntu");

  const ubuntuInstall = executed.find((entry) => entry.command.includes("proot-distro install ubuntu"));
  assert.ok(ubuntuInstall, "missing Ubuntu proot-distro install command");
  assert.equal(ubuntuInstall.backend, "termux");
  assert.ok(ubuntuInstall.command.includes("Installed distributions"));
  assert.ok(ubuntuInstall.command.includes("ROOTFS_INSTALLED_LOGIN_FAILED:ubuntu"));
  assert.doesNotMatch(ubuntuInstall.command, /proot-distro\s+(?:reset|remove)/i);
  assert.ok(!ubuntuInstall.command.includes("proot-distro install debian"));

  selectedBackend = "termux";
  const beforeTermuxSwitch = executed.length;
  const second = await pipeline.run();
  assert.equal(second.lastError, undefined, `Termux pipeline failed: ${second.lastError}`);
  assert.equal(second.stages.find((stage) => stage.id === "environment-image")?.fingerprint, "image:none:termux");
  assert.equal(second.stages.find((stage) => stage.id === "environment-image")?.status, "skipped");
  const termuxCommands = executed.slice(beforeTermuxSwitch);
  assert.ok(!termuxCommands.some((entry) => /proot-distro install (?:ubuntu|debian)/.test(entry.command)), "Termux backend must not install a Linux guest image");

  for (const [backend, distro] of [["ubuntu-proot", "ubuntu"]]) {
    assert.equal(routing.rootfsDistroForBackend(backend), distro);
    assert.equal(routing.routeRuntimeCommand(backend, "proot-distro"), "termux");
    assert.equal(routing.routeRuntimeCommand(backend, "package", `${distro}-rootfs`), "termux");
    assert.equal(routing.routeRuntimeCommand(backend, "package", "build-essential"), backend);
    const guestCommand = wrapCommandForAgentShell("apt-get install -y build-essential", undefined, backend);
    assert.ok(guestCommand.includes(`proot-distro login ${distro}`), `${distro} package command reached wrong guest`);
    assert.ok(guestCommand.includes("apt-get install -y build-essential"));
    assert.ok(guestCommand.includes(`AIB_PROBE_ID:${distro}`), "guest guard must verify the real guest OS ID");
    assert.ok(guestCommand.includes("proot-distro list"), "guest rootfs guard must use authoritative installed-distro metadata");
    assert.doesNotMatch(guestCommand, /installed-rootfs\/(?:debian|ubuntu)/, "guest guard must not require an AI Builder-owned directory");
  }
  assert.equal(routing.rootfsDistroForBackend("termux"), null);
  assert.equal(routing.bootstrapImageFingerprint("termux"), "image:none:termux");

  const profileCommands = [];
  const prootBackend = new ProotDistroBackend(async (command) => {
    profileCommands.push(command);
    const profile = command.match(/proot-distro login (ubuntu|debian)/)?.[1] ?? "debian";
    return {
      exitCode: 0,
      stdout: [
        "AIB_PROBE_BEGIN",
        "AIB_PROOT_TOOL:AVAILABLE",
        "AIB_HOST_UNAME:aarch64",
        "AIB_LIST_EXIT:0",
        "AIB_LIST_BEGIN",
        "Installed distributions:",
        profile,
        "AIB_LIST_END",
        "AIB_LOGIN_EXIT:0",
        "AIB_LOGIN_BEGIN",
        `AIB_PROBE_ID:${profile}`,
        "AIB_PROBE_UID:1000",
        "AIB_PROBE_UNAME:aarch64",
        "AIB_LOGIN_END",
        "AIB_PROBE_END",
      ].join("\n"),
    };
  }, "debian");
  for (const [profile, other] of [["ubuntu", "debian"], ["debian", "ubuntu"]]) {
    prootBackend.setProfile(profile);
    profileCommands.length = 0;
    const probe = await prootBackend.probe();
    assert.equal(probe.health, "ready");
    const login = profileCommands.find((command) => command.includes("proot-distro login"));
    assert.ok(login?.includes(`proot-distro login ${profile}`));
    assert.ok(!login?.includes(`proot-distro login ${other}`));
    assert.ok(login?.includes("-- sh -c 'grep -m1"), "health probe must read guest identity without an untrusted shell assignment");
    assert.ok(login?.includes("AIB_PROBE_ID:"), "health probe must emit a parseable real guest identity marker");
    assert.doesNotMatch(login || "", /sh -lc/, "probe must not source shell login profiles");
  }

  assert.ok(executed.every((entry) => entry.backend === "termux"), "bootstrap host stage escaped to a Linux guest");
  console.log("AIB_ROOTFS_BOOTSTRAP_ROUTING_SELFTEST_OK selected_image=ubuntu termux_skips_guest=1 host_proot=termux guest_packages=selected_backend userspace_profile=selected fingerprint_switch=1 mismatch_fallback=0");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
