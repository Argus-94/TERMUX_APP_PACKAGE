#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { formatPackageInstallFailure } from "../lib/package-install-diagnostics.ts";
import { wrapTermuxAptInstallWithUpdate } from "../lib/termux-apt-install.ts";
import { buildTermuxStatusFlags } from "../lib/termux-status-flags.ts";
import {
  buildProotDistroRootfsInstallCommand,
  buildProotDistroRootfsCheckCommand,
  buildTermuxProotDistroInstallCommand,
  buildTermuxToolsBaseInstallCommand,
} from "../lib/termux-bootstrap-install.ts";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function fieldLiteral(source, id, field) {
  const idAt = source.indexOf(`id: "${id}"`);
  assert.notEqual(idAt, -1, `package id not found: ${id}`);
  const fieldAt = source.indexOf(`${field}:`, idAt);
  assert.notEqual(fieldAt, -1, `${field} not found for ${id}`);
  let start = fieldAt + field.length + 1;
  while (/\s/.test(source[start] || "")) start++;
  const quote = source[start];
  assert.ok(quote === "`" || quote === '"' || quote === "'", `unexpected ${field} literal for ${id}`);
  let end = start + 1;
  for (; end < source.length; end++) {
    if (source[end] === "\\") {
      end++;
      continue;
    }
    if (source[end] === quote) break;
  }
  assert.ok(end < source.length, `unterminated ${field} literal for ${id}`);
  const literal = source.slice(start, end + 1);
  // Evaluate the exact source literal as JavaScript so template escapes resolve
  // exactly as they do in the app. These package command literals are static.
  return Function(`"use strict"; return (${literal});`)();
}

function runShell(command, env, maxBuffer = 2 * 1024 * 1024) {
  return spawnSync("bash", ["-c", command], { encoding: "utf8", env, maxBuffer });
}

function writeExecutable(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, { mode: 0o755 });
}

function fixture(label) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), label));
  const prefix = path.join(temp, "prefix");
  const bin = path.join(temp, "bin");
  const sdk = path.join(temp, "sdk");
  const sources = path.join(prefix, "etc", "apt", "sources.list");
  fs.mkdirSync(path.join(prefix, "etc", "termux"), { recursive: true });
  fs.mkdirSync(path.join(prefix, "etc", "apt"), { recursive: true });
  fs.mkdirSync(path.join(prefix, "var", "lib", "apt", "lists"), { recursive: true });
  fs.mkdirSync(path.join(prefix, "tmp"), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(sdk, { recursive: true });
  fs.writeFileSync(path.join(prefix, "etc", "termux", "chosen_mirrors"), "user-selected mirror\n");
  fs.writeFileSync(sources, "deb https://user.example/termux stable main\n");
  fs.writeFileSync(path.join(prefix, "var", "lib", "apt", "lists", "user_dists_stable_main_binary-aarch64_Packages"), "index fixture\n");
  return {
    temp,
    prefix,
    bin,
    sdk,
    sources,
    env: {
      ...process.env,
      PREFIX: prefix,
      ANDROID_HOME: sdk,
      ANDROID_SDK_ROOT: sdk,
      PATH: `${bin}:/usr/bin:/bin`,
    },
  };
}

const compile = read("lib/compile-packages.ts");
const reverse = read("lib/reverse-packages.ts");
const androidSdkInstall = fieldLiteral(compile, "android-sdk", "installCmd");
const androidSdkCheck = fieldLiteral(compile, "android-sdk", "checkCmd");
const aaptInstall = fieldLiteral(compile, "aapt2", "installCmd");
const aaptCheck = fieldLiteral(compile, "aapt2", "checkCmd");
const reverseAaptCheck = fieldLiteral(reverse, "aapt", "checkCmd");
const reverseAapt2Check = fieldLiteral(reverse, "aapt2", "checkCmd");

