#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadTs } from "./aib-interceptor-test-helper.mjs";

const {
  buildProotDistroInstallCommand,
  buildProotDistroProbeCommand,
  buildProotDistroRemoveGuardCommand,
  buildProotDistroRestoreCommand,
  classifyProotDistroPreflight,
  decideProotDistroInstall,
  parseInstalledProotDistroList,
  parseProotDistroProbe,
  normalizeProotArchitecture,
} = loadTs("lib/proot-distro-state.ts");
const { buildProotDistroRootfsCheckCommand } = loadTs("lib/termux-bootstrap-install.ts");

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const termuxBridgeSource = fs.readFileSync(path.join(root, "lib/termux-bridge.ts"), "utf8");
const stagingChunkSize = Number(termuxBridgeSource.match(/const chunkSize = (\d+);/)?.[1]);
assert.ok(Number.isFinite(stagingChunkSize) && stagingChunkSize > 0, "Termux staged-command chunk size is defined");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aib-proot-state-"));
const bin = path.join(temp, "bin");
const stateDir = path.join(temp, "state");
fs.mkdirSync(bin, { recursive: true });
fs.mkdirSync(stateDir, { recursive: true });
const callsFile = path.join(temp, "calls.txt");
const captureFile = path.join(temp, "restore-path.txt");
const mock = path.join(bin, "proot-distro");
fs.writeFileSync(mock, `#!/bin/sh
set +e
cmd="$1"
case "$cmd" in
  list)
    if [ "${"${2:-}"}" = --quiet ]; then
      if [ "${"${MOCK_QUIET_UNSUPPORTED:-0}"}" = 1 ]; then echo 'unrecognized option: --quiet' >&2; exit 2; fi
      case "${"${MOCK_LIST:-empty}"}" in
        empty|legacy-empty|blank) ;;
        debian) printf 'debian\\n';;
        ubuntu) printf 'ubuntu\\n';;
        both) printf 'debian\\nubuntu\\n';;
        none-plus-debian) printf 'debian\\n';;
        none-plus-ubuntu) printf 'ubuntu\\n';;
        unknown) printf 'unexpected-custom-alias\\n';;
        corrupt) printf 'debian\\ntruncated-custom-output\\n';;
        *) exit 19;;
      esac
      exit "${"${MOCK_LIST_EXIT:-0}"}"
    fi
    case "${"${MOCK_LIST:-empty}"}" in
      empty) printf 'No containers are installed.\\n\\nInstall one with: proot-distro install ubuntu:24.04\\n';;
      legacy-empty) printf 'Supported distributions:\\n  Debian (debian)\\n  Ubuntu (ubuntu)\\nInstalled distributions:\\n  (none)\\n';;
      blank) printf 'Installed distributions:\\nSupported distributions:\\n  Debian (debian)\\n  Ubuntu (ubuntu)\\n';;
      corrupt) printf 'Installed distributions:\\n  unreadable or truncated data\\nSupported distributions:\\n  Debian (debian)\\n';;
      debian) printf 'Installed containers:\\n\\n  * debian\\n\\nLog in with: proot-distro login <name>\\n';;
      ubuntu) printf 'Installed containers:\\n\\n  * ubuntu\\n\\nLog in with: proot-distro login <name>\\n';;
      both) printf 'Installed containers:\\n\\n  * debian\\n  * ubuntu\\n';;
      none-plus-debian) printf 'Installed distributions:\\n  (none)\\n  Debian (debian)\\n';;
      none-plus-ubuntu) printf 'Installed distributions:\\n  (none)\\n  Ubuntu (ubuntu)\\n';;
      unknown) printf 'Usage: proot-distro list\\nSupported distributions:\\n  Debian (debian)\\n';;
      *) exit 19;;
    esac
    exit "${"${MOCK_LIST_EXIT:-0}"}"
    ;;
  login)
    alias="$2"
    healthy=0
    if [ -f "$MOCK_STATE/$alias.healthy" ]; then healthy=1; fi
    case ",${"${MOCK_HEALTHY:-}"}," in *,"$alias",*) healthy=1;; esac
    if [ "$healthy" -eq 1 ]; then
      printf 'AIB_PROBE_ID:%s\\nAIB_PROBE_UID:0\\nAIB_PROBE_UNAME:%s\\n' "$alias" "$(uname -m)"
      exit 0
    fi
    if [ "${"${MOCK_LOGIN_NOT_INSTALLED:-0}"}" = 1 ]; then
      echo "Error: container '$alias' is not installed." >&2
      exit 1
    fi
    echo "mock login failed for $alias" >&2
    exit 1
    ;;
  install)
    alias="$2"
    printf 'install:%s\\n' "$alias" >> "$MOCK_CALLS"
    if [ "${"${MOCK_INSTALL_FAIL:-0}"}" = 1 ]; then echo 'Temporary failure resolving mirror' >&2; exit 17; fi
    touch "$MOCK_STATE/$alias.healthy"
    echo 'mock install completed'
    exit 0
    ;;
  restore)
    source="$2"
    printf 'restore:%s\\n' "$source" >> "$MOCK_CALLS"
    printf '%s' "$source" > "$MOCK_PATH_CAPTURE"
    touch "$MOCK_STATE/${"${MOCK_RESTORE_ALIAS:-debian}"}.healthy"
    echo 'mock restore completed'
    exit 0
    ;;
  reset|remove)
    printf 'forbidden:%s\\n' "$cmd" >> "$MOCK_CALLS"
    exit 99
    ;;
  *)
    echo "unexpected mock command:$cmd" >&2
    exit 64
    ;;
esac
`, { mode: 0o755 });
fs.chmodSync(mock, 0o755);

