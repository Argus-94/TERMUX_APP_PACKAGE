#!/usr/bin/env node
// Run with: node --experimental-strip-types scripts/aib-termux-apt-install-regression-selftest.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  TERMUX_REPO_PREFLIGHT,
  isPkgMirrorFailure,
  wrapTermuxAptInstallWithUpdate,
} from "../lib/termux-apt-install.ts";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourceText = "# fixture: user-selected Termux source\ndeb https://example.invalid/termux-main stable main\n";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aib-termux-apt-gate-"));
try {
  const prefix = path.join(dir, "prefix");
  const bin = path.join(dir, "bin");
  const sources = path.join(prefix, "etc", "apt", "sources.list");
  const aptLog = path.join(dir, "apt-calls.log");
  const marker = path.join(dir, "forbidden-install-body-ran");
  fs.mkdirSync(path.dirname(sources), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(sources, sourceText);
  for (const executable of ["apt", "apt-get", "pkg", "dpkg"]) {
    fs.writeFileSync(path.join(bin, executable), "#!/bin/sh\nprintf '%s\\n' \"$0 $*\" >> \"$APT_LOG\"\nexit 99\n", { mode: 0o755 });
  }

  const command = `touch ${marker}; apt-get update && apt-get install -y fixture-package`;
  const wrapped = wrapTermuxAptInstallWithUpdate(command, true);
  const result = spawnSync("bash", ["-c", wrapped], {
    encoding: "utf8",
    env: { ...process.env, PREFIX: prefix, PATH: `${bin}:${process.env.PATH || ""}`, APT_LOG: aptLog },
  });

  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 78, `${result.stdout || ""}\n${result.stderr || ""}`);
  assert.match(`${result.stdout || ""}\n${result.stderr || ""}`, /AIB_PRIVATE_PACKAGE_FEED_NOT_QUALIFIED/);
  assert.match(result.stdout, /AIB_PKG_UPDATE_EXIT:78/);
  assert.match(result.stdout, /AIB_PKG_INSTALL_EXIT:78/);
  assert.match(result.stdout, /PKG_EXIT:78/);
  assert.equal(fs.existsSync(aptLog), false, "the typed refusal must not launch apt, apt-get, pkg, or dpkg");
  assert.equal(fs.existsSync(marker), false, "the supplied install body must never run");
  assert.equal(fs.readFileSync(sources, "utf8"), sourceText, "a user-selected source must remain unchanged");
  assert.equal(fs.existsSync(path.join(prefix, "var", "lib", "apt", "lists")), false, "the refusal must not create APT list directories");

  for (const wrappedCall of [
    wrapTermuxAptInstallWithUpdate("apt-get install -y fixture-package"),
    TERMUX_REPO_PREFLIGHT,
  ]) {
    assert.match(wrappedCall, /AIB_PRIVATE_PACKAGE_FEED_NOT_QUALIFIED/);
    assert.match(wrappedCall, /exit 78/);
    assert.doesNotMatch(wrappedCall, /apt-get update|apt-get install|dpkg --configure|fixture-package/);
  }
  assert.equal(isPkgMirrorFailure({ exitCode: 100, stderr: "HTTP 404 while fetching Packages" }), false);
  assert.equal(isPkgMirrorFailure({ exitCode: 37, stderr: "mirror failure" }), false);

  const installerEnv = fs.readFileSync(path.join(root, "lib/termux-installer-env.ts"), "utf8");
  assert.match(installerEnv, /export function wrapAptInstallWithUpdate\([^)]*\): string \{[\s\S]*?return wrapTermuxAptInstallWithUpdate\(/);
  const testScript = fs.readFileSync(path.join(root, "scripts/aib-pre-release.mjs"), "utf8");
  assert.match(testScript, /aib-termux-apt-install-regression-selftest\.mjs/);
  console.log("AIB_TERMUX_APT_INSTALL_REGRESSION_OK feed_gate=typed_exit_78 apt_network_calls=0 install_body=0 sources_preserved=1 mirror_retry=0");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
