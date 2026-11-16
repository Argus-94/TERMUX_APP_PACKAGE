#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { typescript } from "./test-helpers/load-typescript.mjs";
const __AIB_VER = (await import("node:fs")).readFileSync(new URL("../core/runtime/RuntimeIdentity.ts", import.meta.url), "utf8").match(/appVersion: "([^"]+)"/)[1]; // v407: single source of truth (RuntimeIdentity == package.json)

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const cache = new Map();
function resolveTs(parent, request) {
  const base = path.resolve(path.dirname(parent), request);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}
function loadTs(file) {
  file = path.resolve(file);
  if (cache.has(file)) return cache.get(file).exports;
  const mod = new Module(file);
  mod.filename = file;
  mod.paths = Module._nodeModulePaths(path.dirname(file));
  cache.set(file, mod);
  mod.require = (request) => {
    const resolved = request.startsWith(".") ? resolveTs(file, request) : null;
    return resolved ? loadTs(resolved) : createRequire(file)(request);
  };
  const output = typescript.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: file,
  }).outputText;
  mod._compile(output, file);
  return mod.exports;
}

const { buildProotDistroInstallCommand } = loadTs(path.join(root, "lib/proot-distro-state.ts"));
const { buildTermuxProotDistroInstallCommand } = loadTs(path.join(root, "lib/termux-bootstrap-install.ts"));
const installer = buildTermuxProotDistroInstallCommand();
const runtime = fs.readFileSync(path.join(root, "app/runtime.tsx"), "utf8");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const identity = JSON.parse(fs.readFileSync(path.join(root, "AI_BUILDER_ANDROID_IDENTITY.json"), "utf8"));

assert.match(installer, /apt-get install -y proot-distro/);
assert.doesNotMatch(installer, /apt-get install -y proot-distro[=:@][0-9]/, "Termux package version is not pinned by the app source");
assert.doesNotMatch(installer, /proot-distro[^\n]{0,80}(sha256|sha512|checksum|digest|signature)/i);
assert.equal(packageJson.version, __AIB_VER, "source-only patch preserves the app build version");
assert.equal(identity.applicationId, "com.karat.aibuilder");
assert.equal(identity.namespace, "com.karat.aibuilder");

for (const alias of ["debian", "ubuntu"]) {
  const command = buildProotDistroInstallCommand(alias);
  assert.match(command, new RegExp(`proot-distro install ${alias} >`), `${alias} uses only its selected proot-distro alias`);
  assert.doesNotMatch(command, /https?:\/\//i, "AI Builder supplies no rootfs URL or mirror override");
  assert.doesNotMatch(command, /sha256|sha512|checksum|digest|signature|--mirror|--url/i,
    "AI Builder contains no rootfs artifact integrity metadata or fallback parameter");
  assert.doesNotMatch(command, new RegExp(`proot-distro install ${alias === "debian" ? "ubuntu" : "debian"}`),
    "failure cannot silently substitute Debian for Ubuntu or Ubuntu for Debian");
}
assert.throws(() => buildProotDistroInstallCommand("kali"), /PROOT_DISTRO_ALIAS_NOT_ALLOWED/);
assert.match(runtime, /installProotDistroRootfsWithPrerequisite\(distro, run, onProgress, shouldAbort\)/,
  "runtime uses the selected alias's guarded host installer and has no separate app-owned downloader");
assert.doesNotMatch(runtime, /proot-distro install (?:https?:\/\/|[A-Za-z0-9_.-]+:[0-9])/,
  "runtime UI cannot inject a remote image reference or version tag");
assert.doesNotMatch(runtime, /const onInstallProotDistro\s*=|const onLinuxBootstrap\s*=|ensureRootfs\("ubuntu"\)/,
  "no separate runtime-screen installer/bootstrap path may bypass the selected Install action");

console.log("AIB_V275_ROOTFS_DOWNLOADER_AUDIT_SELFTEST_OK package-unpinned=1 url-digest-verification=not-in-source alias-preserved=debian,ubuntu silent-switch=blocked fallback=fail-closed");