// Parse the exact shell snippets committed in the package definitions.
for (const [name, command] of [
  ["android-sdk install", androidSdkInstall],
  ["android-sdk post-check", androidSdkCheck],
  ["AAPT/AAPT2 install", aaptInstall],
  ["AAPT/AAPT2 post-check", aaptCheck],
  ["reverse AAPT post-check", reverseAaptCheck],
  ["reverse AAPT2 post-check", reverseAapt2Check],
  ["Termux tools-base install", buildTermuxToolsBaseInstallCommand()],
  ["Termux proot-distro install", buildTermuxProotDistroInstallCommand()],
  ["Debian rootfs install", buildProotDistroRootfsInstallCommand("debian")],
  ["Ubuntu rootfs install", buildProotDistroRootfsInstallCommand("ubuntu")],
  ["Debian rootfs check", buildProotDistroRootfsCheckCommand("debian")],
  ["Ubuntu rootfs check", buildProotDistroRootfsCheckCommand("ubuntu")],
]) {
  const syntax = spawnSync("bash", ["-n", "-c", command], { encoding: "utf8" });
  assert.equal(syntax.status, 0, `${name}: bash -n failed\n${syntax.stdout}${syntax.stderr}\n${command}`);
}

// Verify AAPT install and post-check scripts against real Bash parsing and mocked tools.
{
  const f = fixture("aib-aapt-shell-");
  try {
    writeExecutable(path.join(f.bin, "apt-get"), '#!/bin/sh\necho "MOCK_APT_STDOUT:$*"\necho "MOCK_APT_STDERR:$*" >&2\nexit 0\n');
    writeExecutable(path.join(f.bin, "aapt2"), '#!/bin/sh\n[ "$1" = version ] || exit 3\necho "mock aapt2 version 1"\nexit 0\n');

    const aaptRun = runShell(wrapTermuxAptInstallWithUpdate(aaptInstall), f.env);
    assert.equal(aaptRun.status, 0, `AAPT installer failed: ${aaptRun.stdout}${aaptRun.stderr}`);
    assert.match(aaptRun.stdout, /AAPT_OK/);
    assert.match(aaptRun.stdout, /MOCK_APT_STDOUT:install -y aapt aapt2/);

    const sdkRun = runShell(wrapTermuxAptInstallWithUpdate(androidSdkInstall), f.env);
    assert.equal(sdkRun.status, 0, `Android SDK installer failed: ${sdkRun.stdout}${sdkRun.stderr}`);
    assert.match(sdkRun.stdout, /SDK_OK/);

    for (const [name, command] of [
      ["android-sdk", androidSdkCheck],
      ["AAPT/AAPT2 compile", aaptCheck],
      ["reverse AAPT2", reverseAapt2Check],
    ]) {
      const checked = runShell(command, f.env);
      assert.equal(checked.status, 0, `${name} check did not detect executable aapt2: ${checked.stdout}${checked.stderr}`);
    }

    const fallbackSdk = path.join(f.sdk, "build-tools", "35.0.0");
    writeExecutable(path.join(fallbackSdk, "aapt"), '#!/bin/sh\n[ "$1" = version ] || exit 3\necho "mock aapt version 1"\nexit 0\n');
    const reverseAapt = runShell(reverseAaptCheck, f.env);
    assert.equal(reverseAapt.status, 0, `reverse AAPT check did not detect SDK build-tools executable: ${reverseAapt.stdout}${reverseAapt.stderr}`);
    fs.rmSync(path.join(fallbackSdk, "aapt"), { force: true });

    writeExecutable(path.join(f.bin, "aapt2"), '#!/bin/sh\necho "not a working executable" >&2\nexit 7\n');
    const badCheck = runShell(aaptCheck, f.env);
    assert.notEqual(badCheck.status, 0, "post-check must reject an aapt2 binary that fails its version command");

    const platformJar = path.join(f.sdk, "platforms", "android-35", "android.jar");
    const userBuildTool = path.join(f.sdk, "build-tools", "35.0.0", "user-owned.txt");
    const sdkmanager = path.join(f.sdk, "cmdline-tools", "latest", "bin", "sdkmanager");
    fs.mkdirSync(path.dirname(platformJar), { recursive: true });
    fs.mkdirSync(path.dirname(userBuildTool), { recursive: true });
    fs.mkdirSync(path.dirname(sdkmanager), { recursive: true });
    fs.writeFileSync(platformJar, "fixture-platform-jar");
    fs.writeFileSync(userBuildTool, "preserve-user-sdk-file");
    fs.writeFileSync(sdkmanager, "preserve-sdkmanager");
    const sdkRemove = runShell(fieldLiteral(compile, "android-sdk", "removeCmd"), f.env);
    assert.equal(sdkRemove.status, 0, `Android SDK removal did not complete safely: ${sdkRemove.stdout}${sdkRemove.stderr}`);
    for (const preserved of [platformJar, userBuildTool, sdkmanager]) {
      assert.equal(fs.readFileSync(preserved, "utf8"), preserved === platformJar ? "fixture-platform-jar" : preserved === userBuildTool ? "preserve-user-sdk-file" : "preserve-sdkmanager", `Android SDK remove erased unrelated SDK state at ${preserved}`);
    }
    assert.equal(fs.existsSync(path.join(f.sdk, ".aib-android-sdk-tools")), false, "managed tool-view marker should be removed");
    assert.equal(fs.existsSync(path.join(f.sdk, "build-tools", "termux", "aapt2")), false, "only manifest-owned tool-view link should be removed");
    assert.equal(fs.existsSync(path.join(f.bin, "aapt2")), true, "shared package binary must remain installed");
  } finally {
    fs.rmSync(f.temp, { recursive: true, force: true });
  }
}

