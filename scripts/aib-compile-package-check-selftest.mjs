import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { typescript } from "./test-helpers/load-typescript.mjs";
import { checkPackageCommand } from "../lib/package-check-outcome.ts";
import { isPkgMirrorFailure, TERMUX_MIRROR_REPAIR, wrapTermuxAptInstallWithUpdate } from "../lib/termux-apt-install.ts";
import { adaptPackageCommandForBackend, androidSdkRootEnvironment, isPackageSupportedOnBackend, packageBackendTarget } from "../lib/package-command-routing.ts";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const helperSource = read("lib/commands-guide-helpers.ts");
const helperJavaScript = typescript.transpileModule(helperSource, {
  compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 },
}).outputText;
const helperModule = { exports: {} };
vm.runInNewContext(helperJavaScript, {
  require: (name) => {
    if (name === "./package-command-routing") return { isPackageSupportedOnBackend, packageBackendTarget };
    throw new Error(`unexpected compile-guide import: ${name}`);
  },
  module: helperModule,
  exports: helperModule.exports,
});
const { buildCompileGuideRows, COMPILE_GUIDE_RULES, filterCompileGuideRows, getCompileGuideInstruction } = helperModule.exports;

const installed = await checkPackageCommand(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
assert.deepEqual(installed, { status: "installed" });

const missing = await checkPackageCommand(async () => ({ exitCode: 1, stdout: "", stderr: "" }));
assert.deepEqual(missing, { status: "missing" });

const permissionDenied = await checkPackageCommand(async () => {
  throw new Error("SecurityException: RUN_COMMAND permission denied");
});
assert.equal(permissionDenied.status, "error");
assert.match(permissionDenied.detail, /SecurityException/);

const timeout = await checkPackageCommand(async () => ({ exitCode: -1, timedOut: true }));
assert.deepEqual(timeout, { status: "error", detail: "PACKAGE_CHECK_TIMEOUT" });

const unexpectedExit = await checkPackageCommand(async () => ({ exitCode: 100, stdout: "apt diagnostic" }));
assert.equal(unexpectedExit.status, "error");
assert.match(unexpectedExit.detail, /PACKAGE_CHECK_EXIT_100/);
assert.match(unexpectedExit.detail, /apt diagnostic/);

assert.equal(
  isPkgMirrorFailure({ exitCode: 100, stdout: "[aib] apt-get update failed (exit=100)\\nAIB_APT_EXIT:100" }),
  false,
);
assert.equal(isPkgMirrorFailure({ exitCode: 100, stderr: "E: Unable to locate package wget" }), false);
assert.equal(isPkgMirrorFailure({ exitCode: 100, stderr: "E: Failed to fetch package index" }), true);

for (const suffix of [".lz4", ".xz"]) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aib-apt-index-"));
  try {
    const prefix = path.join(temp, "prefix");
    const bin = path.join(temp, "bin");
    const lists = path.join(prefix, "var", "lib", "apt", "lists");
    const aptLog = path.join(temp, "apt.log");
    fs.mkdirSync(path.join(prefix, "etc", "termux"), { recursive: true });
    fs.mkdirSync(lists, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(prefix, "etc", "termux", "chosen_mirrors"), "test mirror\n");
    fs.writeFileSync(path.join(lists, `mirror_dists_stable_main_binary-aarch64_Packages${suffix}`), "compressed index fixture\n");
    fs.writeFileSync(
      path.join(bin, "apt-get"),
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$APT_LOG"\nif [ "$1" = "update" ]; then echo "Hit:1 mirror stable InRelease"; fi\nexit 0\n',
      { mode: 0o755 },
    );
    const env = {
      ...process.env,
      PREFIX: prefix,
      PATH: `${bin}:${process.env.PATH || ""}`,
      APT_LOG: aptLog,
    };

    const repaired = spawnSync("bash", ["-c", TERMUX_MIRROR_REPAIR], { encoding: "utf8", env });
    assert.equal(repaired.status, 0, `${suffix}: mirror repair rejected compressed index: ${repaired.stdout}${repaired.stderr}`);
    assert.match(repaired.stdout, /AIB_MIRROR_REPAIR_DONE upd=0/);

    fs.writeFileSync(aptLog, "");
    const installed = spawnSync("bash", ["-c", wrapTermuxAptInstallWithUpdate("apt-get install -y test-package")], { encoding: "utf8", env });
    assert.equal(installed.status, 0, `${suffix}: apt install rejected compressed index: ${installed.stdout}${installed.stderr}`);
    assert.match(fs.readFileSync(aptLog, "utf8"), /^install -y test-package$/m);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

const compilePackages = read("lib/compile-packages.ts");
const menu = read("components/PackagesRightMenu.tsx");
const installerEnv = read("lib/termux-installer-env.ts");
const aptHelper = read("lib/termux-apt-install.ts");
const ndkStart = compilePackages.indexOf('id: "android-ndk"');
const gradleStart = compilePackages.indexOf('id: "gradle"', ndkStart);
const ndkEntry = compilePackages.slice(ndkStart, gradleStart);
const ndkCheck = ndkEntry.match(/checkCmd:\s*`([^`]+)`/)?.[1];
assert.ok(ndkCheck, "NDK catalogue entry must define an installed check");
assert.match(ndkCheck, /\[ -x /, "NDK check must require executable ndk-build");
const ndkFixture = fs.mkdtempSync(path.join(os.tmpdir(), "aib-ndk-check-"));
try {
  const ndkBuild = path.join(ndkFixture, "opt/android-ndk/ndk-build");
  fs.mkdirSync(path.dirname(ndkBuild), { recursive: true });
  fs.writeFileSync(ndkBuild, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
  const nonExecutable = spawnSync("bash", ["-c", `PREFIX=${JSON.stringify(ndkFixture)}; ${ndkCheck}`], { encoding: "utf8" });
  assert.notEqual(nonExecutable.status, 0, "stale non-executable ndk-build must not count as installed");
  fs.chmodSync(ndkBuild, 0o755);
  const executable = spawnSync("bash", ["-c", `PREFIX=${JSON.stringify(ndkFixture)}; ${ndkCheck}`], { encoding: "utf8" });
  assert.equal(executable.status, 0, "an executable ndk-build at the canonical prefix path is installed");
} finally {
  fs.rmSync(ndkFixture, { recursive: true, force: true });
}
assert.match(compilePackages, /checkPackageCommand/);
assert.match(compilePackages, /onResult: \(id, check\) => onUpdate\?\.\(id, check\)/);
assert.doesNotMatch(compilePackages, /TERMUX_MIRROR_REPAIR/);
const installPathStart = compilePackages.indexOf("export async function installCompilePackage");
const mirrorRetryStart = compilePackages.indexOf("isPkgMirrorFailure(installResult)", installPathStart);
assert.ok(installPathStart >= 0 && mirrorRetryStart > installPathStart);
assert.doesNotMatch(compilePackages.slice(installPathStart, mirrorRetryStart), /apt-get update/i);
assert.match(menu, /check\.status === "error"/);
assert.match(menu, /status: "error"/);
assert.match(aptHelper, /at most one temporary, authenticated Termux-main retry/);
assert.match(aptHelper, /aib_transient_mirror_unavailable/);
assert.match(aptHelper, /TERMUX_TRUSTED_FALLBACK_URL = "https:\/\/packages\.termux\.dev\/apt\/termux-main"/);
assert.match(installerEnv, /AI_BUILDER_LINUX_INSTALLER_ENV =[\s\S]*?androidSdkRootEnvironment\(\)/, "Linux installs must resolve one SDK root before sdkmanager routes");
for (const { input, expected } of [
  { input: { ANDROID_HOME: "", ANDROID_SDK_ROOT: "/custom/guest/sdk" }, expected: "/custom/guest/sdk|/custom/guest/sdk" },
  { input: { ANDROID_HOME: "", ANDROID_SDK_ROOT: "" }, expected: "/isolated/prefix/opt/android-sdk|/isolated/prefix/opt/android-sdk" },
]) {
  const envCommand = `PREFIX="\${PREFIX:-/root/.aibuilder-prefix}"; export PREFIX; ${androidSdkRootEnvironment()} printf "%s|%s\\n" "$ANDROID_HOME" "$ANDROID_SDK_ROOT"`;
  const result = spawnSync("bash", ["-c", envCommand], {
    encoding: "utf8",
    env: { ...process.env, PREFIX: "/isolated/prefix", ...input },
  });
  assert.equal(result.status, 0, `Linux SDK install environment failed: ${result.stderr}`);
  assert.equal(result.stdout.trim(), expected, "Linux package installs use the same explicit/default SDK root as checks and removals");
}

// Regression: the guide search is above the collapsed compilation menu and
// searches all compile entries, not just items rendered after opening it.
const guide = read("app/commands-guide.tsx");
const searchInputAt = guide.indexOf("<TextInput");
const compileSectionAt = guide.indexOf("styles.compileSection");
assert.ok(searchInputAt >= 0 && compileSectionAt > searchInputAt, "search input must precede the collapsible compilation section");
assert.match(guide, /buildCompileGuideRows\(COMPILE_PACKAGES, backend, lang\)/, "guide rows must be built from the complete compilation catalog");
assert.match(guide, /showCompileSearchResults = searchActive && compileMatches\.length > 0 && !compileExpanded/);
assert.match(guide, /compileMatches\.map\(renderCompileGuideCard\)/, "collapsed compilation matches must be visible as separate search results");
assert.match(guide, /visibleCompileRows\s*=\s*searchActive\s*\?\s*compileMatches/);

function catalogIds(source, exportName) {
  const start = source.indexOf(`export const ${exportName}:`);
  assert.ok(start >= 0, `catalog export not found: ${exportName}`);
  const end = source.indexOf("\n];", start);
  assert.ok(end > start, `catalog end not found: ${exportName}`);
  return [...source.slice(start, end).matchAll(/\bid:\s*"([^"]+)"/g)].map((match) => match[1]);
}

const compileIds = catalogIds(compilePackages, "COMPILE_PACKAGES");
const reversePackages = read("lib/reverse-packages.ts");
const reverseIds = catalogIds(reversePackages, "REVERSE_PACKAGES");
assert.equal(compileIds.length, 34, "compilation catalog must keep all 34 cards");
assert.equal(reverseIds.length, 19, "reverse catalog must keep all 19 cards");
assert.equal(compileIds.length + reverseIds.length, 53, "full installation catalog must contain 53 cards");
assert.equal(new Set(compileIds).size, compileIds.length, "compilation card ids must be unique");
assert.equal(new Set(reverseIds).size, reverseIds.length, "reverse card ids must be unique");
assert.deepEqual([...Object.keys(COMPILE_GUIDE_RULES)].sort(), [...compileIds].sort(), "each compile card id must have exactly one concise guide route");

const guidePackages = compileIds.map((id) => ({ id, name: id, nameEn: id }));
const termuxRows = buildCompileGuideRows(guidePackages, "termux", "ru");
const ubuntuRows = buildCompileGuideRows(guidePackages, "ubuntu-proot", "ru");
const debianRows = buildCompileGuideRows(guidePackages, "ubuntu-proot", "ru");
assert.equal(termuxRows.length, 34);
assert.equal(ubuntuRows.length, 34);
assert.equal(debianRows.length, 34);

const expectedTermuxCommands = {
  wget: "pkg install -y wget",
  curl: "pkg install -y curl",
  "zip-unzip": "pkg install -y zip unzip",
  git: "pkg install -y git",
  "openjdk-17": "pkg install -y openjdk-21",
  "build-essential": "pkg install -y build-essential",
  clang: "pkg install -y clang",
  make: "pkg install -y make",
  cmake: "pkg install -y cmake",
  "android-sdk": null,
  "android-ndk": null,
  gradle: "pkg install -y gradle",
  ant: "pkg install -y ant",
  maven: "pkg install -y maven",
  nano: "pkg install -y nano",
  vim: "pkg install -y vim",
  nodejs: "pkg install -y nodejs-lts",
  npm: "pkg install -y nodejs-lts",
  pnpm: "npm install -g pnpm",
  kotlin: "pkg install -y kotlin",
  python: "pkg install -y python",
  "termux-api": "pkg install -y termux-api",
  aapt2: "pkg install -y aapt2",
  zipalign: 'sdkmanager "build-tools;35.0.0"',
  apksigner: "pkg install -y apksigner",
  "platform-tools": "pkg install -y android-tools",
  which: "pkg install -y which",
  ninja: "pkg install -y ninja",
  "sdk-cmdline-tools": null,
  "android-platform-34": 'sdkmanager "platforms;android-34"',
  "android-platform-35": 'sdkmanager "platforms;android-35"',
  "proot-distro": "pkg install -y proot-distro",
  "debian-rootfs": null,
  "ubuntu-rootfs": null,
};

const expectedProotCommands = {
  wget: "apt-get update && apt-get install -y wget",
  curl: "apt-get update && apt-get install -y curl",
  "zip-unzip": "apt-get update && apt-get install -y zip unzip",
  git: "apt-get update && apt-get install -y git",
  "openjdk-17": "apt-get update && apt-get install -y openjdk-17-jdk",
  "build-essential": "apt-get update && apt-get install -y build-essential",
  clang: "apt-get update && apt-get install -y clang",
  make: "apt-get update && apt-get install -y make",
  cmake: "apt-get update && apt-get install -y cmake",
  "android-sdk": 'apt-get update && apt-get install -y adb unzip wget curl && sdkmanager "build-tools;35.0.0"',
  "android-ndk": null,
  gradle: "apt-get update && apt-get install -y gradle",
  ant: "apt-get update && apt-get install -y ant",
  maven: "apt-get update && apt-get install -y maven",
  nano: "apt-get update && apt-get install -y nano",
  vim: "apt-get update && apt-get install -y vim",
  nodejs: "apt-get update && apt-get install -y nodejs",
  npm: "apt-get update && apt-get install -y nodejs",
  pnpm: "npm install -g pnpm",
  kotlin: "apt-get update && apt-get install -y kotlin",
  python: "apt-get update && apt-get install -y python3",
  "termux-api": "pkg install -y termux-api",
  aapt2: 'sdkmanager "build-tools;35.0.0"',
  zipalign: 'sdkmanager "build-tools;35.0.0"',
  apksigner: 'sdkmanager "build-tools;35.0.0"',
  "platform-tools": "apt-get update && apt-get install -y adb",
  which: "apt-get update && apt-get install -y which",
  ninja: "apt-get update && apt-get install -y ninja-build",
  "sdk-cmdline-tools": null,
  "android-platform-34": 'sdkmanager "platforms;android-34"',
  "android-platform-35": 'sdkmanager "platforms;android-35"',
  "proot-distro": "pkg install -y proot-distro",
  "debian-rootfs": null,
  "ubuntu-rootfs": null,
};

for (const id of compileIds) {
  assert.equal(getCompileGuideInstruction(id, "termux", "ru").command, expectedTermuxCommands[id], `Termux route mismatch: ${id}`);
  for (const backend of ["ubuntu-proot", "ubuntu-proot"]) {
    const result = getCompileGuideInstruction(id, backend, "ru");
    assert.equal(result.command, expectedProotCommands[id], `${backend} route mismatch: ${id}`);
    assert.equal(result.target, packageBackendTarget(backend, id), `${backend} selected a different install target: ${id}`);
  }
}
assert.equal(getCompileGuideInstruction("openjdk-17", "termux", "ru").actualPackage, "openjdk-21");
assert.equal(getCompileGuideInstruction("openjdk-17", "ubuntu-proot", "ru").actualPackage, "openjdk-17-jdk");
assert.equal(getCompileGuideInstruction("platform-tools", "ubuntu-proot", "ru").actualPackage, "adb");
assert.equal(getCompileGuideInstruction("platform-tools", "termux", "ru").actualPackage, "android-tools");
assert.equal(getCompileGuideInstruction("android-ndk", "ubuntu-proot", "ru").kind, "unsupported");
assert.equal(getCompileGuideInstruction("termux-api", "ubuntu-proot", "ru").target, "termux", "Termux API remains a host-only package");
assert.equal(getCompileGuideInstruction("debian-rootfs", "ubuntu-proot", "ru").target, "termux", "rootfs provisioning remains a Termux-host action");
assert.equal(getCompileGuideInstruction("android-sdk", "termux", "ru").kind, "setup");
assert.equal(getCompileGuideInstruction("sdk-cmdline-tools", "termux", "ru").kind, "artifact");

// Search covers title, description and command even when the collapsed menu is
// not expanded. Separate results appear for a match; an expanded menu is filtered.
assert.ok(filterCompileGuideRows(termuxRows, "gradle").some((row) => row.source.id === "gradle"), "search should match title/id");
assert.ok(filterCompileGuideRows(ubuntuRows, "ninja-build").some((row) => row.source.id === "ninja"), "search should match actual package name in the description");
assert.ok(filterCompileGuideRows(termuxRows, "pkg install -y cmake").some((row) => row.source.id === "cmake"), "search should match the command");
assert.ok(filterCompileGuideRows(termuxRows, "sha-256").some((row) => row.source.id === "android-ndk"), "search should match artifact route description");
assert.match(guide, /showCompileSearchResults = searchActive && compileMatches\.length > 0 && !compileExpanded/, "collapsed menu must have a visible search-results path");
assert.match(guide, /compileExpanded && \(/, "the ordinary menu remains collapsed by default");
assert.match(guide, /visibleCompileRows\s*=\s*searchActive\s*\?\s*compileMatches\s*:/, "opening the menu during search must show only matching compile items");
for (const row of [...termuxRows, ...ubuntuRows]) {
  assert.doesNotMatch(row.instruction.command ?? "", /set\s+\+e|bash\s+-c|bootstrap-helper/i, `guide must not expose internal script for ${row.source.id}`);
}

// Verify reverse-card ids remain separate from the actual package names/routes.
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
    if (source[end] === "\\") { end++; continue; }
    if (source[end] === quote) break;
  }
  assert.ok(end < source.length, `unterminated ${field} literal for ${id}`);
  return Function(`"use strict"; return (${source.slice(start, end + 1)});`)();
}

const expectedReversePackages = {
  openssl: "openssl openssl-tool",
  binutils: "binutils",
  "android-tools": "android-tools",
  aapt: "aapt",
  aapt2: "aapt2",
  zipalign: "zipalign",
  apksigner: "apksigner",
  smali: null,
  jadx: "jadx",
  radare2: "radare2",
  strace: "strace",
  ltrace: "ltrace",
  gdb: "gdb",
  "frida-tools": "root-repo frida",
  capstone: "capstone",
  androguard: null,
  apkleaks: null,
  objection: null,
  mitmproxy: null,
};
for (const id of reverseIds) {
  const installCmd = fieldLiteral(reversePackages, id, "installCmd");
  const defAt = reversePackages.indexOf(`id: "${id}"`);
  const blockAt = reversePackages.indexOf("blocked: true", defAt);
  const nextDefAt = reversePackages.indexOf("id: \"", defAt + 5);
  const blocked = blockAt >= 0 && (nextDefAt < 0 || blockAt < nextDefAt);
  if (expectedReversePackages[id] === null) {
    assert.equal(blocked, true, `${id} must remain blocked rather than display an unpinned install command`);
    continue;
  }
  const expectedNames = expectedReversePackages[id].split(" ");
  assert.ok(expectedNames.every((name) => installCmd.includes(name)), `${id} source must use actual package/artifact name(s): ${expectedNames.join(", ")}`);
  const target = packageBackendTarget("ubuntu-proot", id);
  if (id === "frida-tools") assert.equal(target, "termux", "Frida is installed on the Termux host");
  const routed = adaptPackageCommandForBackend(installCmd, "install", target);
  if (id === "android-tools") assert.match(routed, /apt-get install -y adb/, "the proot package is adb, not the card id android-tools");
  if (["aapt", "aapt2", "zipalign", "apksigner"].includes(id)) assert.match(routed, /sdkmanager/, `${id} must route through Android SDK Manager in proot`);
  if (id === "frida-tools") assert.match(routed, /pkg install -y frida/, "Frida is installed in Termux, not proot");
}

console.log("AIB_COMPILE_PACKAGE_CHECK_SELFTEST_OK installed=1 missing=1 permission_error=1 timeout_error=1 mirror_error=1 guide_order=ok hidden_search=ok catalog_cards=53 package_routes=ok");