function env(overrides = {}) {
  return {
    ...process.env,
    PATH: `${bin}:${process.env.PATH || "/usr/bin:/bin"}`,
    TMPDIR: temp,
    MOCK_STATE: stateDir,
    MOCK_CALLS: callsFile,
    MOCK_PATH_CAPTURE: captureFile,
    ...overrides,
  };
}
function run(command, overrides = {}) {
  return spawnSync("bash", ["-c", command], {
    cwd: temp,
    env: env(overrides),
    encoding: "utf8",
    timeout: 30_000,
  });
}
function bashSyntax(command) {
  const result = spawnSync("bash", ["-n"], { input: command, encoding: "utf8" });
  assert.equal(result.status, 0, `bash -n failed:\n${result.stderr}\n${command}`);
}
function clearState() {
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.rmSync(callsFile, { force: true });
  fs.rmSync(captureFile, { force: true });
  for (const name of fs.readdirSync(temp)) if (name.startsWith("AIB_ROOTFS_SENTINEL")) fs.rmSync(path.join(temp, name), { force: true });
}

try {
  assert.deepEqual(parseInstalledProotDistroList("Supported distributions:\n  Debian (debian)\nInstalled distributions:\n  Ubuntu (ubuntu)\n").aliases, ["ubuntu"]);
  assert.deepEqual(parseInstalledProotDistroList("Installed distributions:\n  (none)\nSupported distributions:\n  Debian (debian)\n"), { known: true, aliases: [] });
  assert.deepEqual(parseInstalledProotDistroList("No containers are installed.\n\nInstall one with: proot-distro install ubuntu:24.04\n"), { known: true, aliases: [] }, "the current v5.9 empty-list sentence is recognized as list evidence");
  assert.deepEqual(parseInstalledProotDistroList("Installed containers:\n\n  * ubuntu\n\nLog in with: proot-distro login <name>\n").aliases, ["ubuntu"], "the current v5.9 installed-containers section is parsed");
  assert.deepEqual(parseInstalledProotDistroList("debian\nubuntu\n"), { known: true, aliases: ["debian", "ubuntu"] }, "upstream --quiet bare identifiers are parsed independent of locale and ANSI formatting");
  assert.deepEqual(parseInstalledProotDistroList("", true), { known: true, aliases: [] }, "only explicit successful quiet mode may interpret an empty list as empty inventory");
  assert.equal(parseInstalledProotDistroList("").known, false, "unframed empty output is not list evidence");
  assert.equal(parseInstalledProotDistroList("ubuntu\nunexpected-custom-alias\n").known, false, "quiet output mixed with an unknown identifier is inconclusive");
  assert.equal(parseInstalledProotDistroList("Usage: proot-distro list\nSupported distributions:\n Debian (debian)").known, false);
  assert.equal(parseInstalledProotDistroList("Installed distributions:\nSupported distributions:\n Debian (debian)").known, false, "empty list section is not proof of absence");
  assert.equal(parseInstalledProotDistroList("Installed distributions:\n unreadable/truncated data\nSupported distributions:\n Debian (debian)").known, false, "corrupt list data is not proof of absence");
  assert.equal(parseInstalledProotDistroList("Installed: nonsense").known, false, "unrecognized installed summary remains unknown");

  const profileState = (alias, installedLines, { loginExit = 1, loginOutput = "", listExit = 0, commandExit = 0, complete = true, hostUname = "aarch64" } = {}) => {
    const lines = ["AIB_PROBE_BEGIN", "AIB_PROOT_TOOL:AVAILABLE", `AIB_HOST_UNAME:${hostUname}`, `AIB_LIST_EXIT:${listExit}`, "AIB_LIST_BEGIN", "Installed distributions:",
      ...installedLines, "AIB_LIST_END", `AIB_LOGIN_EXIT:${loginExit}`, "AIB_LOGIN_BEGIN", loginOutput, "AIB_LOGIN_END"];
    if (complete) lines.push("AIB_PROBE_END");
    return parseProotDistroProbe(alias, lines.join("\n"), commandExit);
  };
  assert.equal(profileState("debian", ["  Ubuntu (ubuntu)"]).installed, null, "an absent alias in list output does not prove absence because upstream list can hide storage errors");
  assert.equal(profileState("ubuntu", ["  Debian (debian)"]).installed, null, "the other listed alias does not prove selected-alias absence");
  assert.equal(profileState("debian", ["  Debian (debian)", "  Ubuntu (ubuntu)"]).installed, true, "both aliases are independently recognized");
  assert.equal(profileState("ubuntu", ["  Debian (debian)", "  Ubuntu (ubuntu)"]).installed, true);
  assert.equal(profileState("debian", ["  (none)"]).installed, null, "explicit empty list remains advisory without the exact login absence response");
  assert.equal(profileState("debian", ["  (none)"], { loginExit: -1 }).installed, null, "an empty list plus timeout never proves absence");
  assert.equal(profileState("debian", ["  (none)"], { loginExit: 1, loginOutput: "Error: container 'debian' is not installed." }).installed, false, "the exact upstream login error with exit 1 confirms absence");
  assert.equal(profileState("debian", ["  Debian (debian)"], { loginExit: 1, loginOutput: "Error: container 'debian' is not installed." }).installed, true, "contradictory list and login evidence preserves the alias as present");
  assert.equal(profileState("debian", ["  Debian (debian)"], { loginExit: 1, loginOutput: "Error: container 'debian' is not installed." }).diagnostic, "ROOTFS_STATE_UNVERIFIED", "contradictory evidence is blocked rather than missing");
  const quietEmptyButLoginFails = parseProotDistroProbe("debian", [
    "AIB_PROBE_BEGIN", "AIB_PROOT_TOOL:AVAILABLE", "AIB_HOST_UNAME:aarch64",
    "AIB_LIST_BEGIN", "AIB_LIST_MODE:quiet", "AIB_LIST_END", "AIB_LIST_EXIT:0",
    "AIB_LOGIN_BEGIN", "Error: container 'debian' is not installed.", "AIB_LOGIN_EXIT:1", "AIB_LOGIN_END", "AIB_PROBE_END",
  ].join("\n"));
  assert.equal(quietEmptyButLoginFails.listEvidence, "explicit-empty");
  assert.equal(quietEmptyButLoginFails.installed, false, "quiet empty list remains advisory; exact upstream login absence is still required");
  assert.equal(profileState("debian", [], { loginExit: -1 }).installed, null, "empty list plus login timeout remains unknown");
  assert.equal(profileState("debian", ["  Debian (debian)"], { loginExit: -1 }).diagnostic, "ROOTFS_INSTALLED_LOGIN_FAILED", "login timeout preserves listed rootfs");
  assert.equal(profileState("debian", ["  Debian (debian)"], { loginExit: -1, commandExit: -1 }).installed, null, "outer timeout invalidates otherwise plausible inner output");
  assert.equal(profileState("debian", ["  Debian (debian)"], { loginExit: 0, loginOutput: "AIB_PROBE_ID:debian\nAIB_PROBE_UID:0\nAIB_PROBE_UNAME:aarch64" }).healthy, true, "valid Debian identity requires ID, numeric UID, uname and complete frames");
  assert.equal(profileState("ubuntu", ["  Ubuntu (ubuntu)"], { loginExit: 0, loginOutput: "AIB_PROBE_ID:ubuntu\nAIB_PROBE_UID:1000\nAIB_PROBE_UNAME:aarch64" }).healthy, true, "valid Ubuntu identity is accepted");
  assert.equal(normalizeProotArchitecture("aarch64"), "arm64");
  assert.equal(normalizeProotArchitecture("arm64"), "arm64");
  assert.equal(normalizeProotArchitecture("amd64"), "x86_64");
  assert.equal(profileState("debian", ["  Debian (debian)"], { loginExit: 0, loginOutput: "AIB_PROBE_ID:debian\nAIB_PROBE_UID:1000\nAIB_PROBE_UNAME:aarch64", hostUname: "x86_64" }).diagnostic, "ROOTFS_ARCH_MISMATCH", "identity-correct guest with a different host architecture is unhealthy");
  const archMismatchAbsentList = profileState("ubuntu", ["  (none)"], { loginExit: 0, loginOutput: "AIB_PROBE_ID:ubuntu\nAIB_PROBE_UID:1000\nAIB_PROBE_UNAME:aarch64", hostUname: "x86_64" });
  assert.equal(archMismatchAbsentList.installed, true, "successful but architecture-mismatched login cannot be downgraded to absent by a stale list");
  assert.equal(archMismatchAbsentList.healthy, false);
  assert.equal(profileState("debian", ["  Debian (debian)"], { loginExit: 0, loginOutput: "AIB_PROBE_ID:debian\nAIB_PROBE_UID:1000\nAIB_PROBE_UNAME:aarch64", hostUname: "arm64" }).healthy, true, "equivalent arm machine names normalize to the same architecture");
  const wrongId = profileState("debian", ["  Debian (debian)"], { loginExit: 0, loginOutput: "AIB_PROBE_ID:ubuntu\nAIB_PROBE_UID:0\nAIB_PROBE_UNAME:aarch64" });
  assert.equal(wrongId.installed, true, "listed rootfs remains present when identity is wrong");
  assert.equal(wrongId.healthy, false, "wrong distro ID never validates the selected target");
  assert.equal(profileState("debian", ["  Debian (debian)"], { loginExit: 0, loginOutput: "AIB_PROBE_ID:debian\nAIB_PROBE_UID:root\nAIB_PROBE_UNAME:aarch64" }).healthy, false, "non-numeric UID marker is invalid");
  assert.equal(profileState("debian", ["  Debian (debian)"], { loginExit: 0, loginOutput: "AIB_PROBE_ID:debian\nAIB_PROBE_UID:0\nAIB_PROBE_UID:root\nAIB_PROBE_UNAME:aarch64" }).healthy, false, "duplicate UID markers cannot be reduced to one valid value");
  const malformedPartialUid = parseProotDistroProbe("ubuntu", ["AIB_PROBE_BEGIN", "AIB_PROBE_ID:ubuntu", "AIB_PROBE_UID:root", "AIB_PROBE_UNAME:aarch64"].join("\n"), 0);
  assert.equal(malformedPartialUid.healthy, false, "a present malformed UID cannot use the short-callback fallback");
  assert.equal(profileState("debian", ["  (none)", "  Debian (debian)"]).installed, null, "contradictory none+alias list is corrupt evidence");
  assert.equal(parseProotDistroProbe("debian", "", 0).installed, null, "exit zero with empty captured output is UNKNOWN");
  assert.equal(parseProotDistroProbe("debian", "AIB_PROBE_BEGIN\nAIB_PROOT_TOOL:AVAILABLE\n", 0).installed, null, "truncated outer frame is UNKNOWN");
  assert.equal(parseProotDistroProbe("debian", "AIB_PROBE_BEGIN\nAIB_PROOT_TOOL:MISSING\nAIB_PROBE_END\n", 0).installed, null, "explicit permission-denied/tool-missing result never proves rootfs absence");
  const truncatedTranscript = ["AIB_PROBE_BEGIN", "AIB_PROOT_TOOL:AVAILABLE", "AIB_LIST_EXIT:0", "AIB_LIST_BEGIN", "Installed distributions:", "  (none)", "AIB_LIST_END", "AIB_LOGIN_EXIT:1", "AIB_LOGIN_BEGIN", "login failed", "AIB_LOGIN_END", "AIB_PROBE_END", "TERMUX_RESULT_OUTPUT_TRUNCATED"].join("\n");
  assert.equal(parseProotDistroProbe("debian", truncatedTranscript, 0).installed, null, "Termux callback truncation invalidates otherwise plausible empty-list evidence");
  const truncatedHealthyEnvelope = ["AIB_PROBE_BEGIN", "AIB_PROOT_TOOL:AVAILABLE", "AIB_HOST_UNAME:aarch64", "AIB_LIST_EXIT:0", "AIB_LIST_BEGIN", "AIB_LIST_MODE:quiet", "debian", "AIB_LIST_END", "AIB_LOGIN_EXIT:0", "AIB_LOGIN_BEGIN", "AIB_PROBE_ID:debian", "AIB_PROBE_UID:0", "AIB_PROBE_UNAME:aarch64", "AIB_LOGIN_END", "AIB_PROBE_END", "TERMUX_RESULT_OUTPUT_TRUNCATED"].join("\n");
  assert.equal(parseProotDistroProbe("debian", truncatedHealthyEnvelope, 0).healthy, false, "explicit native truncation invalidates otherwise complete guest identity");
  const truncatedCompact = "AIB_C T=1 E=0 N=0 I=ubuntu M=aarch64 H=aarch64\nTERMUX_RESULT_OUTPUT_TRUNCATED";
  assert.equal(parseProotDistroProbe("ubuntu", truncatedCompact, 0).healthy, false, "compact identity does not override an explicit native truncation marker");
  // Device-observed incomplete envelopes (~87–103 B): identity present, AIB_*_END missing.
  const deviceUbuntu = parseProotDistroProbe("ubuntu", ["AIB_PROBE_BEGIN", "AIB_LIST_MODE:quiet", "AIB_PROBE_ID:ubuntu", "AIB_PROBE_UID:0", "AIB_PROBE_UNAME:aarch64"].join("\n"), 0);
  assert.equal(deviceUbuntu.healthy, true, "device truncated ubuntu callback with exact ID/UID/UNAME is healthy");
  assert.equal(deviceUbuntu.parserOutcome, "healthy");
  assert.equal(deviceUbuntu.diagnostic, "ROOTFS_HEALTHY");
  const deviceDebian = parseProotDistroProbe("debian", ["AIB_PROBE_BEGIN", "AIB_LIST_MODE:quiet", "AIB_PROBE_ID:debian", "AIB_PROBE_UNAME:aarch64"].join("\n"), 0);
  assert.equal(deviceDebian.healthy, true, "device truncated debian callback without UID still healthy when ID+UNAME match");
  assert.equal(deviceDebian.parserOutcome, "healthy");
  const wrongPartial = parseProotDistroProbe("ubuntu", ["AIB_PROBE_BEGIN", "AIB_PROBE_ID:debian", "AIB_PROBE_UNAME:aarch64"].join("\n"), 0);
  assert.equal(wrongPartial.healthy, false, "partial identity for the other alias never validates the selected target");
  assert.equal(wrongPartial.parserOutcome, "incomplete-envelope");

  for (const alias of ["debian", "ubuntu"]) {
    const probeCommand = buildProotDistroProbeCommand(alias);
    bashSyntax(probeCommand);
    assert.match(probeCommand, /proot-distro list --quiet 2>&1/);
    assert.ok(probeCommand.includes("LIST_MODE=human") && probeCommand.includes("proot-distro list 2>&1"), "unsupported quiet mode falls back to legacy human-readable list");
    assert.match(probeCommand, /AIB_LIST_MODE:\$LIST_MODE/);
    const encodedProbeLength = Buffer.from(probeCommand, "utf8").toString("base64").length;
    assert.ok(encodedProbeLength <= stagingChunkSize, "rootfs probe fits in one bounded base64 staging write chunk");
    assert.doesNotMatch(probeCommand, /\$LIST_FILE|\$LOGIN_FILE|mktemp|PROBE_OUTPUT=\$\(/, "readiness output must not route through temp-file redirects");
    assert.match(probeCommand, /AIB_PROBE_BEGIN/);
    assert.match(probeCommand, /AIB_PROBE_END/);
    bashSyntax(buildProotDistroInstallCommand(alias));
    bashSyntax(buildProotDistroRootfsCheckCommand(alias));
    assert.throws(() => buildProotDistroProbeCommand("../../debian"), /NOT_ALLOWED/);
  }

  // A manually installed distro with an explicit list entry is healthy without
  // AI Builder metadata/rootfs-path registration.
  clearState();
  const manualRaw = run(buildProotDistroProbeCommand("debian"), { MOCK_LIST: "debian", MOCK_HEALTHY: "debian" });
  assert.equal(manualRaw.status, 0, manualRaw.stderr);
  for (const marker of ["AIB_PROBE_BEGIN", "AIB_HOST_UNAME:", "AIB_LIST_BEGIN", "AIB_LOGIN_BEGIN", "AIB_PROBE_END"]) assert.ok(manualRaw.stdout.includes(marker), `generated shell probe emits ${marker}`);
  const manual = parseProotDistroProbe("debian", manualRaw.stdout);
  assert.equal(manual.healthy, true);
  assert.equal(manual.installed, true);
  assert.equal(manual.evidence, "login-smoke");
  assert.equal(manual.aiBuilderRegistration, "not-required-for-health");
  assert.equal(decideProotDistroInstall(manual), "already-healthy");
  clearState();
  const legacyListRaw = run(buildProotDistroProbeCommand("debian"), { MOCK_LIST: "debian", MOCK_HEALTHY: "debian", MOCK_QUIET_UNSUPPORTED: "1" });
  assert.equal(legacyListRaw.status, 0, `old proot-distro fallback shell failed: ${legacyListRaw.stderr}`);
  assert.ok(legacyListRaw.stdout.includes("Installed containers:"), "old versions rejecting --quiet are retried with the human-readable list");
  assert.equal(parseProotDistroProbe("debian", legacyListRaw.stdout).healthy, true, "legacy list fallback preserves the real login health result");
  const manualCheck = run(buildProotDistroRootfsCheckCommand("debian"), { MOCK_LIST: "debian", MOCK_HEALTHY: "debian" });
  assert.equal(manualCheck.status, 0, manualCheck.stderr);
  assert.match(manualCheck.stdout, /AIB_DEBIAN_ROOTFS_OK/);
  assert.deepEqual(classifyProotDistroPreflight("debian", manualCheck.stdout).kind, "healthy");
  const noOverwrite = run(buildProotDistroInstallCommand("debian"), { MOCK_LIST: "debian", MOCK_HEALTHY: "debian" });
  assert.equal(noOverwrite.status, 0);
  assert.match(noOverwrite.stdout, /ROOTFS_ALREADY_HEALTHY:debian/);
  assert.equal(fs.existsSync(callsFile), false, "healthy manual root must not trigger install");

  // A successful guest identity never overrides an explicit empty/unsupported
  // installed list. Preserve the distinction: present by login evidence, but
  // unverified for readiness and blocked from install/reset.
  clearState();
  const unlistedRaw = run(buildProotDistroProbeCommand("debian"), { MOCK_LIST: "empty", MOCK_HEALTHY: "debian" });
  const unlisted = parseProotDistroProbe("debian", unlistedRaw.stdout);
  assert.equal(unlisted.installed, true, "successful login proves the guest exists");
  assert.equal(unlisted.healthy, true, "exact guest identity proves readiness even when list reports empty");
  assert.equal(unlisted.listEvidence, "explicit-empty");
  assert.equal(unlisted.diagnostic, "ROOTFS_HEALTHY");
  const unlistedCheck = run(buildProotDistroRootfsCheckCommand("debian"), { MOCK_LIST: "empty", MOCK_HEALTHY: "debian" });
  assert.equal(unlistedCheck.status, 0);
  assert.match(unlistedCheck.stdout, /AIB_DEBIAN_ROOTFS_OK/);
  const unlistedInstall = run(buildProotDistroInstallCommand("debian"), { MOCK_LIST: "empty", MOCK_HEALTHY: "debian" });
  assert.equal(unlistedInstall.status, 0);
  assert.match(unlistedInstall.stdout, /ROOTFS_ALREADY_HEALTHY:debian/);
  assert.equal(fs.existsSync(callsFile), false, "unlisted login-able guest must never be automatically reinstalled");

  // Only an explicitly absent alias can be installed, exactly once.
  clearState();
  const absentRaw = run(buildProotDistroProbeCommand("ubuntu"), { MOCK_LIST: "empty", MOCK_LOGIN_NOT_INSTALLED: "1" });
  const absent = parseProotDistroProbe("ubuntu", absentRaw.stdout);
  assert.equal(absent.installed, false);
  assert.equal(absent.evidence, "login-not-installed");
  assert.equal(absent.listEvidence, "explicit-empty");
  assert.equal(decideProotDistroInstall(absent), "install-once");
  assert.equal(classifyProotDistroPreflight("ubuntu", "AIB_UBUNTU_ROOTFS_MISSING").kind, "confirmed-absent");
  const install = run(buildProotDistroInstallCommand("ubuntu"), { MOCK_LIST: "empty", MOCK_LOGIN_NOT_INSTALLED: "1" });
  assert.equal(install.status, 0, install.stderr);
  assert.match(install.stdout, /INSTALL_EXIT:0/);
  assert.equal(fs.readFileSync(callsFile, "utf8").trim(), "install:ubuntu");
  const installedCheck = run(buildProotDistroRootfsCheckCommand("ubuntu"), { MOCK_LIST: "ubuntu" });
  assert.equal(installedCheck.status, 0, installedCheck.stderr);
  assert.match(installedCheck.stdout, /AIB_UBUNTU_ROOTFS_OK/);

  // Installed-but-broken and unparseable list states must never reinstall.
  clearState();
  const broken = run(buildProotDistroInstallCommand("debian"), { MOCK_LIST: "debian" });
  assert.equal(broken.status, 78);
  assert.match(broken.stdout, /ROOTFS_INSTALLED_LOGIN_FAILED:debian/);
  assert.equal(classifyProotDistroPreflight("debian", "AIB_DEBIAN_ROOTFS_INSTALLED_LOGIN_FAILED").kind, "installed-login-failed");
  assert.equal(fs.existsSync(callsFile), false);

  clearState();
  const unknown = run(buildProotDistroInstallCommand("ubuntu"), { MOCK_LIST: "unknown" });
  assert.equal(unknown.status, 78);
  assert.match(unknown.stdout, /ROOTFS_STATE_UNVERIFIED:ubuntu/);
  assert.equal(classifyProotDistroPreflight("ubuntu", "AIB_UBUNTU_ROOTFS_STATE_UNVERIFIED").kind, "unverified");
  assert.equal(fs.existsSync(callsFile), false);

  for (const mode of ["blank", "corrupt"]) {
    clearState();
    const unverifiedInstall = run(buildProotDistroInstallCommand("debian"), { MOCK_LIST: mode });
    assert.equal(unverifiedInstall.status, 78, `${mode} list must remain unverified`);
    assert.match(unverifiedInstall.stdout, /ROOTFS_STATE_UNVERIFIED:debian/);
    assert.equal(fs.existsSync(callsFile), false, `${mode} list must never install/reset`);
    const unverifiedCheck = run(buildProotDistroRootfsCheckCommand("debian"), { MOCK_LIST: mode });
    assert.equal(unverifiedCheck.status, 78, `${mode} check must be unknown, not missing`);
    assert.match(unverifiedCheck.stdout, /AIB_DEBIAN_ROOTFS_STATE_UNVERIFIED/);
  }

  for (const [mode, alias] of [["none-plus-debian", "debian"], ["none-plus-ubuntu", "ubuntu"]]) {
    clearState();
    const ambiguousInstall = run(buildProotDistroInstallCommand(alias), { MOCK_LIST: mode });
    assert.equal(ambiguousInstall.status, 78, `${mode} must be unverified, never install`);
    assert.match(ambiguousInstall.stdout, /ROOTFS_STATE_UNVERIFIED/);
    assert.equal(fs.existsSync(callsFile), false, `${mode} must not call install`);
    const ambiguousCheck = run(buildProotDistroRootfsCheckCommand(alias), { MOCK_LIST: mode });
    assert.equal(ambiguousCheck.status, 78, `${mode} must not report missing`);
    assert.match(ambiguousCheck.stdout, /ROOTFS_STATE_UNVERIFIED/);
    const archive = path.join(temp, `${alias}-ambiguous.tar.gz`);
    fs.writeFileSync(archive, "fixture");
    const ambiguousRestore = run(buildProotDistroRestoreCommand(alias, archive), { MOCK_LIST: mode });
    assert.equal(ambiguousRestore.status, 78, `${mode} must not restore over ambiguous state`);
    assert.match(ambiguousRestore.stdout, /REFUSED_STATE_UNVERIFIED/);
    assert.equal(fs.existsSync(callsFile), false, `${mode} must not call install or restore`);
  }

  clearState();
  const partialListRaw = run(buildProotDistroProbeCommand("debian"), { MOCK_LIST: "empty", MOCK_LIST_EXIT: "19" });
  const partialList = parseProotDistroProbe("debian", partialListRaw.stdout);
  assert.equal(partialList.listExitCode, 19);
  assert.equal(partialList.installed, null, "nonzero list exit must invalidate partial `none` text");
  assert.equal(decideProotDistroInstall(partialList), "state-unverified");
  const partialListCheck = run(buildProotDistroRootfsCheckCommand("debian"), { MOCK_LIST: "empty", MOCK_LIST_EXIT: "19" });
  assert.equal(partialListCheck.status, 78);
  assert.match(partialListCheck.stdout, /AIB_DEBIAN_ROOTFS_STATE_UNVERIFIED/);
  assert.equal(fs.existsSync(callsFile), false);

  // A failed installer is reported as a network/install failure, not converted to success.
  clearState();
  const networkFail = run(buildProotDistroInstallCommand("debian"), { MOCK_LIST: "empty", MOCK_LOGIN_NOT_INSTALLED: "1", MOCK_INSTALL_FAIL: "1" });
  assert.equal(networkFail.status, 17);
  assert.match(networkFail.stdout + networkFail.stderr, /INSTALL_EXIT:17|Temporary failure resolving mirror/);

  // Restore is restricted to confirmed-absent aliases; paths remain data, including quotes/spaces/metacharacters.
  clearState();
  const payloadName = "Miro's backup;touch AIB_ROOTFS_SENTINEL;#.tar.gz";
  const sourcePath = path.join(temp, payloadName);
  fs.writeFileSync(sourcePath, "test archive");
  const restore = buildProotDistroRestoreCommand("ubuntu", sourcePath);
  bashSyntax(restore);
  assert.doesNotMatch(restore, /rm\s+-rf|proot-distro\s+(?:reset|remove)/i);
  const restored = run(restore, { MOCK_LIST: "empty", MOCK_LOGIN_NOT_INSTALLED: "1", MOCK_RESTORE_ALIAS: "ubuntu" });
  assert.equal(restored.status, 0, `${restored.stderr}\n${restored.stdout}`);
  assert.match(restored.stdout, /AIB_ROOTFS_RESTORE_OK:ubuntu/);
  assert.equal(fs.readFileSync(captureFile, "utf8"), sourcePath, "restore path must survive shell normalization exactly");
  assert.equal(fs.existsSync(path.join(temp, "AIB_ROOTFS_SENTINEL")), false, "metacharacters must not execute as shell code");
  assert.equal(fs.readFileSync(callsFile, "utf8"), `restore:${sourcePath}\n`);

  clearState();
  const restoreBroken = run(buildProotDistroRestoreCommand("debian", sourcePath), { MOCK_LIST: "debian" });
  assert.equal(restoreBroken.status, 78);
  assert.match(restoreBroken.stdout, /REFUSED_ALREADY_REGISTERED:debian/);
  assert.equal(fs.existsSync(callsFile), false, "restore must not run for a listed rootfs");

  const remove = buildProotDistroRemoveGuardCommand("debian");
  assert.doesNotMatch(remove, /rm\s+-rf|proot-distro\s+(?:reset|remove)/i);
  assert.equal(run(remove).status, 64);
  console.log("AIB_PROOT_DISTRO_STATE_SELFTEST_OK profiles=ubuntu,debian,both,neither wrong_id=unknown empty_corrupt_timeout_permission=fail_closed absent_install_once=1 installed_preserved=1 guarded_restore=1 real_bash_n=1");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