// Apt update failure: preserve stdout + stderr, actual exit=100, and user sources.
{
  const f = fixture("aib-apt-update-failure-");
  try {
    const originalSources = fs.readFileSync(f.sources, "utf8");
    writeExecutable(
      path.join(f.bin, "apt-get"),
      `#!/bin/sh
if [ "$1" = update ]; then
  echo UPDATE_STDOUT_HEAD
  echo UPDATE_STDERR_HEAD >&2
  i=1
  while [ "$i" -le 12 ]; do echo "update stdout filler $i"; echo "update stderr filler $i" >&2; i=$((i+1)); done
  echo UPDATE_STDOUT_TAIL
  echo UPDATE_STDERR_TAIL >&2
  exit 100
fi
echo INSTALL_SHOULD_NOT_RUN >&2
exit 88
`,
    );
    const result = runShell(wrapTermuxAptInstallWithUpdate("apt-get install -y proot-distro"), f.env);
    assert.equal(result.status, 100, `apt-get update exit status was not preserved: ${result.stdout}${result.stderr}`);
    const message = formatPackageInstallFailure({ exitCode: result.status, stdout: result.stdout, stderr: result.stderr });
    assert.match(message, /^exit 100: apt-get update failed/);
    for (const marker of ["full apt update log preserved at", "UPDATE_STDOUT_HEAD", "UPDATE_STDERR_HEAD", "UPDATE_STDOUT_TAIL", "UPDATE_STDERR_TAIL"]) {
      assert.ok(message.includes(marker), `full apt update transcript lost ${marker}`);
    }
    assert.doesNotMatch(message, /INSTALL_SHOULD_NOT_RUN/);
    assert.equal(fs.readFileSync(f.sources, "utf8"), originalSources, "user-configured apt sources changed on failure");
  } finally {
    fs.rmSync(f.temp, { recursive: true, force: true });
  }
}

