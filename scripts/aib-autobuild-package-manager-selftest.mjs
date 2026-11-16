#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const source = fs.readFileSync(path.join(root, "scripts/autobuild/aib-autobuild.sh"), "utf8");
const start = source.indexOf("# ---------- package manager ----------");
const end = source.indexOf("aib_ab_net_ok()", start);
assert.ok(start >= 0 && end > start, "package-manager adapter section must exist");
const adapter = source.slice(start, end);

function runAdapter(backend, failFirstInstall = false) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aib-autobuild-pm-"));
  try {
    const bin = path.join(temp, "bin");
    fs.mkdirSync(bin);
    const calls = path.join(temp, "calls.log");
    const marker = path.join(temp, "failed-once");
    const stub = (name, body) => {
      const file = path.join(bin, name);
      fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
      fs.chmodSync(file, 0o755);
    };
    const callLogBody = [
      'printf "%s" "' + backend + ':' + (backend === "termux" ? "pkg" : "apt-get") + '" >> "$AIB_TEST_CALLS"',
      'for arg in "$@"; do printf ":%s" "$arg" >> "$AIB_TEST_CALLS"; done',
      'printf "\\n" >> "$AIB_TEST_CALLS"',
      'if [ "$1" = "install" ] && [ "${AIB_TEST_FAIL_FIRST_INSTALL:-0}" = "1" ] && [ ! -e "$AIB_TEST_MARKER" ]; then touch "$AIB_TEST_MARKER"; echo simulated-failure; exit 42; fi',
      'echo simulated-success',
      'exit 0',
    ].join("\n");
    stub("pkg", callLogBody);
    stub("apt-get", callLogBody);
    const script = `${adapter}\naib_ab_log() { :; }\naib_ab_pm_update\naib_ab_pm_install openjdk-17\n`;
    const result = spawnSync("bash", ["-c", script], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH || "/usr/bin:/bin"}`,
        AIB_AB_BACKEND: backend,
        AIB_TEST_CALLS: calls,
        AIB_TEST_MARKER: marker,
        AIB_TEST_FAIL_FIRST_INSTALL: failFirstInstall ? "1" : "0",
      },
      maxBuffer: 1024 * 1024,
    });
    assert.equal(result.status, 0, `${backend} package adapter should recover; stderr=${result.stderr}`);
    return fs.readFileSync(calls, "utf8").trim().split("\n");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

const termuxCalls = runAdapter("termux", true);
assert.deepEqual(termuxCalls, [
  "termux:pkg:update:-y",
  "termux:pkg:install:-y:openjdk-17",
  "termux:pkg:update:-y",
  "termux:pkg:install:-y:openjdk-17",
], "Termux must use pkg update/install and retry once after index refresh");

const ubuntuCalls = runAdapter("ubuntu-proot", false);
assert.deepEqual(ubuntuCalls, [
  "ubuntu-proot:apt-get:update:-y",
  "ubuntu-proot:apt-get:install:-y:--no-install-recommends:openjdk-17",
], "Ubuntu proot must retain apt-get update/install semantics");

console.log("AIB_AUTOBUILD_PACKAGE_MANAGER_SELFTEST_OK termux=pkg ubuntu=apt-get retry=modeled no-cross-backend-leak=1");
