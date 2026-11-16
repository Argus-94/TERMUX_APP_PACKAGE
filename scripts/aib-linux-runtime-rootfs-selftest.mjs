#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import { loadTs } from "./aib-interceptor-test-helper.mjs";
const { LinuxRuntime } = loadTs("core/linux/LinuxRuntime.ts");

const ROOT = "/data/user/0/com.example.app/files/home";
const CONTAINERS = `${ROOT}/.aibuilder/containers`;
const DEBIAN_ROOTFS = `${CONTAINERS}/debian/images/base/rootfs`;

function fixture({
  loginHealthy = [],
  loginTimeout = [],
  loginEmptySuccess = [],
  installedList = "none",
  listOutput,
  listExitCode = 0,
  allowInstall = false,
  prootDistroAvailable = true,
  prootDistroCommandError = false,
  directRootfs = false,
  directProbe = "invalid",
} = {}) {
  const calls = [];
  const execCalls = [];
  let installedByTest = false;
  const environment = {
    async exists(candidate) { return directRootfs && candidate === DEBIAN_ROOTFS; },
    async mkdir() {},
    async exec(command, options = {}) {
      calls.push(command);
      execCalls.push({ command, options });
      if (/^command -v (?:'proot-distro'|proot-distro)$/.test(command)) {
        if (prootDistroCommandError) return { exitCode: -1, stdout: "", stderr: "TERMUX_RUN_COMMAND_INTERNAL_ERROR" };
        return prootDistroAvailable ? { exitCode: 0, stdout: "/usr/bin/proot-distro\n", stderr: "" } : { exitCode: 1, stdout: "", stderr: "" };
      }
      if (/^command -v (?:'proot'|proot)$/.test(command)) return { exitCode: 0, stdout: "/usr/bin/proot\n", stderr: "" };
      if (command.startsWith("ROOTFS_REAL=")) {
        if (directProbe === "healthy") return { exitCode: 0, stdout: "AIB_DIRECT_ROOTFS_ID:debian\nAIB_DIRECT_ROOTFS_UID:0\nAIB_DIRECT_ROOTFS_UNAME:aarch64\n", stderr: "" };
        if (directProbe === "timeout") return { exitCode: -1, stdout: "", stderr: "TIMEOUT" };
        return { exitCode: 80, stdout: "AIB_DIRECT_ROOTFS_PATH_UNVERIFIED\n", stderr: "" };
      }
      const loginMatch = command.match(/^proot-distro\s+(?:'login'|login)\s+(?:'([^']+)'|([^\s]+))/);
      if (loginMatch) {
        const alias = loginMatch[1] || loginMatch[2];
        if (loginTimeout.includes(alias)) return { exitCode: -1, stdout: "", stderr: "TIMEOUT" };
        if (loginEmptySuccess.includes(alias)) return { exitCode: 0, stdout: "", stderr: "" };
        if (loginHealthy.includes(alias) || installedByTest) {
          return { exitCode: 0, stdout: `AIB_PROBE_ID:${alias}\nAIB_PROBE_UID:0\nAIB_PROBE_UNAME:aarch64\n`, stderr: "" };
        }
        return { exitCode: 1, stdout: "", stderr: "mock login failed" };
      }
      if (/^proot-distro\s+(?:'list'|list)$/.test(command)) {
        const text = listOutput ?? (installedList === "none"
          ? "Installed distributions:\n  (none)\nSupported distributions:\n  Debian (debian)\n"
          : installedList === "ubuntu"
            ? "Installed distributions:\n  Ubuntu (ubuntu)\nSupported distributions:\n  Debian (debian)\n"
            : installedList === "both"
              ? "Installed distributions:\n  Debian (debian)\n  Ubuntu (ubuntu)\n"
              : `Installed distributions:\n  Debian (debian)\n`);
        return { exitCode: listExitCode, stdout: text, stderr: "" };
      }
      if (command.startsWith("set +e") && command.includes("proot-distro install debian")) {
        assert.match(command, /Installed distributions/);
        assert.match(command, /ROOTFS_INSTALLED_LOGIN_FAILED:debian/);
        assert.doesNotMatch(command, /proot-distro\\s+(?:reset|remove)/i);
        if (!allowInstall) throw new Error("unexpected guarded install invocation");
        installedByTest = true;
        return { exitCode: 0, stdout: "INSTALL_EXIT:0\n", stderr: "" };
      }
      throw new Error(`Unexpected LinuxRuntime command form: ${command.slice(0, 140)}`);
    },
  };
  const home = {
    root: ROOT,
    containers: CONTAINERS,
    workspace: `${ROOT}/workspace`,
    metadata: `${ROOT}/.aibuilder/meta`,
    sdk: `${ROOT}/.aibuilder/sdk`,
  };
  return { runtime: new LinuxRuntime(environment, home), calls, execCalls };
}