// Apt install failure after repair retry: retain both streams, first and final markers, and exit status.
{
  const f = fixture("aib-apt-install-failure-");
  try {
    const originalSources = fs.readFileSync(f.sources, "utf8");
    writeExecutable(
      path.join(f.bin, "apt-get"),
      `#!/bin/sh
if [ "$1" = update ]; then echo UPDATE_OK; exit 0; fi
if [ "$1" = -f ]; then echo REPAIR_OK; exit 0; fi
if [ "$1" = install ]; then
  echo INSTALL_STDOUT_HEAD
  echo INSTALL_STDERR_HEAD >&2
  i=1
  while [ "$i" -le 12 ]; do echo "install stdout filler $i"; echo "install stderr filler $i" >&2; i=$((i+1)); done
  echo INSTALL_STDOUT_TAIL
  echo INSTALL_STDERR_TAIL >&2
  exit 17
fi
exit 0
`,
    );
    writeExecutable(path.join(f.bin, "dpkg"), "#!/bin/sh\nexit 0\n");
    const result = runShell(wrapTermuxAptInstallWithUpdate("apt-get install -y test-package"), f.env);
    assert.equal(result.status, 17, `apt-get install exit status was not preserved: ${result.stdout}${result.stderr}`);
    const message = formatPackageInstallFailure({ exitCode: result.status, stdout: result.stdout, stderr: result.stderr });
    assert.match(message, /^exit 17: apt-get install failed/);
    for (const marker of ["full apt install log preserved at", "INSTALL_STDOUT_HEAD", "INSTALL_STDERR_HEAD", "INSTALL_STDOUT_TAIL", "INSTALL_STDERR_TAIL"]) {
      assert.ok(message.includes(marker), `full apt install transcript lost ${marker}`);
    }
    assert.equal(fs.readFileSync(f.sources, "utf8"), originalSources, "user-configured apt sources changed during repair/retry");
  } finally {
    fs.rmSync(f.temp, { recursive: true, force: true });
  }
}

// Bootstrap's pkg/proot-distro commands also preserve full output and exact failures.
{
  const f = fixture("aib-proot-bootstrap-");
  try {
    const originalSources = fs.readFileSync(f.sources, "utf8");
    writeExecutable(
      path.join(f.bin, "apt-get"),
      `#!/bin/sh
case "$1" in
  update) echo PKG_UPDATE_STDOUT_HEAD; echo PKG_UPDATE_STDERR_TAIL >&2; exit 100 ;;
  install) echo PKG_INSTALL_SHOULD_NOT_RUN >&2; exit 88 ;;
esac
exit 0
`,
    );
    const updateFail = runShell(buildTermuxProotDistroInstallCommand(), f.env);
    assert.equal(updateFail.status, 100);
    assert.match(updateFail.stdout, /PKG_UPDATE_STDOUT_HEAD/);
    assert.match(updateFail.stderr, /PKG_UPDATE_STDERR_TAIL/);
    assert.match(updateFail.stdout, /AIB_PKG_UPDATE_EXIT:100/);
    assert.doesNotMatch(`${updateFail.stdout}\n${updateFail.stderr}`, /PKG_INSTALL_SHOULD_NOT_RUN/);
    assert.equal(fs.readFileSync(f.sources, "utf8"), originalSources);

    writeExecutable(
      path.join(f.bin, "proot-distro"),
      `#!/bin/sh
case "$1" in
  login) echo "Error: container 'debian' is not installed." >&2; exit 1 ;;
  list) echo 'Installed distributions:'; echo '(none)'; exit 0 ;;
  install) echo ROOTFS_STDOUT_HEAD; echo ROOTFS_STDERR_TAIL >&2; exit 23 ;;
esac
exit 64
`,
    );
    const rootfsFail = runShell(buildProotDistroRootfsInstallCommand("debian"), f.env);
    assert.equal(rootfsFail.status, 23);
    assert.match(rootfsFail.stdout, /ROOTFS_STDOUT_HEAD/);
    assert.match(rootfsFail.stdout, /ROOTFS_STDERR_TAIL/);
    assert.match(rootfsFail.stdout, /INSTALL_EXIT:23/);
    assert.equal(fs.readFileSync(f.sources, "utf8"), originalSources);
  } finally {
    fs.rmSync(f.temp, { recursive: true, force: true });
  }
}

