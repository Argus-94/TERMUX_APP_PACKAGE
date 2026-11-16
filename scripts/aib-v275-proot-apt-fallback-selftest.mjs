#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import Module, { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { typescript } from "./test-helpers/load-typescript.mjs";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const moduleCache = new Map();
function resolveTs(parent, request) {
  const base = path.resolve(path.dirname(parent), request);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}
function loadTs(file) {
  file = path.resolve(file);
  if (moduleCache.has(file)) return moduleCache.get(file).exports;
  const mod = new Module(file);
  mod.filename = file;
  mod.paths = Module._nodeModulePaths(path.dirname(file));
  moduleCache.set(file, mod);
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

const apt = loadTs(path.join(projectRoot, "lib/proot-apt-mirror-fallback.ts"));
const { buildProotAptFallbackInstallCommand, buildProotAptInstallCommand, buildProotAptSourceUpdateCommand,
  classifyProotAptSourceUpdate, parseProotAptFallbackResult, PROOT_APT_OFFICIAL_FALLBACK_ENDPOINTS } = apt;

assert.deepEqual(PROOT_APT_OFFICIAL_FALLBACK_ENDPOINTS, {
  debian: "https://deb.debian.org/debian",
  ubuntuArchive: "https://archive.ubuntu.com/ubuntu",
  ubuntuPorts: "https://ports.ubuntu.com/ubuntu-ports",
});
assert.throws(() => buildProotAptFallbackInstallCommand("kali", ["curl"]), /PROOT_DISTRO_ALIAS_NOT_ALLOWED/);
assert.throws(() => buildProotAptInstallCommand(["curl; touch /tmp/bad"]), /PROOT_APT_PACKAGE_NOT_ALLOWED/);
assert.equal(classifyProotAptSourceUpdate({ exitCode: 100, stdout: "AIB_APT_SOURCE_UPDATE_CLASS:signature" }), "signature");
assert.equal(classifyProotAptSourceUpdate({ exitCode: 100, stdout: "AIB_APT_SOURCE_UPDATE_CLASS:http-client" }), "http-client");
assert.equal(classifyProotAptSourceUpdate({ exitCode: 100, stdout: "AIB_APT_SOURCE_UPDATE_CLASS:transport" }), "transport");
assert.equal(classifyProotAptSourceUpdate({ exitCode: 100, stdout: "AIB_APT_SOURCE_UPDATE_CLASS:transport", timedOut: true }), "unknown");

function fixture({ alias = "debian", codename = alias === "debian" ? "bookworm" : "noble", sourceSuite = codename,
  sourceUrl = alias === "debian" ? "https://mirror.example/debian" : "https://mirror.example/ubuntu",
  sourceComponents = "main", arch = alias === "debian" ? "arm64" : sourceUrl.includes("ubuntu-ports") ? "arm64" : "amd64",
  mockMode = "success", releaseOrigin = alias === "debian" ? "Debian" : "Ubuntu",
  releaseCodename = codename } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aib-v275-apt-mock-"));
  const aptDir = path.join(root, "etc", "apt");
  const binDir = path.join(root, "mock-bin");
  fs.mkdirSync(path.join(aptDir, "apt.conf.d"), { recursive: true });
  fs.mkdirSync(path.join(aptDir, "sources.list.d"), { recursive: true });
  fs.mkdirSync(path.join(root, "var", "lib", "dpkg"), { recursive: true });
  fs.mkdirSync(path.join(root, "tmp"), { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(root, "etc", "os-release"), `ID=${alias}\nVERSION_CODENAME=${codename}\n`);
  const sourceContent = `deb ${sourceUrl} ${sourceSuite} ${sourceComponents}\n`;
  fs.writeFileSync(path.join(aptDir, "sources.list"), sourceContent);
  fs.writeFileSync(path.join(root, "var", "lib", "dpkg", "status"), "");
  const callsPath = path.join(root, "apt-calls.log");
  const argsPath = path.join(root, "apt-args.log");
  const dpkg = `#!/bin/sh\nprintf '%s\\n' '${arch}'\n`;
  fs.writeFileSync(path.join(binDir, "dpkg"), dpkg, { mode: 0o755 });
  const fakeApt = `#!/bin/sh
printf '%s\\n' "$*" >> "$MOCK_APT_ARGS"
case " $* " in
  *" update "*)
    printf 'update\\n' >> "$MOCK_APT_CALLS"
    case "$MOCK_APT_MODE" in
      signature) echo 'NO_PUBKEY 0123456789ABCDEF' >&2; exit 100 ;;
      hash) echo 'Hash Sum mismatch' >&2; exit 100 ;;
      transport) echo 'Temporary failure resolving canonical archive' >&2; exit 100 ;;
      http429) echo '429 Too Many Requests' >&2; exit 100 ;;
      http403) echo '403 Forbidden' >&2; exit 100 ;;
      http503) echo 'Failed to fetch archive: HTTP/1.1 503 Service Unavailable' >&2; exit 100 ;;
      http404) echo '404 Not Found' >&2; exit 100 ;;
    esac
    _conf=\${APT_CONFIG-}
    _lists=$(sed -n 's/^Dir::State::lists "\\(.*\\)";$/\\1/p' "$_conf")
    _src=$(sed -n 's/^Dir::Etc::sourcelist "\\(.*\\)";$/\\1/p' "$_conf")
    if [ -n "$_lists" ] && [ -n "$_src" ]; then
      _line=$(grep -v '^[[:space:]]*#' "$_src" | head -1)
      _url=$(printf '%s\\n' "$_line" | awk '{print $3}')
      mkdir -p "$_lists"
      case "$MOCK_APT_MODE" in
        wrong-release) _codename=wrong-suite ;;
        *) _codename="$MOCK_RELEASE_CODENAME" ;;
      esac
      printf 'Origin: %s\\nCodename: %s\\n' "$MOCK_RELEASE_ORIGIN" "$_codename" > "$_lists/mock_dists_InRelease"
      printf 'Package: curl\\nVersion: 1\\n' > "$_lists/mock_main_binary-arm64_Packages"
      printf 'AIB_MOCK_FALLBACK_URL:%s\\n' "$_url" >> "$MOCK_APT_ARGS"
      printf 'AIB_MOCK_FALLBACK_SOURCE:%s\\n' "$_line" >> "$MOCK_APT_ARGS"
    fi
    exit 0 ;;
  *" install "*)
    printf 'install\\n' >> "$MOCK_APT_CALLS"
    case "$MOCK_APT_MODE" in install-dependency-error) echo 'unmet dependencies' >&2; exit 100 ;; esac
    exit 0 ;;
esac
exit 91
`;
  fs.writeFileSync(path.join(binDir, "apt-get"), fakeApt, { mode: 0o755 });
  return {
    root, binDir, callsPath, argsPath, alias, codename, releaseOrigin, releaseCodename, sourceContent,
    run(command, mode = mockMode, extra = {}) {
      const result = spawnSync("sh", ["-c", command], {
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          MOCK_APT_CALLS: callsPath,
          MOCK_APT_ARGS: argsPath,
          MOCK_APT_MODE: mode,
          MOCK_RELEASE_ORIGIN: releaseOrigin,
          MOCK_RELEASE_CODENAME: releaseCodename,
          ...extra,
        },
      });
      if (result.error) throw result.error;
      return { exitCode: result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
    },
    calls() { return fs.existsSync(callsPath) ? fs.readFileSync(callsPath, "utf8").trim().split(/\n/).filter(Boolean) : []; },
    args() { return fs.existsSync(argsPath) ? fs.readFileSync(argsPath, "utf8") : ""; },
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

// Primary mirror DNS failure is classified as transport; raw credential-like URL text stays hidden.
{
  const f = fixture();
  try {
    const initial = f.run(buildProotAptSourceUpdateCommand("debian", { guestRoot: f.root }), "transport");
    assert.equal(initial.exitCode, 100);
    assert.equal(classifyProotAptSourceUpdate(initial), "transport");
    assert.match(initial.stdout, /AIB_APT_SOURCE_UPDATE_CLASS:transport/);
    assert.doesNotMatch(initial.stdout + initial.stderr, /canonical archive|sentinel-credentials/);
  } finally { f.cleanup(); }
}

{
  const f = fixture();
  try {
    const transient = f.run(buildProotAptSourceUpdateCommand("debian", { guestRoot: f.root }), "http429");
    assert.equal(classifyProotAptSourceUpdate(transient), "transport", "429 permits one bounded official fallback");
    const serverUnavailable = f.run(buildProotAptSourceUpdateCommand("debian", { guestRoot: f.root }), "http503");
    assert.equal(classifyProotAptSourceUpdate(serverUnavailable), "transport", "503 permits one bounded official fallback");
    const denied = f.run(buildProotAptSourceUpdateCommand("debian", { guestRoot: f.root }), "http403");
    assert.equal(classifyProotAptSourceUpdate(denied), "http-client", "403 cannot trigger a fallback");
  } finally { f.cleanup(); }
}

// Primary update refuses custom apt.conf injection and insecure trust/source overrides before any apt call.
{
  const f = fixture();
  try {
    const result = f.run(buildProotAptSourceUpdateCommand("debian", { guestRoot: f.root }), "transport", { APT_CONFIG: "/custom/apt.conf" });
    assert.equal(classifyProotAptSourceUpdate(result), "unsupported");
    assert.deepEqual(f.calls(), [], "custom APT_CONFIG is not executed");
  } finally { f.cleanup(); }
}
for (const [file, content] of [
  ["sources.list", "deb [trusted=yes] https://mirror.example/debian bookworm main\n"],
  ["apt.conf.d/unsafe", 'Acquire::AllowInsecureRepositories "true";\n'],
]) {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.root, "etc/apt", file), content);
    const result = f.run(buildProotAptSourceUpdateCommand("debian", { guestRoot: f.root }), "transport");
    assert.equal(classifyProotAptSourceUpdate(result), "unsupported", file);
    assert.deepEqual(f.calls(), [], `${file} trust override stops before apt/network`);
  } finally { f.cleanup(); }
}

// Broken primary mirror -> one official same-release Debian fallback succeeds, installs, and leaves source config intact.
{
  const f = fixture();
  try {
    const command = buildProotAptFallbackInstallCommand("debian", ["curl", "git"], { guestRoot: f.root });
    const result = f.run(command, "success");
    assert.equal(result.exitCode, 0, result.stdout + result.stderr);
    assert.equal(parseProotAptFallbackResult(result), "installed");
    assert.deepEqual(f.calls(), ["update", "install"]);
    assert.match(f.args(), /AIB_MOCK_FALLBACK_URL:https:\/\/deb\.debian\.org\/debian/);
    assert.match(f.args(), /AllowInsecureRepositories=false/);
    assert.match(f.args(), /AllowDowngradeToInsecureRepositories=false/);
    assert.match(f.args(), /AllowUnauthenticated=false/);
    assert.match(f.args(), /Acquire::Check-Valid-Until=true/);
    assert.doesNotMatch(f.args(), /AllowInsecureRepositories=true|AllowUnauthenticated=true/);
    assert.equal(fs.readFileSync(path.join(f.root, "etc/apt/sources.list"), "utf8"), f.sourceContent);
    assert.deepEqual(fs.readdirSync(path.join(f.root, "tmp")), [], "temporary apt sources/indexes are removed after success");
    assert.match(command, /AIB_APT_FALLBACK_TRIES:1/);
  } finally { f.cleanup(); }
}

// Ubuntu fallback stays in Ubuntu and follows only the configured archive path family.
{
  for (const [url, expected, arch] of [
    ["https://registered.example/ubuntu", "https://archive.ubuntu.com/ubuntu", "amd64"],
    ["https://registered.example/ubuntu-ports", "https://ports.ubuntu.com/ubuntu-ports", "arm64"],
  ]) {
    const f = fixture({ alias: "ubuntu", codename: "noble", sourceUrl: url, sourceSuite: "noble", arch });
    try {
      const result = f.run(buildProotAptFallbackInstallCommand("ubuntu", ["curl"], { guestRoot: f.root }), "success");
      assert.equal(parseProotAptFallbackResult(result), "installed");
      assert.ok(f.args().includes(`AIB_MOCK_FALLBACK_URL:${expected}`));
      assert.ok(!f.args().includes("deb.debian.org"));
    } finally { f.cleanup(); }
  }
}

// The temporary source preserves the selected suite components; an ARM guest with an archive-only path fails closed.
{
  const f = fixture({ alias: "ubuntu", codename: "noble", sourceUrl: "https://registered.example/ubuntu", sourceSuite: "noble", sourceComponents: "main universe multiverse", arch: "amd64" });
  try {
    const result = f.run(buildProotAptFallbackInstallCommand("ubuntu", ["curl"], { guestRoot: f.root }), "success");
    assert.equal(parseProotAptFallbackResult(result), "installed");
    assert.match(f.args(), /AIB_MOCK_FALLBACK_SOURCE:deb \[arch=amd64\] https:\/\/archive\.ubuntu\.com\/ubuntu noble main universe multiverse/);
  } finally { f.cleanup(); }
}
{
  const f = fixture({ alias: "ubuntu", codename: "noble", sourceUrl: "https://registered.example/ubuntu", sourceSuite: "noble", arch: "arm64" });
  try {
    const result = f.run(buildProotAptFallbackInstallCommand("ubuntu", ["curl"], { guestRoot: f.root }), "success");
    assert.equal(parseProotAptFallbackResult(result), "not-eligible");
    assert.deepEqual(f.calls(), [], "an archive/architecture mismatch cannot select another endpoint");
  } finally { f.cleanup(); }
}

// Signature failure, digest/hash mismatch, and signed Release identity mismatch never reach install.
for (const [mode, expected] of [["signature", "signature"], ["hash", "signature"], ["wrong-release", "unsupported"]]) {
  const f = fixture();
  try {
    const result = f.run(buildProotAptFallbackInstallCommand("debian", ["curl"], { guestRoot: f.root }), mode);
    assert.equal(parseProotAptFallbackResult(result), expected, mode);
    assert.deepEqual(f.calls(), ["update"], `${mode} must stop before package install`);
    assert.match(result.stdout, /AIB_APT_FALLBACK_RESULT:(signature|unsupported)/);
    assert.deepEqual(fs.readdirSync(path.join(f.root, "tmp")), [], `${mode} must clean its temporary APT state`);
  } finally { f.cleanup(); }
}

// A mismatched distro ID or suite is not treated as missing and never runs apt.
{
  const f = fixture({ alias: "debian", codename: "bookworm", sourceSuite: "bullseye" });
  try {
    const result = f.run(buildProotAptFallbackInstallCommand("debian", ["curl"], { guestRoot: f.root }), "success");
    assert.equal(parseProotAptFallbackResult(result), "unsupported");
    assert.deepEqual(f.calls(), []);
  } finally { f.cleanup(); }
}
{
  const f = fixture({ alias: "ubuntu", codename: "noble", sourceUrl: "https://registered.example/ubuntu", sourceSuite: "noble" });
  try {
    fs.writeFileSync(path.join(f.root, "etc", "os-release"), "ID=debian\nVERSION_CODENAME=bookworm\n");
    const result = f.run(buildProotAptFallbackInstallCommand("ubuntu", ["curl"], { guestRoot: f.root }), "success");
    assert.equal(parseProotAptFallbackResult(result), "unsupported");
    assert.deepEqual(f.calls(), []);
  } finally { f.cleanup(); }
}

// Unsupported Deb822/multiple-source/custom-APT_CONFIG setups fail closed without rewriting or installing.
{
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.root, "etc/apt/sources.list.d/extra.sources"), "Types: deb\nURIs: https://example.invalid/ubuntu\nSuites: bookworm\nComponents: main\n");
    const result = f.run(buildProotAptFallbackInstallCommand("debian", ["curl"], { guestRoot: f.root }), "success");
    assert.equal(parseProotAptFallbackResult(result), "not-eligible");
    assert.deepEqual(f.calls(), []);
    assert.equal(fs.readFileSync(path.join(f.root, "etc/apt/sources.list"), "utf8"), f.sourceContent);
  } finally { f.cleanup(); }
}
{
  const f = fixture();
  try {
    const result = f.run(buildProotAptFallbackInstallCommand("debian", ["curl"], { guestRoot: f.root }), "success", { APT_CONFIG: "/untrusted/custom.conf" });
    assert.equal(parseProotAptFallbackResult(result), "not-eligible");
    assert.deepEqual(f.calls(), []);
  } finally { f.cleanup(); }
}

