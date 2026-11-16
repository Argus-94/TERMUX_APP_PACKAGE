#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import Module, { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  adaptPackageCommandForBackend,
  adaptTermuxPackageCommand,
  androidSdkRootEnvironment,
  isPackageSupportedOnBackend,
  packageBackendTarget,
} from "../lib/package-command-routing.ts";
import { wrapTermuxAptInstallWithUpdate } from "../lib/termux-apt-install.ts";
import { buildProotDistroRootfsCheckCommand, buildProotDistroRootfsInstallCommand } from "../lib/termux-bootstrap-install.ts";
import { buildProotDistroRemoveGuardCommand } from "../lib/proot-distro-state.ts";
import { SCRIPT_TEMPLATES } from "../lib/script-templates.ts";
import { typescript } from "./test-helpers/load-typescript.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const tsModuleCache = new Map();

function resolveTs(parent, request) {
  const base = path.resolve(path.dirname(parent), request);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function loadTs(file) {
  file = path.resolve(file);
  if (tsModuleCache.has(file)) return tsModuleCache.get(file).exports;
  const mod = new Module(file);
  mod.filename = file;
  mod.paths = Module._nodeModulePaths(path.dirname(file));
  tsModuleCache.set(file, mod);
  mod.require = (request) => {
    if (request === "@react-native-async-storage/async-storage") return { __esModule: true, default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} } };
    const resolved = request.startsWith(".") ? resolveTs(file, request) : null;
    return resolved ? loadTs(resolved) : createRequire(file)(request);
  };
  const js = typescript.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: file,
  }).outputText;
  mod._compile(js, file);
  return mod.exports;
}

const productionInstallerEnvironment = loadTs(path.join(root, "lib/termux-installer-env.ts")).withInstallerEnvironment;

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
  return Function(`"use strict"; return (${source.slice(start, end + 1)});`)();
}

function runShell(command, env, options = {}) {
  return spawnSync("bash", ["-c", command], {
    encoding: "utf8",
    env,
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  });
}

function syntaxCheck(name, command) {
  const result = spawnSync("bash", ["-n", "-c", command], { encoding: "utf8" });
  assert.equal(result.status, 0, `${name}: bash -n failed\n${result.stdout}${result.stderr}\n${command}`);
}

function toolEntries(file) {
  const source = read(file);
  const ids = [...source.matchAll(/\bid:\s*"([^"]+)"/g)].map((match) => match[1]);
  return ids.map((id) => {
    const start = source.indexOf(`id: "${id}"`);
    const end = source.indexOf("\n  },", start);
    const entry = source.slice(start, end < 0 ? source.length : end);
    const dynamicDistro = id === "debian-rootfs" ? "debian" : id === "ubuntu-rootfs" ? "ubuntu" : undefined;
    const dynamic = dynamicDistro ? {
      installCmd: buildProotDistroRootfsInstallCommand(dynamicDistro),
      checkCmd: buildProotDistroRootfsCheckCommand(dynamicDistro),
      removeCmd: buildProotDistroRemoveGuardCommand(dynamicDistro),
    } : undefined;
    return {
      id,
      installCmd: dynamic?.installCmd || fieldLiteral(source, id, "installCmd"),
      checkCmd: dynamic?.checkCmd || fieldLiteral(source, id, "checkCmd"),
      removeCmd: dynamic?.removeCmd || fieldLiteral(source, id, "removeCmd"),
      removeBlockedReason: entry.match(/\bremoveBlockedReason:\s*"([^"]+)"/)?.[1],
      blockedReason: entry.match(/\bblockedReason:\s*"([^"]+)"/)?.[1],
      blocked: /\bblocked:\s*true/.test(entry),
    };
  });
}