// Readiness, UI, and diagnostic regression contracts.
{
  const bridge = read("lib/termux-bridge.ts");
  const status = read("lib/termux-status.ts");
  const plugin = read("plugins/withTermuxBridge.js");
  const settingsUi = read("app/termux-settings.tsx");
  const dialog = read("components/AppDialog.tsx");
  const packageMenu = read("components/PackagesRightMenu.tsx");
  const bootstrap = read("lib/bootstrap-stage-runner.ts");
  const bootstrapCore = read("lib/bootstrap-stage-core.ts");
  const i18n = read("lib/i18n.ts");
  const classifier = read("lib/scripted-task-engine.ts");

  assert.match(bridge, /Promise\.allSettled\(\[\s*native\.isTermuxInstalled\(\),\s*readRunCommandPermission\(native, opts\?\.refreshPermission === true\),\s*\]\)/);
  assert.match(bridge, /runCommandPermissionGate\.check/);
  assert.match(bridge, /run_command_permission_check_failed/);
  assert.match(bridge, /no success marker was received/);
  assert.match(plugin, /packageManager\.checkPermission\(/);
  assert.match(plugin, /runCommandPermissionState/);
  assert.doesNotMatch(plugin, /нет разрешения RUN_COMMAND или в Termux не включён allow-external-apps=true/);
  assert.doesNotMatch(plugin, /apt update && apt install termux-api/);
  assert.doesNotMatch(classifier, /нет RUN_COMMAND или allow-external-apps=true/);
  assert.match(settingsUi, /Linking\.openSettings\(\)/);
  assert.match(settingsUi, /r\.probeDetail/);
  assert.match(dialog, /<ScrollView[\s\S]*?\{message\}/);
  assert.match(packageMenu, /showDialog\(def\.name, `Не удалось установить:\\n\$\{result\.error/);
  assert.match(bootstrapCore, /buildTermuxProotDistroInstallCommand\(\)/);
  assert.match(bootstrapCore, /buildProotDistroRootfsInstallCommand\(distro\)/);
  assert.match(bootstrapCore, /routeRuntimeCommand\(selectedBackend, "proot-distro"\)/);
  assert.match(bootstrap, /hostTermux: backend === "termux"/);
  assert.doesNotMatch(bootstrap, /\.slice\(0,\s*600\)|\.slice\(-500\)/);
  assert.match(i18n, /обычное обновление уже установленного приложения обычно его сохраняет/);
  assert.match(i18n, /Доступ «до всіх файлів» не потрібен для отримання результатів RUN_COMMAND/);

  const flag = (reasons, id, ready = false, probed = false) =>
    buildTermuxStatusFlags({ reasons, ready, probed }).find((item) => item.id === id);
  for (const reason of ["not_android", "native_module_missing"]) {
    assert.equal(flag([reason], "run_command")?.ok, false, `${reason} must not imply a granted permission`);
    assert.equal(flag([reason], "run_command")?.detail, "Не проверено");
    assert.equal(flag([reason], "installed")?.ok, false, `${reason} must not imply Termux is installed`);
  }
  assert.equal(flag(["run_command_permission_missing"], "run_command")?.ok, false);
  assert.equal(flag(["run_command_permission_missing"], "run_command")?.detail, "Нет разрешения Android");
  assert.equal(flag(["run_command_permission_check_failed"], "run_command")?.ok, false);
  assert.equal(flag(["run_command_permission_check_failed"], "run_command")?.detail, "Статус разрешения не удалось прочитать");
  assert.equal(flag(["termux_install_check_failed"], "installed")?.ok, false);
  assert.equal(flag(["run_command_probe_failed"], "run_command", false, true)?.ok, true);
  assert.equal(flag(["run_command_probe_failed"], "probe", false, true)?.ok, false);
  assert.equal(flag([], "run_command", true, true)?.detail, "Выдано");
}

// Source-level audit: shell find-group escapes inside JS/TS string literals must survive JS evaluation.
for (const file of ["lib/compile-packages.ts", "lib/termux-agent.ts", "lib/build-loop.ts"]) {
  for (const [index, line] of read(file).split(/\r?\n/).entries()) {
    if (!line.includes("find ") || !line.includes("\\(")) continue;
    for (let pos = line.indexOf("("); pos >= 0; pos = line.indexOf("(", pos + 1)) {
      if (line[pos - 1] !== "\\") continue;
      let count = 0;
      for (let cursor = pos - 1; cursor >= 0 && line[cursor] === "\\"; cursor--) count++;
      assert.equal(count % 2, 0, `${file}:${index + 1} loses shell escape before find-group parenthesis`);
    }
  }
}

console.log("AIB_TERMUX_INSTALL_REGRESSION_SELFTEST_OK aapt_shell=6 apt_update_exit=100 apt_install_exit=17 status_mocks=1 full_stdout_stderr=sources_preserved=1 bootstrap_full_output=1 ui_diagnostics=1");