// The fixed fallback gets exactly one attempt; transient failure is reported exhausted and never installs.
{
  const f = fixture();
  try {
    const command = buildProotAptFallbackInstallCommand("debian", ["curl"], { guestRoot: f.root });
    const result = f.run(command, "transport");
    assert.equal(parseProotAptFallbackResult(result), "transport-exhausted");
    assert.deepEqual(f.calls(), ["update"]);
    assert.match(result.stdout, /AIB_APT_FALLBACK_TRIES:1/);
    assert.ok(!f.args().includes("https://mirror.example"));
    assert.deepEqual(fs.readdirSync(path.join(f.root, "tmp")), [], "exhausted retry cleans temporary apt state");
  } finally { f.cleanup(); }
}

// Normal guest install also suppresses raw apt output while preserving normalized exit classification.
{
  const f = fixture();
  try {
    const result = f.run(buildProotAptInstallCommand(["curl"], { guestRoot: f.root }), "install-dependency-error");
    assert.equal(result.exitCode, 100);
    assert.match(result.stdout, /AIB_APT_GUEST_INSTALL_CLASS:package/);
    assert.doesNotMatch(result.stdout + result.stderr, /unmet dependencies/);
    assert.match(f.args(), /AllowInsecureRepositories=false/);
    assert.match(f.args(), /AllowDowngradeToInsecureRepositories=false/);
    assert.match(f.args(), /AllowUnauthenticated=false/);
  } finally { f.cleanup(); }
}

console.log("AIB_V275_PROOT_APT_FALLBACK_SELFTEST_OK primary-transport=1 fixed-official-same-family-endpoint=1 signed-release-identity=1 apt-secure=1 signature-hash-mismatch=fail-closed unsupported-release=fail-closed temp-config-restored=1 one-retry-exhaustion=1 raw-output-suppressed=1");