const compile = toolEntries("lib/compile-packages.ts");
const reverse = toolEntries("lib/reverse-packages.ts");
const allTools = [...compile, ...reverse];
assert.equal(compile.length, 34, `compile catalog count changed: ${compile.length}`);
assert.equal(reverse.length, 19, `reverse catalog count changed: ${reverse.length}`);
assert.equal(allTools.length, 53);
const blockedTools = allTools.filter((tool) => tool.blocked);
for (const tool of blockedTools) {
  assert.ok(tool.blockedReason, `${tool.id} blocked catalog entry must explain why installation is disabled`);
}
const expectedBlockedReverse = ["androguard", "apkleaks", "mitmproxy", "objection", "smali"];
assert.deepEqual(
  reverse.filter((tool) => tool.blocked).map((tool) => tool.id).sort(),
  expectedBlockedReverse,
  "only reverse tools without immutable artifact/dependency SHA-256 verification are blocked",
);
for (const tool of reverse.filter((item) => expectedBlockedReverse.includes(item.id))) {
  assert.match(tool.installCmd, /(?:SMALI|PYPI)_INSTALL_DISABLED_(?:SHA256|INTEGRITY_PIN)_REQUIRED/);
  assert.doesNotMatch(tool.installCmd, /https?:\/\/|\bpip\s+install\b|python\s+-m\s+pip\s+install|--upgrade|curl\s|wget\s/i,
    `${tool.id} must not retain an active unverified download/pip installer`);
}
for (const id of ["aapt2", "zipalign", "apksigner", "platform-tools"]) {
  assert.ok(compile.find((tool) => tool.id === id)?.removeBlockedReason, `${id} must protect shared compile/build packages from per-card removal`);
}
for (const id of ["npm", "android-platform-34", "android-platform-35"]) {
  assert.ok(compile.find((tool) => tool.id === id)?.removeBlockedReason, `${id} must not offer unsafe per-card removal`);
}
for (const id of ["android-tools", "aapt", "aapt2", "zipalign", "apksigner"]) {
  assert.ok(reverse.find((tool) => tool.id === id)?.removeBlockedReason, `${id} must protect shared reverse/build packages from per-card removal`);
}
const androidSdk = compile.find((tool) => tool.id === "android-sdk");
assert.equal((androidSdk.installCmd.match(/apt-get install -y/g) || []).length, 1, "Android SDK must not issue duplicate package installs");
assert.match(androidSdk.checkCmd, /\.aib-android-sdk-tools/, "Android SDK check must require its managed tool-view marker");
assert.doesNotMatch(androidSdk.checkCmd, /command -v aapt/, "aapt elsewhere on PATH must not masquerade as the managed SDK");
assert.doesNotMatch(androidSdk.removeCmd, /apt-get remove|rm -rf\s+["']?\$PREFIX\/opt\/android-sdk/, "Android SDK remove must not uninstall shared packages or erase the whole SDK tree");
for (const id of ["android-platform-34", "android-platform-35"]) {
  assert.doesNotMatch(compile.find((tool) => tool.id === id).removeCmd, /rm\s+-rf/, `${id} removal must not delete a shared SDK platform`);
}
assert.match(compile.find((tool) => tool.id === "android-ndk").installCmd, /AIB_PRIVATE_NDK_NOT_QUALIFIED[^\n]*exit 78/, "unqualified NDK must not retain an active installer");
for (const id of ["gradle", "sdk-cmdline-tools"]) {
  const tool = compile.find((item) => item.id === id);
  assert.match(tool.installCmd, /\$PREFIX\/tmp/, `${id} downloads and staging must live under Termux prefix tmp`);
  assert.match(tool.installCmd, /mktemp/, `${id} must use unique temporary names`);
  assert.doesNotMatch(`${tool.installCmd}\n${tool.removeCmd}`, /\/storage\/emulated\/0\/AIBuilderTermux\/\.aibuilder\/tmp/, `${id} must not use the shared project root as installer scratch space`);
}
for (const file of ["lib/build-loop.ts", "lib/termux-agent.ts", "lib/script-templates.ts"]) {
  assert.doesNotMatch(read(file), /\/storage\/emulated\/0\/AIBuilderTermux\/\.aibuilder\/android-(?:sdk|ndk)|\/termux-home\/\.aibuilder\/android-sdk/, `${file} must not mistake shared app storage for the installed Termux SDK/NDK`);
}
const cacheCleanup = read("lib/termux-cache-cleanup.ts");
assert.doesNotMatch(cacheCleanup, /rm -rf "\$PREFIX\/tmp\/"\*/, "cache cleanup must not remove unrelated Termux temporary files");
assert.doesNotMatch(cacheCleanup, /rm -rf [^\n]*AIBuilderTermux\/inbox|rm -rf "\$AIB\/\.aibuilder\/inbox"/, "cache cleanup must preserve user inbox files");
assert.match(read("lib/materialize-uri.ts"), /AIBuilderTermux\/inbox/, "copied user inputs belong in the visible workspace inbox");
const templateSource = read("lib/script-templates.ts");
assert.match(templateSource, /AIB_ROOT="\/storage\/emulated\/0\/AIBuilderTermux"/, "template must use the canonical shared workspace root");
assert.match(templateSource, /WORK="\$AIB_ROOT\/projects\/tpl-expo-\$BUILD_ID"/, "template projects must be created as unique visible projects");
assert.doesNotMatch(templateSource, /rm -rf "\$WORK"/, "template execution must not delete/reuse a fixed previous worktree");
const expoTemplate = SCRIPT_TEMPLATES.find((template) => template.id === "tpl-expo-build");
assert.ok(expoTemplate, "Expo build template must remain registered");
syntaxCheck("Expo build template", expoTemplate.body);

// Parse every exact shell literal and every backend-adapted command used by the
// right-side menu. This covers install, check/post-check, and removal paths.
for (const tool of allTools) {
  for (const [operation, command] of Object.entries({
    install: tool.installCmd,
    check: tool.checkCmd,
    remove: tool.removeCmd,
  })) {
    syntaxCheck(`${tool.id} ${operation} raw`, command);
    for (const selected of ["termux", "ubuntu-proot", "ubuntu-proot"]) {
      const target = packageBackendTarget(selected, tool.id);
      const adapted = adaptPackageCommandForBackend(command, operation, target);
      syntaxCheck(`${tool.id} ${operation} selected=${selected} target=${target}`, adapted);
      if (target === "termux" && operation !== "check") {
        assert.doesNotMatch(adapted, /\bapt-get\s+(?:install|remove|purge)\b/, `${tool.id} still uses apt-get for a Termux package operation`);
      }
    }
  }
}

// Explicit backend contracts: native host tools/bootstrap stay in Termux even
// while Linux proot is selected; Linux-capable tools use guest apt; Android SDK
// artifacts go through sdkmanager or their pinned direct download commands.
for (const id of ["proot-distro", "debian-rootfs", "ubuntu-rootfs", "termux-api", "frida-tools"]) {
  assert.equal(packageBackendTarget("ubuntu-proot", id), "termux", `${id} must execute in host Termux`);
  assert.equal(packageBackendTarget("ubuntu-proot", id), "termux", `${id} must execute in host Termux`);
}
assert.equal(packageBackendTarget("ubuntu-proot", "git"), "linux");
assert.equal(packageBackendTarget("ubuntu-proot", "git"), "linux");
assert.equal(packageBackendTarget("ubuntu-proot", "sdk-cmdline-tools"), "linux");
assert.equal(packageBackendTarget("ubuntu-proot", "android-platform-35"), "linux");
assert.equal(isPackageSupportedOnBackend("android-ndk", "linux"), false);
assert.equal(isPackageSupportedOnBackend("android-ndk", "termux"), true);

const proot = compile.find((tool) => tool.id === "proot-distro");
const hostProotInstall = adaptPackageCommandForBackend(proot.installCmd, "install", "termux");
assert.match(hostProotInstall, /pkg install -y proot-distro/);
assert.doesNotMatch(hostProotInstall, /apt-get install\s+-y\s+proot-distro/);
const sdkBuildTools = adaptPackageCommandForBackend("apt-get install -y aapt aapt2 apksigner d8", "install", "linux");
assert.match(sdkBuildTools, /sdkmanager/);
assert.match(sdkBuildTools, /build-tools;35\.0\.0/);
assert.doesNotMatch(sdkBuildTools, /apt-get install -y aapt(?:2)?\b/);
assert.match(adaptPackageCommandForBackend("apt-get install -y git", "install", "linux"), /apt-get install -y git/);
assert.match(adaptPackageCommandForBackend("apt-get install -y git", "install", "termux"), /pkg install -y git/);

for (const { env, expected } of [
  { env: { ANDROID_HOME: "/user/sdk-home", ANDROID_SDK_ROOT: "/stale/sdk-root" }, expected: "/user/sdk-home|/user/sdk-home" },
  { env: { ANDROID_SDK_ROOT: "/user/sdk-root" }, expected: "/user/sdk-root|/user/sdk-root" },
  { env: {}, expected: "/termux/prefix/opt/android-sdk|/termux/prefix/opt/android-sdk" },
]) {
  const result = runShell(`${androidSdkRootEnvironment()}printf '%s|%s\\n' "$ANDROID_HOME" "$ANDROID_SDK_ROOT"`, {
    ...process.env, PREFIX: "/termux/prefix", ANDROID_HOME: "", ANDROID_SDK_ROOT: "", ...env,
  });
  assert.equal(result.status, 0, `SDK-root resolution failed: ${result.stderr}`);
  assert.equal(result.stdout.trim(), expected, "all package checks must use the same explicit/default SDK root");
}

// The private installation wrapper must fail closed while preserving fixture sources.
// Stub package managers are deliberate tripwires: neither may ever be invoked.
{
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aib-package-menu-termux-"));
  try {
    const prefix = path.join(temp, "prefix");
    const bin = path.join(temp, "bin");
    const log = path.join(temp, "package-manager.log");
    const sourceFile = path.join(prefix, "etc", "apt", "sources.list");
    fs.mkdirSync(path.join(prefix, "etc", "termux"), { recursive: true });
    fs.mkdirSync(path.join(prefix, "etc", "apt"), { recursive: true });
    fs.mkdirSync(path.join(prefix, "var", "lib", "apt", "lists"), { recursive: true });
    fs.mkdirSync(path.join(prefix, "tmp"), { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(sourceFile, "deb https://user.example/termux stable main\n");
    fs.writeFileSync(path.join(prefix, "etc", "termux", "chosen_mirrors"), "user-selected mirror\n");
    fs.writeFileSync(path.join(prefix, "var", "lib", "apt", "lists", "user_dists_stable_main_binary-aarch64_Packages"), "fixture\n");
    fs.writeFileSync(
      path.join(bin, "apt-get"),
      `#!/bin/sh\necho "APT:$*" >> "$PACKAGE_LOG"\nif [ "$1" = install ] && [ "$3" = proot-distro ]; then mkdir -p "$PREFIX/bin"; printf '#!/bin/sh\\nexit 0\\n' > "$PREFIX/bin/proot-distro"; chmod +x "$PREFIX/bin/proot-distro"; fi\nexit 0\n`,
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(bin, "pkg"),
      `#!/bin/sh\necho "UNEXPECTED_PKG:$*" >> "$PACKAGE_LOG"\nexit 99\n`,
      { mode: 0o755 },
    );
    const originalSources = fs.readFileSync(sourceFile, "utf8");
    const env = {
      ...process.env,
      PREFIX: prefix,
      PACKAGE_LOG: log,
      PATH: `${bin}:${path.join(prefix, "bin")}:/usr/bin:/bin`,
    };
    const result = runShell(productionInstallerEnvironment(hostProotInstall, "termux"), env);
    assert.equal(result.status, 78, `unqualified private wrapper must reject before a package operation: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /AIB_PRIVATE_PACKAGE_FEED_NOT_QUALIFIED/);
    const quotedShell = runShell(wrapTermuxAptInstallWithUpdate("printf '%s\\n' 'quoted installer works'"), env);
    assert.equal(quotedShell.status, 78, "even a quoted installer body must remain blocked");
    assert.doesNotMatch(quotedShell.stdout, /quoted installer works/);
    assert.equal(fs.existsSync(log), false, "neither apt-get nor pkg may run for an unqualified feed");
    assert.equal(fs.existsSync(path.join(prefix, "bin", "proot-distro")), false, "no tool may be created by the rejected wrapper");
    assert.equal(fs.readFileSync(sourceFile, "utf8"), originalSources, "user Termux sources were changed");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

// Exercise the Linux guest apt wrapper independently from host Termux pkg.
{
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aib-package-menu-linux-"));
  try {
    const prefix = path.join(temp, "prefix");
    const bin = path.join(temp, "bin");
    const log = path.join(temp, "package-manager.log");
    fs.mkdirSync(path.join(prefix, "tmp"), { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(
      path.join(bin, "apt-get"),
      `#!/bin/sh\necho "APT:$*" >> "$PACKAGE_LOG"\nexit 0\n`,
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(bin, "pkg"),
      `#!/bin/sh\necho "UNEXPECTED_PKG:$*" >> "$PACKAGE_LOG"\nexit 99\n`,
      { mode: 0o755 },
    );
    const linuxInstall = adaptPackageCommandForBackend("apt-get install -y git", "install", "linux");
    const result = runShell(linuxInstall, {
      ...process.env,
      PREFIX: prefix,
      PACKAGE_LOG: log,
      PATH: `${bin}:/usr/bin:/bin`,
    });
    assert.equal(result.status, 0, `Linux guest apt install failed: ${result.stdout}${result.stderr}`);
    const transcript = fs.readFileSync(log, "utf8");
    assert.match(transcript, /^APT:install -y git$/m);
    assert.doesNotMatch(transcript, /UNEXPECTED_PKG/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

// The menu dispatcher must choose backend before adding a Termux/proot wrapper,
// and all package families (including custom) must pass raw commands to it.
const packageBackend = read("lib/package-backend.ts");
for (const token of [
  'if (options.kind !== "check") assertPrivatePackageMutationAllowed()',
  'packageBackendTarget(selectedBackend, options.packageId)',
  'adaptPackageCommandForBackend(command, "check", "termux")',
  'withCheckEnvironment(adapted, "termux")',
  'executionTarget: "embedded-private"',
]) assert.ok(packageBackend.includes(token), `dispatcher contract missing: ${token}`);
assert.doesNotMatch(packageBackend, /hostTermux:|backend: executionBackend|withInstallerEnvironment\(/, 'manual package backend cannot use legacy execution or start installer wrappers');
for (const file of ["lib/compile-packages.ts", "lib/reverse-packages.ts", "lib/custom-packages.ts"]) {
  const source = read(file);
  assert.doesNotMatch(source, /runPackageCommand\(with(?:Installer|Check)Environment\(/, `${file} pre-wraps a package command`);
}
const reverseSource = read("lib/reverse-packages.ts");
const blockedGate = reverseSource.indexOf("if (def.blocked)");
const installInvocation = reverseSource.indexOf("runPackageCommand(def.installCmd", blockedGate);
assert.ok(blockedGate >= 0 && installInvocation > blockedGate,
  "the install API must reject a blocked package before invoking the selected Termux/proot command route");
const packageMenuUi = read("components/PackagesRightMenu.tsx");
assert.equal((packageMenuUi.match(/<ProgressBar progress=\{st\.progress\} indeterminate sublabel=\{st\.detail\}/g) || []).length, 2, "built-in and custom cards use indeterminate task progress");
assert.doesNotMatch(packageMenuUi, /Math\.round\(st\.progress\)\s*\+?\s*["']%/, "busy package badges must not show fabricated percentages");
assert.match(packageMenuUi, /isInstalled && !def\.removeBlockedReason/, "unsafe shared package removals must be hidden from the built-in tool cards");
assert.match(packageMenuUi, /\) : isBlocked \? \(/, "blocked tools must remain non-actionable even if a probe finds them installed");
assert.doesNotMatch(packageMenuUi, /setInterval\([^\n]*(?:progress|tick)/i, "package UI must not synthesize percentage progress on a timer");

console.log(
  `AIB_PACKAGE_MENU_INSTALL_SELFTEST_OK built_in_tools=${allTools.length} compile=${compile.length} reverse=${reverse.length} ` +
    `operations=${allTools.length * 3} backend_adaptations=${allTools.length * 3 * 3} ` +
    `blocked_fail_closed=${blockedTools.length} private_wrapper_blocked=1 private_package_transactions=0 isolated_legacy_apt_stub=1 sdkmanager_syntax=1 direct_download_syntax=1 user_sources_unchanged=1`,
);