// A live login with matching os-release ID remains authoritative, independent of metadata/list.
const manual = fixture({ loginHealthy: ["debian"], installedList: "none" });
const manualStatus = await manual.runtime.status("debian");
assert.equal(manualStatus.available, true);
assert.equal(manualStatus.rootfsInstalled, true);
assert.equal(manualStatus.healthy, true);
assert.equal(manualStatus.stateSource, "proot-distro-login");
assert.equal(manual.calls.some((command) => command.includes("proot-distro 'list'") || command.includes("proot-distro list")), false, "verified live login needs no AI Builder metadata or list call");
const manualLogin = manual.execCalls.find(({ command }) => command.includes("proot-distro 'login'"));
assert.ok(manualLogin, "manual proot-distro login probe executed");
assert.equal(manualLogin.options.env?.HOME, undefined, "app-owned HOME must not replace Termux host HOME");
assert.equal(manualLogin.options.env?.AI_BUILDER_HOME, ROOT, "app-owned path is carried separately from Termux HOME");

// Listed-but-timeout rootfs is installed/unhealthy and must not be reinstalled.
const broken = fixture({ installedList: "debian", loginTimeout: ["debian"] });
const brokenStatus = await broken.runtime.status("debian");
assert.equal(brokenStatus.available, false);
assert.equal(brokenStatus.rootfsInstalled, true);
assert.equal(brokenStatus.healthy, false);
assert.equal(brokenStatus.stateSource, "proot-distro-list");
await assert.rejects(() => broken.runtime.bootstrap("debian"), /ROOTFS_INSTALLED_LOGIN_FAILED/);
assert.equal(broken.calls.some((command) => command.startsWith("set +e") && command.includes("proot-distro install")), false, "login timeout with listed alias must preserve rootfs");

// Exit 0 with no login identity plus blank/corrupt list is UNKNOWN, never healthy/absent.
for (const listOutput of ["", "Installed distributions:\nSupported distributions:\n  Debian (debian)\n", "Installed distributions:\n  broken truncated data\n"]) {
  const unknown = fixture({ listOutput, loginEmptySuccess: ["debian"] });
  const status = await unknown.runtime.status("debian");
  assert.equal(status.healthy, false);
  assert.equal(status.rootfsInstalled, null);
  assert.equal(status.stateSource, "unknown");
  await assert.rejects(() => unknown.runtime.bootstrap("debian"), /ROOTFS_STATE_UNVERIFIED/);
  assert.equal(unknown.calls.some((command) => command.startsWith("set +e") && command.includes("proot-distro install")), false);
}

// A tool that is missing/blocked cannot prove that its aliases are absent.
const unavailableTool = fixture({ prootDistroAvailable: false });
const unavailableStatus = await unavailableTool.runtime.status("debian");
assert.equal(unavailableStatus.rootfsInstalled, null);
assert.equal(unavailableStatus.healthy, false);
assert.equal(unavailableStatus.stateSource, "unknown");

