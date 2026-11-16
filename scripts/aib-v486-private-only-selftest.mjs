#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { typescript as ts } from "./test-helpers/load-typescript.mjs";
import { guardTermuxCommand, guardTermuxCommandStrict } from "../lib/termux-guard.ts";
import { setAgentCatastrophicFloor, setAgentUnrestrictedShell, catastrophicCommandReason, isAgentUnrestrictedShell } from "../lib/agent-unrestricted.ts";
import { TERMUX_MIRROR_REPAIR, TERMUX_REPO_PREFLIGHT, wrapTermuxAptInstallWithUpdate, isPkgMirrorFailure } from "../lib/termux-apt-install.ts";

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aib-v486-private-only-"));
let checks = 0;
function loadTs(file, stubs = {}) {
  const module = { exports: {} };
  const js = ts.transpile(read(file), { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 });
  vm.runInNewContext(`(function(require,module,exports){${js}\n})`, {}, { filename: file })(
    (id) => { if (Object.hasOwn(stubs, id)) return stubs[id]; throw new Error(`Unexpected dependency ${id}`); }, module, module.exports,
  );
  return module.exports;
}
try {
  setAgentUnrestrictedShell(true);
  setAgentCatastrophicFloor(false);
  for (const foreign of ["/data/data/com.termux/files/home/a", "/data/user/0/com.termux/files/usr/bin/bash", "/data/data/com.some.other/files/a", "/data/user_de/0/com.termux/files/private"]) {
    for (const command of [`cat ${foreign}`, `rm -rf ${foreign}`, `PREFIX=${foreign}; echo ok`]) {
      assert.equal(guardTermuxCommand(command, { allowDangerous: true }).ok, false, command);
      assert.equal(guardTermuxCommandStrict(command, { allowDangerous: true }).ok, false, command);
      checks += 2;
    }
  }
  assert.equal(guardTermuxCommand("printf private-ok").ok, true);
  const { evaluateCommandPolicy } = loadTs("lib/security-policy.ts", {
    "./persistent-logger": { persistentLogger: { add() {} } },
    "./agent-unrestricted.ts": { catastrophicCommandReason, isAgentUnrestrictedShell },
  });
  for (const channel of ["termux", "shizuku", "adb", "plugin"]) {
    assert.equal(evaluateCommandPolicy("cat /data/data/com.termux/files/home/a", channel, { interactive: true }).ok, false);
    checks++;
  }
  const marker = path.join(temp, "INSTALL_BODY_MUST_NOT_RUN");
  for (const script of [TERMUX_REPO_PREFLIGHT, TERMUX_MIRROR_REPAIR, wrapTermuxAptInstallWithUpdate(`touch '${marker}'`, true)]) {
    const result = spawnSync("bash", ["-c", script], { encoding: "utf8", cwd: temp });
    assert.equal(result.status, 78);
    assert.match(result.stderr, /AIB_PRIVATE_PACKAGE_FEED_NOT_QUALIFIED/);
    assert.equal(fs.existsSync(marker), false);
    checks++;
  }
  assert.equal(isPkgMirrorFailure({ exitCode: 100, stderr: "Failed to fetch: Connection timed out" }), false);
  for (const name of fs.readdirSync(path.join(root, "scripts/repair")).filter((name) => name.endsWith(".sh"))) {
    const source = read(`scripts/repair/${name}`);
    assert.match(source.split("\n")[0], /^#!\/data\/data\/com\.karat\.aibuilder\/files\/usr\/bin\/bash$/);
    for (const prefix of ["/data/data/com.termux/files/usr", "", "/tmp/foreign-prefix"]) {
      const result = spawnSync("bash", [path.join(root, "scripts/repair", name)], {
        encoding: "utf8", cwd: temp,
        env: { ...process.env, HOME: temp, PREFIX: prefix },
      });
      assert.equal(result.status, 78, name);
      assert.match(result.stderr, /AIB_PRIVATE_RUNTIME_REQUIRED/, name);
      checks++;
    }
  }
  assert.deepEqual(fs.readdirSync(temp), [], "blocked scripts must not write into the caller's HOME/cwd");
  const native = read("plugins/withTermuxBridge.js");
  assert.doesNotMatch(native, /getPackageInfo\("com\.termux"|Intent\("com\.termux\.RUN_COMMAND"|com\.termux\.permission\.RUN_COMMAND/);
  assert.match(native, /runEmbeddedTermuxCommand\(command, workdir, timeoutMs, requestId, promise\)/);
  const accel = read("plugins/withAibNativeAccel.js");
  assert.match(accel, /bridge\.runEmbeddedTermuxCommand\(command/);
  assert.doesNotMatch(accel, /ProcessBuilder\("sh"/);
  assert.doesNotMatch(read("scripts/aib-android-e2e.mjs"), /"pm", "path", "com\.termux"/);
  assert.doesNotMatch(read("scripts/autobuild/aib-autobuild.sh"), /termux-ndk\/releases|Pkg\.Revision = \$req/);
  assert.doesNotMatch(read("lib/compile-packages.ts"), /termux-ndk\/releases/);
  const { discoverAndroidSdk } = loadTs("core/toolchain/AndroidSdkDiscovery.ts", {
    "./ToolchainManifest": { createToolchainManifest: (manifest) => manifest },
  });
  const probed = [];
  await discoverAndroidSdk({ exists: (candidate) => { probed.push(candidate); return false; } }, {
    homeSdkPath: "/data/data/com.termux/files/home/android-sdk",
    extraCandidates: ["/data/user/0/com.termux/files/usr/opt/android-sdk"],
  });
  assert.equal(probed.some((candidate) => candidate.includes("com.termux")), false, "foreign SDK candidates must be rejected before probing");
  checks += 11;
  console.log(`AIB_V486_PRIVATE_ONLY_SELFTEST_OK checks=${checks} foreign-paths=denied repair-io=blocked apt-body=not-executed stock-ndk=removed native-routing=private-only evidence=source-and-hermetic`);
} finally {
  setAgentCatastrophicFloor(true);
  setAgentUnrestrictedShell(true);
  fs.rmSync(temp, { recursive: true, force: true });
}
