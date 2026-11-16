#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const ts = createRequire(import.meta.url)("typescript");
const source = fs.readFileSync(path.join(root, "lib/termux-installer-env.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const apt = {
  TERMUX_REPO_PREFLIGHT: "PREFLIGHT;",
  TERMUX_MIRROR_REPAIR: "REPAIR;",
  isPkgMirrorFailure: (result) => /mirror/i.test(`${result.stdout || ""} ${result.stderr || ""}`),
  wrapTermuxAptInstallWithUpdate: (command) => command,
};
const mod = { exports: {} };
const mockRequire = (name) => {
  if (name === "./agent-shell-backend") return { isLinuxProotBackend: () => false };
  if (name === "./package-command-routing") return {
    adaptTermuxPackageCommand: (command) => command,
    androidSdkRootEnvironment: () => 'ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$PREFIX/opt/android-sdk}}"; ANDROID_SDK_ROOT="$ANDROID_HOME"; export ANDROID_HOME ANDROID_SDK_ROOT; ',
  };
  if (name === "./termux-apt-install") return apt;
  throw new Error(`unexpected import: ${name}`);
};
vm.runInNewContext(compiled, { require: mockRequire, module: mod, exports: mod.exports });

assert.equal(mod.exports.isPkgMirrorFailure, apt.isPkgMirrorFailure, "expected public re-export");
assert.equal(await mod.exports.ensureTermuxMirrorsReady(async (command) => {
  assert.equal(command, "PREFLIGHT;REPAIR;");
  return { exitCode: 100, stderr: "E: no mirror selected" };
}), false);
assert.equal(await mod.exports.ensureTermuxMirrorsReady(async () => ({ exitCode: 0, stdout: "AIB_MIRROR_REPAIR_DONE upd=0" })), true);
assert.equal(await mod.exports.ensureTermuxMirrorsReady(async () => ({ exitCode: 0, stderr: "ready" })), true);
console.log("AIB_TERMUX_INSTALLER_ENV_BINDING_OK mirror_failure=bound fail_closed=verified success=verified");