const permissionDenied = fixture({ prootDistroCommandError: true, allowInstall: true });
const permissionStatus = await permissionDenied.runtime.status("debian");
assert.equal(permissionStatus.prootDistroInstalled, null, "RUN_COMMAND internal/permission error is not command absence");
assert.equal(permissionStatus.rootfsInstalled, null);
await assert.rejects(() => permissionDenied.runtime.bootstrap("debian"), /PROOT_DISTRO_STATE_UNVERIFIED/);
assert.equal(permissionDenied.calls.some((command) => command.startsWith("set +e") && command.includes("proot-distro install")), false, "permission-denied command cannot enter install path");

// Profile choice is exact: Ubuntu-only does not satisfy Debian, and vice versa.
const ubuntuOnly = fixture({ installedList: "ubuntu", loginHealthy: ["ubuntu"] });
assert.equal((await ubuntuOnly.runtime.status("debian")).rootfsInstalled, false);
assert.equal((await ubuntuOnly.runtime.status("ubuntu")).healthy, true);

// An app-owned path/metadata entry is not a rootfs: require canonical containment and a real proot guest ID.
const validDirect = fixture({ listOutput: "", directRootfs: true, directProbe: "healthy" });
const directStatus = await validDirect.runtime.status("debian");
assert.equal(directStatus.healthy, true);
assert.equal(directStatus.backend, "rootfs");
assert.equal(directStatus.stateSource, "aib-rootfs");
assert.equal(directStatus.rootfsPath, DEBIAN_ROOTFS);
const emptyDirectory = fixture({ listOutput: "", directRootfs: true, directProbe: "invalid" });
const emptyStatus = await emptyDirectory.runtime.status("debian");
assert.equal(emptyStatus.healthy, false);
assert.equal(emptyStatus.rootfsInstalled, null, "empty/corrupt app-owned directory remains unknown");
assert.equal(emptyStatus.rootfsPath, undefined, "unverified path is never returned as an executable rootfs");
const directTimeout = fixture({ listOutput: "", directRootfs: true, directProbe: "timeout" });
assert.equal((await directTimeout.runtime.status("debian")).rootfsInstalled, null);

// Explicitly empty installed list is the only list-based absence proof; install remains one-shot and post-verified.
const absent = fixture({ installedList: "none", allowInstall: true });
assert.equal((await absent.runtime.status("debian")).rootfsInstalled, false);
const install = await absent.runtime.bootstrap("debian");
assert.equal(install.exitCode, 0);
assert.match(install.stdout, /ROOTFS_INSTALL_VERIFIED:debian/);
assert.equal((await absent.runtime.status("debian")).healthy, true);

const termuxAgent = fs.readFileSync(new URL("../lib/termux-agent.ts", import.meta.url), "utf8");
assert.match(termuxAgent, /classifyProotDistroPreflight/);
assert.doesNotMatch(termuxAgent, /proot-distro install \$\{distro\}/, "agent preflight must not tell users to blindly install a distro");
const container = fs.readFileSync(new URL("../core/container/ProotContainerManager.ts", import.meta.url), "utf8");
assert.match(container, /buildProotDistroInstallCommand/);
assert.match(container, /buildProotDistroProbeCommand/);
assert.match(container, /rootfsState: "unverified"/);
assert.doesNotMatch(container, /proot-distro login \$\{shellQuote\(inst\.profile\)\} -- true/, "exit-zero true is not a guest identity check");
assert.doesNotMatch(container, /`proot-distro install \$\{shellQuote\(inst\.profile\)\}`/);
const backend = fs.readFileSync(new URL("../core/runtime/backends/ProotDistroBackend.ts", import.meta.url), "utf8");
assert.match(backend, /buildProotDistroInstallCommand/);
assert.match(backend, /parseProotDistroProbe/);
assert.match(backend, /state\.installed !== false/);
assert.doesNotMatch(backend, /`proot-distro install \$\{this\.profile\}`/);
console.log("AIB_LINUX_RUNTIME_ROOTFS_SELFTEST_OK exact_profile=1 live_identity=1 timeout_preserved=1 empty_corrupt_unknown=1 direct_rootfs_verified=1 metadata_not_authority=1 absent_install_guarded=1");
