#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { wrapTermuxAptInstallWithUpdate } from "../lib/termux-apt-install.ts";
import {
  buildTermuxProotDistroInstallCommand,
  buildTermuxToolsBaseInstallCommand,
} from "../lib/termux-bootstrap-install.ts";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const trustedUrl = "https://packages.termux.dev/apt/termux-main";
const configuredUrl = "https://mirror.test/apt/termux-main";

function writeExecutable(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, { mode: 0o755 });
}

function snapshotTree(dir) {
  const values = new Map();
  const walk = (current) => {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else values.set(path.relative(dir, full), fs.readFileSync(full));
    }
  };
  walk(dir);
  return [...values.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function createFixture({ updateMode = "transient", fallbackMode = "success", installMode = "success", configuredMirror = configuredUrl, extraSources = false, extraDeb822 = false, aptConfigOverride = false, aptConfOverride = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aib-termux-mirror-fallback-"));
  const prefix = path.join(dir, "termux-prefix");
  const bin = path.join(dir, "fake-bin");
  const sourceDir = path.join(prefix, "etc", "apt");
  const sources = path.join(sourceDir, "sources.list");
  const calls = path.join(dir, "apt-calls.log");
  const pkgCalls = path.join(dir, "pkg-calls.log");
  fs.mkdirSync(path.join(prefix, "etc", "termux"), { recursive: true });
  fs.mkdirSync(path.join(sourceDir, "sources.list.d"), { recursive: true });
  fs.mkdirSync(path.join(prefix, "var", "lib", "apt", "lists"), { recursive: true });
  fs.mkdirSync(path.join(prefix, "tmp"), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  const configuredSource = `deb ${configuredMirror} stable main\n`;
  fs.writeFileSync(sources, configuredSource);
  fs.writeFileSync(path.join(prefix, "etc", "termux", "chosen_mirrors"), `${configuredMirror}\n`);
  if (extraSources) {
    fs.writeFileSync(path.join(sourceDir, "sources.list.d", "extra.list"), "deb https://extra.test/apt/termux-main stable main\n");
  }
  if (extraDeb822) {
    fs.writeFileSync(path.join(sourceDir, "sources.list.d", "extra.sources"), "Types: deb\nURIs: https://extra.test/apt/termux-main\nSuites: stable\nComponents: main\n");
  }
  if (aptConfOverride) {
    fs.writeFileSync(path.join(sourceDir, "apt.conf"), 'Dir::Etc::sourcelist "/custom/sources.list";\n');
  }

  writeExecutable(path.join(bin, "apt-get"), `#!/bin/sh
set -u
printf '%s\\t%s\\n' "\${APT_CONFIG-}" "$*" >> "$APT_CALLS"
if [ "\${1:-}" = update ]; then
case "\${APT_CONFIG-}" in
  "$PREFIX"/tmp/aib-termux-apt.*/fallback/apt.conf)
    CONF="\${APT_CONFIG}"
    [ -f "$CONF" ] || { echo 'fixture: missing temporary APT_CONFIG' >&2; exit 91; }
    SOURCE_FILE=$(sed -n -E 's/^Dir::Etc::sourcelist "([^"]+)";.*/\\1/p' "$CONF")
    LISTS_DIR=$(sed -n -E 's/.*Dir::State::lists "([^"]+)";.*/\\1/p' "$CONF")
    grep -Fq 'deb ${trustedUrl} stable main' "$SOURCE_FILE" || { echo 'fixture: wrong or untrusted fallback source' >&2; exit 92; }
    case "$FALLBACK_MODE" in
      success)
        mkdir -p "$LISTS_DIR"
        printf 'Package: fixture\\nVersion: 1\\n' > "$LISTS_DIR/official_Packages.lz4"
        echo 'fixture: official fallback update stdout'
        echo 'fixture: official fallback update stderr' >&2
        exit 0
        ;;
      unavailable)
        echo 'Err:1 ${trustedUrl} stable InRelease' >&2
        echo 'Failed to fetch ${trustedUrl}/dists/stable/InRelease 503 Service Unavailable' >&2
        exit 37
        ;;
      signature)
        echo 'Err:1 ${trustedUrl} stable InRelease' >&2
        echo 'W: GPG error: NO_PUBKEY fixture-key' >&2
        exit 100
        ;;
    esac
    ;;
esac
  case "$UPDATE_MODE" in
    transient)
      echo 'Err:1 ${configuredMirror} stable InRelease' >&2
      echo "Failed to fetch ${configuredMirror}/dists/stable/InRelease Temporary failure resolving 'mirror.test'" >&2
      exit 100
      ;;
    timeout)
      echo 'Err:1 ${configuredMirror} stable InRelease' >&2
      echo "Failed to connect to mirror.test: Connection timed out" >&2
      exit 100
      ;;
    signature)
      echo 'Err:1 ${configuredMirror} stable InRelease' >&2
      echo 'W: GPG error: NO_PUBKEY configured-key' >&2
      exit 100
      ;;
    malformed)
      echo 'E: Malformed entry 1 in list file /fixture/sources.list' >&2
      exit 100
      ;;
    not-found)
      echo 'Err:1 ${configuredMirror} stable InRelease' >&2
      echo 'E: Failed to fetch ${configuredMirror}/dists/stable/InRelease 404  Not Found' >&2
      exit 100
      ;;
    temp-file)
      echo 'Err:1 ${configuredMirror} stable InRelease' >&2
      echo "E: Couldn't create temporary file /fixture/apt.conf for passing config to apt-key" >&2
      exit 100
      ;;
    permission)
      echo 'E: Permission denied while opening /fixture/lists/lock' >&2
      exit 13
      ;;
    disk)
      echo 'E: No space left on device' >&2
      exit 28
      ;;
    success)
      mkdir -p "$PREFIX/var/lib/apt/lists"
      printf 'Package: fixture\\nVersion: 1\\n' > "$PREFIX/var/lib/apt/lists/configured_Packages.lz4"
      echo 'fixture: configured update stdout'
      exit 0
      ;;
  esac
fi
case " $* " in
  *' -f install '*) echo 'fixture: repair run'; exit 0 ;;
esac
if [ "\${1:-}" = install ]; then
  case "$INSTALL_MODE" in
    package-not-found) echo 'E: Unable to locate package fixture-package' >&2; exit 100 ;;
    dependency-conflict) echo 'E: Unmet dependencies; unable to correct problems' >&2; exit 100 ;;
  esac
  echo 'fixture: package install succeeded'
  exit 0
fi
exit 0
`);
  writeExecutable(path.join(bin, "pkg"), `#!/bin/sh
printf '%s\\n' "$*" >> "$PKG_CALLS"
echo 'fixture error: raw pkg must not bypass the production apt wrapper' >&2
exit 96
`);
  writeExecutable(path.join(bin, "dpkg"), "#!/bin/sh\nexit 0\n");

  const env = {
    ...process.env,
    PREFIX: prefix,
    PATH: `${bin}:/usr/bin:/bin`,
    APT_CALLS: calls,
    PKG_CALLS: pkgCalls,
    UPDATE_MODE: updateMode,
    FALLBACK_MODE: fallbackMode,
    INSTALL_MODE: installMode,
  };
  delete env.APT_CONFIG;
  if (aptConfigOverride) {
    const customAptConfig = path.join(dir, "custom-apt.conf");
    fs.writeFileSync(customAptConfig, "// user-selected APT_CONFIG fixture\n");
    env.APT_CONFIG = customAptConfig;
  }
  return { dir, prefix, bin, sources, calls, pkgCalls, env, sourceDir };
}

function execute(fixture, command) {
  const result = spawnSync("bash", ["-c", command], {
    encoding: "utf8",
    env: fixture.env,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}

function runCase(options, command = wrapTermuxAptInstallWithUpdate("apt-get install -y fixture-package")) {
  const f = createFixture(options);
  const initialSources = snapshotTree(path.join(f.prefix, "etc", "apt"));
  try {
    const result = execute(f, command);
    assert.deepEqual(snapshotTree(path.join(f.prefix, "etc", "apt")), initialSources, "user APT source files changed");
    if (!fs.existsSync(f.calls)) {
      throw new Error(`fake apt-get was not reached (status=${result.status})\n${result.stdout}\n${result.stderr}\ncommand=${command}`);
    }
    const calls = fs.readFileSync(f.calls, "utf8");
    assert.deepEqual(
      fs.readdirSync(path.join(f.prefix, "tmp")).filter((name) => name.startsWith("aib-termux-apt.")),
      [],
      "temporary APT transaction directory was not removed on exit",
    );
    assert.equal(fs.existsSync(f.pkgCalls), false, "fake pkg was invoked by the apt transaction");
    return { f, result, calls, initialSources };
  } catch (error) {
    fs.rmSync(f.dir, { recursive: true, force: true });
    throw error;
  }
}

let cases = 0;
const cleanup = [];
try {
  // Primary chain: configured mirror first, official main exactly once on a
  // confirmed transport outage, then install under the isolated trusted config.
  {
    const { f, result, calls } = runCase(
      { updateMode: "transient", fallbackMode: "success" },
      buildTermuxToolsBaseInstallCommand(),
    );
    cleanup.push(f.dir);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const callLines = calls.trimEnd().split("\n");
    assert.equal(callLines.length, 3, `unexpected apt call sequence:\n${calls}`);
    assert.match(callLines[0], /^\tupdate /, "configured mirror must be attempted first");
    assert.match(callLines[1], /^.+\tupdate /, "trusted fallback update must be second");
    assert.match(callLines[2], /^.+\tinstall -y openjdk-17 unzip git wget curl$/, "install must use the temporary official apt context");
    const fallbackConfig = callLines[1].split("\t")[0];
    assert.ok(fallbackConfig.endsWith("/fallback/apt.conf"));
    assert.ok(!fs.existsSync(fallbackConfig), "fallback APT_CONFIG survived transaction cleanup");
    assert.match(result.stderr, /Temporary failure resolving/);
    assert.match(result.stderr, /official fallback update stderr/);
    assert.match(result.stdout, /AIB_APT_CONFIGURED_UPDATE_EXIT:100/);
    assert.match(result.stdout, /AIB_APT_FALLBACK_UPDATE_EXIT:0/);
    assert.match(result.stdout, /AIB_PKG_UPDATE_EXIT:0/);
    assert.match(result.stdout, /AIB_PKG_INSTALL_EXIT:0/);
    cases++;
  }

  // An already-selected official main endpoint is not retried against itself.
  {
    const { f, result, calls } = runCase({ updateMode: "transient", configuredMirror: trustedUrl });
    cleanup.push(f.dir);
    assert.equal(result.status, 100);
    assert.equal(calls.trimEnd().split("\n").length, 1, "official configured source must not be retried as fallback");
    cases++;
  }

  // The bootstrap proot-distro path also shares the production wrapper and marker contract.
  {
    const { f, result, calls } = runCase(
      { updateMode: "timeout", fallbackMode: "success" },
      buildTermuxProotDistroInstallCommand(),
    );
    cleanup.push(f.dir);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(calls, /^\tupdate /m);
    assert.equal((calls.match(/\tupdate /g) || []).length, 2, "exactly one trusted retry expected");
    assert.match(calls, /\tinstall -y proot-distro$/m);
    assert.match(result.stdout, /AIB_PKG_UPDATE_EXIT:0/);
    assert.match(result.stdout, /AIB_PKG_INSTALL_EXIT:0/);
    cases++;
  }

  // Do not switch for signature, source syntax, permission or storage failures.
  for (const [mode, expectedStatus, expectedError] of [
    ["signature", 100, "NO_PUBKEY configured-key"],
    ["malformed", 100, "Malformed entry"],
    ["not-found", 100, "404  Not Found"],
    ["temp-file", 100, "Couldn't create temporary file"],
    ["permission", 13, "Permission denied"],
    ["disk", 28, "No space left on device"],
  ]) {
    const { f, result, calls } = runCase({ updateMode: mode });
    cleanup.push(f.dir);
    assert.equal(result.status, expectedStatus, `${mode}: exact apt status changed`);
    assert.ok(result.stderr.includes(expectedError), `${mode}: stderr was not preserved: ${result.stderr}`);
    assert.equal(calls.trimEnd().split("\n").length, 1, `${mode}: unsafe fallback was attempted`);
    assert.match(calls, /^\tupdate /);
    cases++;
  }

  // A multi-source configuration is deliberately outside the fallback contract.
  {
    const { f, result, calls } = runCase({ updateMode: "transient", extraSources: true });
    cleanup.push(f.dir);
    assert.equal(result.status, 100);
    assert.equal(calls.trimEnd().split("\n").length, 1, "extra active sources must block fallback");
    cases++;
  }
  {
    const { f, result, calls } = runCase({ updateMode: "transient", extraDeb822: true });
    cleanup.push(f.dir);
    assert.equal(result.status, 100);
    assert.equal(calls.trimEnd().split("\n").length, 1, "active Deb822 source must block fallback");
    cases++;
  }
  for (const options of [{ aptConfigOverride: true }, { aptConfOverride: true }]) {
    const { f, result, calls } = runCase({ updateMode: "transient", ...options });
    cleanup.push(f.dir);
    assert.equal(result.status, 100);
    assert.equal(calls.trimEnd().split("\n").length, 1, "custom apt configuration must block fallback");
    cases++;
  }

  // If the trusted endpoint itself fails, report that exact status and stderr;
  // do not install, retry another mirror, or leave temporary files behind.
  {
    const { f, result, calls } = runCase({ updateMode: "transient", fallbackMode: "unavailable" });
    cleanup.push(f.dir);
    assert.equal(result.status, 37, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /Temporary failure resolving/);
    assert.match(result.stderr, /503 Service Unavailable/);
    assert.match(result.stdout, /AIB_APT_CONFIGURED_UPDATE_EXIT:100/);
    assert.match(result.stdout, /AIB_APT_FALLBACK_UPDATE_EXIT:37/);
    assert.doesNotMatch(calls, /\tinstall /, "install ran after fallback failure");
    assert.equal(calls.trimEnd().split("\n").length, 2, "fallback must be bounded to one retry");
    cases++;
  }

  // Package-not-found and dependency conflicts occur after a successful update;
  // they retain apt errors and must never initiate a mirror fallback.
  for (const [mode, error] of [
    ["package-not-found", "Unable to locate package fixture-package"],
    ["dependency-conflict", "Unmet dependencies"],
  ]) {
    const { f, result, calls } = runCase({ updateMode: "success", installMode: mode });
    cleanup.push(f.dir);
    assert.equal(result.status, 100, `${mode}: install status changed`);
    assert.ok(`${result.stdout}\n${result.stderr}`.includes(error), `${mode}: apt diagnostic lost`);
    assert.match(calls, /^\tupdate /m);
    assert.doesNotMatch(calls, /^.+\tupdate /m, `${mode}: unnecessary fallback update observed`);
    cases++;
  }

  // Text contract: the only hard-coded source is the HTTPS official Termux main
  // endpoint and the temporary apt config never relaxes signature verification.
  const source = fs.readFileSync(path.join(root, "lib/termux-apt-install.ts"), "utf8");
  assert.equal((source.match(/https:\/\/packages\.termux\.dev\/apt\/termux-main/g) || []).length, 1);
  assert.doesNotMatch(source, /AllowUnauthenticated\s*(?:=|"?true)|AllowInsecureRepositories\s*(?:=|"?true)/i);
  assert.match(source, /Dir::Etc::sourcelist/);
  assert.match(source, /Dir::Etc::sourceparts/);
  assert.match(source, /Dir::State::lists/);
  assert.match(source, /aib_cleanup_apt_transaction/);
  cases++;
} finally {
  for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`AIB_TERMUX_MIRROR_FALLBACK_SELFTEST_OK cases=${cases} configured_first=1 official_retry_once=1 signature_checks=preserved stdout_stderr_exit=preserved sources_unchanged=1 cleanup=1 fake_apt_pkg_only=1`);
