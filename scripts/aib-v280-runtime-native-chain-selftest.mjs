#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import Module, { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { typescript } from "./test-helpers/load-typescript.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const targets = [
  { backend: "ubuntu-proot", alias: "ubuntu" },
];
function loadStandaloneTs(file) {
  const mod = new Module(file);
  mod.filename = file;
  mod.paths = Module._nodeModulePaths(path.dirname(file));
  const output = typescript.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 }, fileName: file,
  }).outputText;
  mod._compile(output, file);
  return mod.exports;
}
const { buildDiagnosticTraceRecord } = loadStandaloneTs(path.join(root, "lib/diagnostic-trace.ts"));
const traceMetricFixture = buildDiagnosticTraceRecord({
  correlationId: "tr-v283-metrics", action: "runtime.check", step: "rootfs.parser-result", status: "failed",
  backend: "ubuntu-proot", target: "ubuntu", screen: "runtime", parserOutcome: "list-unverified",
  outputMetricSource: "normalized-callback-redacted", stdoutBytes: 4, stdoutChars: 2,
});
assert.equal(traceMetricFixture.parserOutcome, "list-unverified", "bounded parser outcome enum is persisted without output text");
assert.equal(traceMetricFixture.outputMetricSource, "normalized-callback-redacted");
assert.equal(traceMetricFixture.stdoutBytes, 4);
assert.equal(traceMetricFixture.stdoutChars, 2);
const invalidParserTrace = buildDiagnosticTraceRecord({
  correlationId: "tr-v283-invalid", action: "runtime.check", step: "rootfs.parser-result", status: "failed",
  parserOutcome: "raw shell output must never enter enum diagnostics",
});
assert.equal(invalidParserTrace.parserOutcome, undefined, "free-form output is rejected by the trace allowlist");
const termuxExecutorSource = fs.readFileSync(path.join(root, "lib/termux-executor.ts"), "utf8");
assert.match(termuxExecutorSource, /while IFS= read -r line \|\| \[ -n "\$line" \]; do printf '\$\{TERMUX_STDERR_MARKER\}/, "the production capture loop must flush an unterminated final stderr line");
const stderrTailWrapper = `bash -c ${shellQuote("printf AIB_EOF_TAIL >&2")} 2> >(while IFS= read -r line || [ -n "$line" ]; do printf '__AIB_STDERR__%s\\n' "$line"; done)`;
const stderrTailResult = spawnSync("bash", ["-c", stderrTailWrapper], { encoding: "utf8", timeout: 2_000 });
assert.equal(stderrTailResult.status, 0, stderrTailResult.stderr);
assert.equal(stderrTailResult.stdout.trim(), "__AIB_STDERR__AIB_EOF_TAIL", "final stderr bytes without a newline are preserved");
const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "aib-v282-rootfs-fake-native-"));
const noStdbufBin = fs.mkdtempSync(path.join(os.tmpdir(), "aib-v283-no-stdbuf-tools-"));
for (const tool of ["bash", "timeout", "sh", "grep", "id", "cut", "tr", "sed", "head", "uname", "cat", "env", "base64", "chmod", "mkdir", "rm"]) {
  const source = `/bin/${tool}`;
  if (fs.existsSync(source)) fs.symlinkSync(source, path.join(noStdbufBin, tool));
}
function writeExecutable(name, body) {
  const file = path.join(fakeBin, name);
  fs.writeFileSync(file, body, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
}
function shellQuote(value) { return "'" + String(value).replace(/'/g, "'\\''") + "'"; }
function buildNativeRunCommandWrapper(command, { workdir, timeoutMs, clientCommandId }) {
  // Faithful host analogue of TermuxBridgeModule.runCommand: only the Android
  // `am broadcast` side effects are allowed to fail (they are already guarded
  // with `|| true` in production); the timeout, bash quoting, stdbuf, process
  // substitution, line framing, PIPESTATUS, and callback stdout are exercised.
  const timeoutSec = Math.max(1, Math.ceil(timeoutMs / 1000));
  const timeoutCmd = "if ! command -v timeout >/dev/null 2>&1; then echo 'AIBUILDER_TIMEOUT_UNAVAILABLE' >&2; exit 126; fi; timeout --signal=TERM --kill-after=10s " + timeoutSec + "s bash --noprofile --norc -c " + shellQuote(command);
  const liveAction = shellQuote("com.karat.aibuilder.TERMUX_LIVE_OUTPUT");
  const livePackage = shellQuote("com.karat.aibuilder");
  const liveId = shellQuote(clientCommandId);
  return "cd " + shellQuote(workdir) + " 2>/dev/null || { echo 'AIBUILDER_WORKDIR_ERROR' >&2; exit 125; }; " +
    "set -o pipefail; " +
    "if command -v stdbuf >/dev/null 2>&1; then runner() { stdbuf -oL -eL bash -c " + shellQuote(timeoutCmd) + "; }; " +
    "else runner() { bash -c " + shellQuote(timeoutCmd) + "; }; fi; " +
    "runner 2> >(while IFS= read -r line || [ -n \"$line\" ]; do /system/bin/am broadcast -a " + liveAction + " -p " + livePackage + " --es cmdId " + liveId + " --es stream stderr --es chunk \"$line\" >/dev/null 2>&1 || true; done) | " +
    "while IFS= read -r line || [ -n \"$line\" ]; do /system/bin/am broadcast -a " + liveAction + " -p " + livePackage + " --es cmdId " + liveId + " --es stream stdout --es chunk \"$line\" >/dev/null 2>&1 || true; printf '%s\\n' \"$line\"; done; " +
    "rc=\${PIPESTATUS[0]}; exit \"$rc\"";
}
writeExecutable("proot-distro", `#!/bin/sh
case "$1" in
  list)
    if [ "$2" = --quiet ]; then
      if [ "\${AIB_FAKE_SCENARIO:-}" = legacy-list ]; then echo 'unrecognized option: --quiet' >&2; exit 2; fi
      if [ "\${AIB_FAKE_SCENARIO:-}" = missing-rootfs ]; then exit 0; fi
      printf '%s\\n' "\${AIB_FAKE_ALIAS}"
      exit 0
    fi
    if [ "\${AIB_FAKE_SCENARIO:-}" = missing-rootfs ]; then
      echo "No containers are installed."
    else
      echo "Installed containers:"
      echo
      echo "  * \${AIB_FAKE_ALIAS}"
    fi
    exit 0
    ;;
  login)
    alias="\${2:-}"
    shift 2
    [ "\${1:-}" = -- ] && shift
    if [ "\${AIB_FAKE_SCENARIO:-}" = missing-rootfs ]; then
      echo "Error: container '\${alias}' is not installed." >&2
      exit 1
    fi
    case "\${AIB_FAKE_SCENARIO:-}" in
      wrong-os-id) [ "$alias" = ubuntu ] && AIB_FAKE_GUEST_ID=debian || AIB_FAKE_GUEST_ID=ubuntu ;;
      *) AIB_FAKE_GUEST_ID="$alias" ;;
    esac
    export AIB_FAKE_GUEST_ID
    exec "$@"
    ;;
  *) echo "fake proot-distro: unsupported operation" >&2; exit 90 ;;
esac
`);
writeExecutable("grep", `#!/bin/sh
case " $* " in
  *" /etc/os-release "*) printf 'ID=%s\\n' "\${AIB_FAKE_GUEST_ID:-unknown}"; exit 0 ;;
esac
exec /usr/bin/grep "$@"
`);
writeExecutable("uname", `#!/bin/sh
if [ "\${1:-}" = -m ]; then echo aarch64; exit 0; fi
exec /usr/bin/uname "$@"
`);
writeExecutable("id", `#!/bin/sh
if [ "\${1:-}" = -u ]; then echo 1000; exit 0; fi
exec /usr/bin/id "$@"
`);
writeExecutable("sh", `#!/bin/sh
exec /bin/sh "$@"
`);

function rootfsFrame(alias, state = "healthy") {
  const loginId = state === "wrong-id" ? (alias === "ubuntu" ? "debian" : "ubuntu") : alias;
  const list = state === "missing"
    ? "No containers are installed."
    : `Installed containers:\n\n  * ${alias}`;
  const loginExit = state === "healthy" || state === "wrong-id" ? 0 : 1;
  const login = state === "healthy" || state === "wrong-id"
    ? `AIB_PROBE_ID:${loginId}\nAIB_PROBE_UID:1000\nAIB_PROBE_UNAME:aarch64`
    : state === "missing"
      ? `Error: container '${alias}' is not installed.`
      : "login failed";
  return [
    "AIB_PROBE_BEGIN", "AIB_PROOT_TOOL:AVAILABLE", "AIB_HOST_UNAME:aarch64",
    "AIB_LIST_EXIT:0", "AIB_LIST_BEGIN", list, "AIB_LIST_END",
    `AIB_LOGIN_EXIT:${loginExit}`, "AIB_LOGIN_BEGIN", login, "AIB_LOGIN_END", "AIB_PROBE_END",
  ].join("\n");
}

function makeHarness(alias, scenario = "healthy", permission = true, nativeShellWrapper = false, noStdbuf = false) {
  const calls = [];
  const traceRecords = [];
  const logEntries = [];
  const guestRoutes = [];
  const runErrors = [];
  let callbackNumber = 0;
  const logger = {
    add: (...args) => logEntries.push(args),
    trace: (record) => traceRecords.push(record),
  };
  const stagedLongCommandIds = new Set();
  const stagedScriptContents = new Map();
  const dispatchedScripts = [];
  const native = {
    async isTermuxInstalled() { return true; },
    async hasRunCommandPermission() { return permission; },
    async runCommand(command, workdir, timeoutMs, backendLabel, clientCommandId) {
      callbackNumber += 1;
      const baseCommandId = String(clientCommandId || "").replace(/-(?:prep|chunk-\d+|chmod)$/, "");
      const commandId = String(clientCommandId || "");
      const stagedScript = stagedScriptContents.get(commandId) || "";
      const stagedLaunch = stagedLongCommandIds.has(commandId) && command.includes("aib-long-cmd-");
      const stagedRootfs = stagedLaunch && stagedScript.includes("AIB_PROBE_BEGIN");
      const stagedHostTool = stagedLaunch && stagedScript.includes("AIB_PROOT_TOOL:AVAILABLE");
      calls.push({ command, workdir, timeoutMs, backendLabel, clientCommandId, stagedRootfs, stagedHostTool });
      if (command.includes("PREP_OK") || command.includes("base64 -d") || command.includes("chmod +x")) {
        if (command.includes("base64 -d")) {
          const encodedChunk = command.match(/printf '%s' '([^']*)'/)?.[1];
          if (encodedChunk) {
            stagedScriptContents.set(baseCommandId, (stagedScriptContents.get(baseCommandId) || "") + Buffer.from(encodedChunk, "base64").toString("utf8"));
          }
        }
        const stagedWrite = spawnSync("bash", ["-c", command], {
          encoding: "utf8",
          env: { ...process.env, PATH: `${fakeBin}:${noStdbuf ? noStdbufBin : "/usr/bin:/bin"}`, HOME: fakeBin },
          timeout: 5_000,
        });
        if (stagedWrite.error) throw stagedWrite.error;
        if (command.includes("PREP_OK") && stagedWrite.status === 0 && stagedWrite.stdout.includes("PREP_OK")) {
          stagedLongCommandIds.add(baseCommandId);
        }
        const nativeCommandId = callbackNumber.toString(16).padStart(32, "0");
        return { commandId: clientCommandId, nativeCommandId, stdout: stagedWrite.stdout, stderr: stagedWrite.stderr, exitCode: stagedWrite.status ?? -1, timedOut: false };
      }
      if (scenario === "rootfs-access-denied" && (stagedRootfs || command.includes("AIB_PROBE_BEGIN"))) throw new Error("Permission denied by Termux RUN_COMMAND service");
      if (scenario === "allow-external-denied") throw new Error("Termux rejected RUN_COMMAND; allow-external-apps=false");
      const nativeCommandId = callbackNumber.toString(16).padStart(32, "0");
      if (command.includes("AIBUILDER_OK")) {
        if (scenario === "termux-null") return null;
        if (scenario === "termux-private-throw") throw new Error("TypeError: PRIVATE_TOKEN=raw-secret /storage/emulated/0/AIBuilderTermux/private.ts source=private-project-content");
        if (scenario === "termux-cancelled") throw new Error("AbortError: RUN_COMMAND cancelled by caller");
        if (scenario === "termux-wrong-id") return { commandId: "tr-unrelated-command", nativeCommandId, stdout: "AIBUILDER_OK", stderr: "", exitCode: 0, timedOut: false };
        if (scenario === "termux-timeout") return { commandId: clientCommandId, nativeCommandId, stdout: "", stderr: "", exitCode: -1, timedOut: true };
        if (scenario === "termux-truncated") return { commandId: clientCommandId, nativeCommandId, stdout: "AIBUILDER_OK", stderr: "", exitCode: 0, timedOut: false, outputTruncated: true };
        if (scenario === "termux-empty") return { commandId: clientCommandId, nativeCommandId, stdout: "", stderr: "", exitCode: 0, timedOut: false };
        const stdout = scenario === "termux-utf8" ? "AIBUILDER_OK\nПривет🙂" : "AIBUILDER_OK";
        return { commandId: clientCommandId, nativeCommandId, stdout, stderr: "", exitCode: 0, timedOut: false };
      }
      if (stagedRootfs || command.includes("AIB_PROBE_BEGIN")) {
        if (stagedRootfs) {
          dispatchedScripts.push({ clientCommandId: commandId, kind: "rootfs", script: stagedScript });
          stagedLongCommandIds.delete(commandId);
          stagedScriptContents.delete(commandId);
        }
        if (scenario === "empty-rootfs") return { commandId: clientCommandId, nativeCommandId, stdout: "", stderr: "", exitCode: 0, timedOut: false };
        if (scenario === "unframed-rootfs") return { commandId: clientCommandId, nativeCommandId, stdout: "single-line runner output without a probe envelope", stderr: "", exitCode: 0, timedOut: false };
        if (scenario === "null-rootfs") return null;
        if (scenario === "timeout-rootfs") return { commandId: clientCommandId, nativeCommandId, stdout: "", stderr: "", exitCode: -1, timedOut: true };
        if (scenario === "truncated-rootfs") return { commandId: clientCommandId, nativeCommandId, stdout: rootfsFrame(alias), stderr: "", exitCode: 0, timedOut: false, outputTruncated: true };
        if (scenario === "wrong-command-id") return { commandId: "js-other-request", nativeCommandId, stdout: rootfsFrame(alias), stderr: "", exitCode: 0, timedOut: false };
        if (["healthy", "legacy-list", "missing-rootfs", "wrong-os-id"].includes(scenario)) {
          const shellCommand = nativeShellWrapper
            ? buildNativeRunCommandWrapper(command, { workdir: fakeBin, timeoutMs, clientCommandId })
            : command;
          const executed = spawnSync("bash", ["-c", shellCommand], {
            encoding: "utf8",
            env: {
              ...process.env,
              PATH: `${fakeBin}:${noStdbuf ? noStdbufBin : "/usr/bin:/bin"}`,
              HOME: fakeBin,
              PREFIX: path.join(fakeBin, "prefix"),
              AIB_FAKE_ALIAS: alias,
              AIB_FAKE_SCENARIO: scenario,
            },
            timeout: 5_000,
            maxBuffer: 1024 * 1024,
          });
          if (executed.error) throw executed.error;
          return { commandId: clientCommandId, nativeCommandId, stdout: executed.stdout, stderr: executed.stderr, exitCode: executed.status ?? -1, timedOut: false };
        }
        const state = scenario === "missing-rootfs" ? "missing" : scenario === "wrong-os-id" ? "wrong-id" : "healthy";
        const frame = rootfsFrame(alias, state);
        if (scenario === "marker-on-stderr") return { commandId: clientCommandId, nativeCommandId, stdout: "", stderr: frame, exitCode: 0, timedOut: false };
        return { commandId: clientCommandId, nativeCommandId, stdout: frame, stderr: "", exitCode: 0, timedOut: false };
      }
      if (stagedHostTool) {
        dispatchedScripts.push({ clientCommandId: commandId, kind: "host-tool", script: stagedScript });
        const shellCommand = nativeShellWrapper
          ? buildNativeRunCommandWrapper(command, { workdir: fakeBin, timeoutMs, clientCommandId })
          : command;
        const executed = spawnSync("bash", ["-c", shellCommand], {
          encoding: "utf8",
          env: { ...process.env, PATH: `${fakeBin}:${noStdbuf ? noStdbufBin : "/usr/bin:/bin"}`, HOME: fakeBin, PREFIX: path.join(fakeBin, "prefix") },
          timeout: 5_000,
        });
        if (executed.error) throw executed.error;
        stagedLongCommandIds.delete(commandId);
        stagedScriptContents.delete(commandId);
        return { commandId: clientCommandId, nativeCommandId, stdout: executed.stdout, stderr: executed.stderr, exitCode: executed.status ?? -1, timedOut: false };
      }
      if (command.includes("AIB_PROOT_TOOL:AVAILABLE")) {
        return { commandId: clientCommandId, nativeCommandId, stdout: "AIB_PROOT_TOOL:AVAILABLE", stderr: "", exitCode: 0, timedOut: false };
      }
      // Guest baseline command checks are exit-status probes; no textual output is expected.
      return { commandId: clientCommandId, nativeCommandId, stdout: "", stderr: "", exitCode: 0, timedOut: false };
    },
  };

  const rn = {
    NativeModules: { TermuxBridge: native },
    NativeEventEmitter: class { addListener() { return { remove() {} }; } },
    Platform: { OS: "android" },
    Linking: { async openSettings() { return true; }, async canOpenURL() { return true; }, async openURL() { return true; } },
  };
  const cache = new Map();
  function resolveTs(parent, request) {
    const base = path.resolve(path.dirname(parent), request);
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, path.join(base, "index.ts")]) {
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
      if (request === "react-native") return rn;
      const resolved = request.startsWith(".") ? resolveTs(file, request) : null;
      if (resolved) {
        const name = path.basename(resolved);
        if (name === "persistent-logger.ts") return { persistentLogger: logger };
        if (name === "agent-shell-backend.ts") return {
          getBuildBackend: () => "termux", // deliberately stale global; explicit Runtime selection must win
          backendLabel: (backend) => backend === "ubuntu-proot" ? (alias === "ubuntu" ? "Ubuntu" : "Debian") : "Termux",
          isLinuxProotBackend: (backend) => backend === "ubuntu-proot",
          resolveAgentExecutionBackend: (_command, backend) => backend,
          wrapCommandForAgentShell: (command, _workdir, backend) => {
            guestRoutes.push(backend);
            return `FAKE_GUEST:${backend} ${command}`;
          },
        };
        if (name === "context-engine.ts") return { compressShellOutput: (output) => output };
        if (name === "termux-command-queue.ts") return { enqueueTermuxCommand: (run) => run() };
        return loadTs(resolved);
      }
      return createRequire(file)(request);
    };
    const output = typescript.transpileModule(fs.readFileSync(file, "utf8"), {
      compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022, esModuleInterop: true },
      fileName: file,
    }).outputText;
    mod._compile(output, file);
    return mod.exports;
  }

  const { inspectProotRuntimeReadiness } = loadTs(path.join(root, "lib/runtime-environment-check.ts"));
  const { runPackageCommand } = loadTs(path.join(root, "lib/package-backend.ts"));
  const { normalizeNativeCommandResult, checkTermuxReadiness } = loadTs(path.join(root, "lib/termux-bridge.ts"));
  return {
    calls, traceRecords, logEntries, guestRoutes, runErrors, dispatchedScripts, native,
    inspect: (backend) => inspectProotRuntimeReadiness(backend, {
      traceId: `test-${alias}-${scenario}`,
      onRootfsProbeOutcome: (parserOutcome) => traceRecords.push({ step: "rootfs.parser-result", parserOutcome }),
      run: async (command, options) => {
        try { return await runPackageCommand(command, options); }
        catch (error) { runErrors.push(error instanceof Error ? error.message : String(error)); throw error; }
      },
    }),
    readiness: (options) => checkTermuxReadiness(options),
    normalizeNativeCommandResult,
  };
}

for (const { backend, alias } of targets) {
  // Full read-only Check: Runtime classifier -> package router -> guarded executor -> JS bridge -> fake Kotlin callback.
  {
    const h = makeHarness(alias, "healthy", true, true);
    const result = await h.inspect(backend);
    const callSummary = h.calls.map((call) => ({ probe: call.stagedRootfs, host: call.command.includes("AIB_PROOT_TOOL:AVAILABLE"), long: call.command.includes("aib-long-cmd-"), guest: call.command.includes("FAKE_GUEST:") }));
    const traceSummary = h.traceRecords.map(({ step, status, errorCategory, resultCode }) => ({ step, status, errorCategory, resultCode }));
    assert.equal(result.status, "ready", `${alias}: correlated callback markers produce readiness (${result.phase}/${result.reason || "-"}: ${result.detail}; fake calls=${JSON.stringify(callSummary)}; traces=${JSON.stringify(traceSummary)}; runErrors=${JSON.stringify(h.runErrors)})`);
    assert.equal(result.rootfsState?.healthy, true);
    assert.ok(h.traceRecords.some((entry) => entry.step === "rootfs.parser-result" && entry.parserOutcome === "healthy"), `${alias}: parser enum outcome is available without raw output`);
    const stagedRootfsCalls = h.calls.filter((call) => call.stagedRootfs);
    assert.equal(stagedRootfsCalls.length, 1, `${alias}: rootfs probe is staged once through the unique script path`);
    const rootfsDispatch = stagedRootfsCalls[0];
    assert.match(rootfsDispatch.command, /aib-long-cmd-[A-Za-z0-9_-]+\.sh/, `${alias}: staged probe launches its isolated script`);
    assert.ok(rootfsDispatch.command.length <= 1200, `${alias}: final staged launch stays below the direct command threshold`);
    assert.equal(rootfsDispatch.command.includes("\n"), false, `${alias}: final staged launch is a single-line command`);
    assert.doesNotMatch(rootfsDispatch.clientCommandId, /-(?:prep|chunk-\d+|chmod)$/);
    assert.equal(h.logEntries.filter(([level, tag, message]) => level === "warn" && String(tag).includes("TermuxBridge") && /long-cmd prep failed/i.test(String(message))).length, 0, `${alias}: staged probe preparation succeeds without fallback warning`);
    assert.equal(h.calls[0].backendLabel, "Termux");
    assert.equal(h.calls[1].backendLabel, "Termux");
    assert.equal(h.guestRoutes.length, 5, `${alias}: guest checks use explicit selected backend, not deliberately stale global Termux selection`);
    assert.ok(h.guestRoutes.every((route) => route === backend));
    assert.ok(h.calls.every((call) => /^js-/.test(call.clientCommandId || "")), "every native dispatch gets a JS correlation ID");
    const resultTrace = h.traceRecords.filter((entry) => entry.step === "bridge.command-result");
    assert.equal(resultTrace.length, 7);
    assert.ok(resultTrace.every((entry) => /^[a-f0-9]{32}$/.test(entry.nativeCommandId || "")), "Kotlin UUID stays distinct and is attached to each JS command trace");
    assert.ok(resultTrace.every((entry) => entry.termuxExternalApps === "not-observed"), "the Android app never claims to read Termux allow-external-apps");
    const dispatches = h.traceRecords.filter((entry) => entry.step === "bridge.command-dispatch");
    assert.equal(dispatches.length, resultTrace.length);
    for (const start of dispatches) {
      assert.ok(resultTrace.some((finish) => finish.commandId === start.commandId), `${alias}: every JS dispatch has a result with the same command ID`);
    }
  }

  // Termux may not have `stdbuf`; the production Kotlin wrapper deliberately
  // falls back to `bash -c`. Exercise that exact branch with the tool omitted.
  {
    const h = makeHarness(alias, "healthy", true, true, true);
    const result = await h.inspect(backend);
    assert.equal(result.status, "ready", `${alias}: no-stdbuf RUN_COMMAND wrapper still returns complete framed output (${result.phase}/${result.reason || "-"}: ${result.detail})`);
  }

  // Older supported proot-distro releases may not implement --quiet. The
  // production probe retries the legacy listing and still uses login as its
  // primary, exact ground truth for readiness.
  {
    const h = makeHarness(alias, "legacy-list");
    const result = await h.inspect(backend);
    assert.equal(result.status, "ready", `${alias}: legacy list fallback must preserve healthy login evidence (${result.phase}/${result.reason || "-"}: ${result.detail})`);
    const rootfsScript = h.dispatchedScripts.find((entry) => entry.kind === "rootfs")?.script;
    assert.ok(rootfsScript?.includes("proot-distro list --quiet"));
    assert.ok(rootfsScript?.includes("proot-distro list 2>&1"));
  }

  // Empty stdout is not an automatic failure when a complete, valid marker envelope was returned on stderr.
  {
    const h = makeHarness(alias, "marker-on-stderr");
    const result = await h.inspect(backend);
    assert.equal(result.status, "ready", `${alias}: parser examines callback stderr as well as stdout (${result.phase}/${result.reason || "-"}: ${result.detail}; rootfs=${JSON.stringify(result.rootfsState)}; calls=${JSON.stringify(h.calls.map((call) => ({ stagedRootfs: call.stagedRootfs, stagedHostTool: call.stagedHostTool, command: call.command.slice(0, 100) })))}; runErrors=${JSON.stringify(h.runErrors)})`);
    assert.ok(h.dispatchedScripts.some((entry) => entry.kind === "rootfs"), "framed rootfs probe runs from its staged script");
  }

  // Exit 0 + empty stdout/stderr has no marker evidence and stays unknown, never absent/ready.
  {
    const h = makeHarness(alias, "empty-rootfs");
    const result = await h.inspect(backend);
    assert.equal(result.status, "error");
    assert.equal(result.rootfs, "unknown");
    assert.equal(result.rootfsState?.installed, null);
    assert.ok(h.traceRecords.some((entry) => entry.step === "rootfs.parser-result" && entry.parserOutcome === "incomplete-envelope"));
    assert.notEqual(result.status, "missing");
  }

  // A non-empty single-line result without the production marker envelope remains unknown.
  {
    const h = makeHarness(alias, "unframed-rootfs");
    const result = await h.inspect(backend);
    assert.equal(result.status, "error");
    assert.equal(result.rootfs, "unknown");
    assert.equal(result.rootfsState?.installed, null);
    assert.equal(result.reason, "unknown-status");
    const persisted = JSON.stringify(h.logEntries);
    assert.equal(persisted.includes("single-line runner output without a probe envelope"), false, "raw unframed output is omitted from persistent logs");
    assert.ok(persisted.includes("COMMAND_OUTPUT_OMITTED"), "safe output-omitted summary remains diagnostic");
    assert.equal(h.logEntries.filter(([level, tag]) => level === "warn" && String(tag).includes(":stdout")).length, 0, "exit-0 unframed output creates no unnecessary stdout warning");
  }

  for (const [scenario, expectedReason] of [
    ["null-rootfs", "bridge-failure"],
    ["timeout-rootfs", "timeout"],
    ["truncated-rootfs", "truncated-output"],
    ["wrong-command-id", "bridge-failure"],
  ]) {
    const h = makeHarness(alias, scenario);
    const result = await h.inspect(backend);
    assert.equal(result.status, "error", `${alias}/${scenario} remains inconclusive`);
    assert.equal(result.rootfs, "unknown");
    assert.equal(result.reason, expectedReason);
    assert.ok(result.missingItems.length === 0, `${alias}/${scenario}: uncertainty must not become a missing rootfs`);
  }

  // A complete marker proving explicit absence remains the only rootfs-missing state.
  {
    const h = makeHarness(alias, "missing-rootfs");
    const result = await h.inspect(backend);
    assert.equal(result.status, "missing");
    assert.equal(result.rootfs, "missing");
    assert.equal(result.rootfsState?.installed, false);
    assert.ok(h.traceRecords.some((entry) => entry.step === "rootfs.parser-result" && entry.parserOutcome === "missing"));
  }

  // An access denial after the Termux host preflight never becomes rootfs missing.
  {
    const h = makeHarness(alias, "rootfs-access-denied");
    const result = await h.inspect(backend);
    assert.equal(result.status, "error");
    assert.equal(result.reason, "permission");
    assert.equal(result.rootfs, "unknown");
    assert.equal(result.rootfsState, undefined);
    assert.ok(h.dispatchedScripts.some((entry) => entry.kind === "host-tool" && entry.script.includes("AIB_PROOT_TOOL:AVAILABLE")), `${alias}: host tool preflight precedes the denied rootfs call`);
    assert.ok(h.calls.some((call) => call.stagedRootfs), `${alias}: access denial occurs on the selected staged rootfs probe`);
    assert.ok(!h.calls.some((call) => call.command.includes("proot-distro install")), `${alias}: access denial never starts an install`);
  }

  // Android permission grant is read separately and gates dispatch; no native RUN_COMMAND occurs when missing.
  {
    const h = makeHarness(alias, "healthy", false);
    const result = await h.inspect(backend);
    assert.equal(result.status, "error");
    assert.equal(result.reason, "permission");
    assert.equal(h.calls.length, 0, "missing Android grant blocks before any Termux service dispatch");
    assert.ok(h.traceRecords.some((entry) => entry.androidRunCommand === "missing" && entry.termuxExternalApps === "not-observed"));
  }

  // Termux allow-external-apps denial is reported as a separate observed failure after Android grant succeeds.
  {
    const h = makeHarness(alias, "allow-external-denied", true);
    const result = await h.inspect(backend);
    assert.equal(result.status, "error");
    assert.equal(h.calls.filter((call) => !/-(?:prep|chunk-\d+|chmod)$/.test(call.clientCommandId || "")).length, 1, "one final staged shell execution fails after script preparation");
    assert.ok(h.traceRecords.some((entry) => entry.androidRunCommand === "granted" && entry.termuxExternalApps === "not-observed"));
    assert.ok(h.traceRecords.some((entry) => entry.termuxExternalApps === "blocked"), "only the Termux service rejection marks allow-external-apps blocked");
  }

  // Wrong distro identity is installed-but-unhealthy, not a replacement candidate.
  {
    const h = makeHarness(alias, "wrong-os-id");
    const result = await h.inspect(backend);
    assert.equal(result.status, "error");
    assert.equal(result.rootfs, "unknown");
    assert.equal(result.rootfsState?.installed, true);
    assert.equal(result.rootfsState?.healthy, false);
  }
}

const runtimeUiSource = fs.readFileSync(path.join(root, "app/runtime.tsx"), "utf8");
assert.ok(runtimeUiSource.includes("step: \"rootfs.parser-result\""), "Runtime Check persists the parser outcome enum");
assert.ok(runtimeUiSource.includes("step: \"preflight.rootfs-parser-result\""), "click-time Prepare persists its fresh parser outcome enum");
assert.ok(runtimeUiSource.includes('selectedReadiness?.rootfs === "unknown"'), "unknown rootfs gets a dedicated manual recovery hint");
assert.ok(runtimeUiSource.includes("не сбрасывайте его") && runtimeUiSource.includes("Prepare remains blocked while the state is unknown"), "manual recovery is read-only, explicitly non-destructive, and does not weaken Prepare gating");

// Direct Termux-host readiness: Android's special grant and Termux's separately observed RUN_COMMAND result.
{
  const good = makeHarness("ubuntu", "termux-utf8");
  const ready = await good.readiness({ deep: true, refreshPermission: true });
  assert.equal(ready.ready, true, `Termux readiness failed: reasons=${ready.reasons.join(",")} detail=${ready.probeDetail || "-"} traces=${JSON.stringify(good.traceRecords)}`);
  assert.equal(good.calls.length, 1);
  assert.equal(good.calls[0].timeoutMs, 15_000, "the existing bounded readiness deadline is unchanged");
  const probe = good.traceRecords.find((entry) => entry.step === "native.result");
  assert.equal(probe.stdoutBytes, new TextEncoder().encode("AIBUILDER_OK\nПривет🙂").length, "UTF-8 byte count is not a JavaScript code-unit count");
  assert.ok(good.traceRecords.some((entry) => entry.step === "readiness.android-permissions" && entry.androidRunCommand === "granted" && entry.termuxExternalApps === "not-observed"));
  assert.ok(good.traceRecords.some((entry) => entry.step === "readiness.result" && entry.resultCode === "ready"));
}

for (const scenario of ["termux-null", "termux-wrong-id", "termux-timeout", "termux-truncated", "termux-empty", "allow-external-denied", "termux-private-throw", "termux-cancelled"]) {
  const h = makeHarness("ubuntu", scenario);
  const result = await h.readiness({ deep: true, refreshPermission: true });
  assert.equal(result.ready, false, `${scenario}: incomplete callbacks never become ready`);
  assert.ok(result.reasons.includes("run_command_probe_failed"), `${scenario}: fail closed with probe failure`);
  const persisted = JSON.stringify([...h.traceRecords, ...h.logEntries]);
  for (const privateValue of ["raw-secret", "AIBuilderTermux", "private.ts", "private-project-content", "unrelated-command"]) {
    assert.equal(persisted.includes(privateValue), false, `${scenario}: persisted diagnostics omit ${privateValue}`);
  }
  if (scenario === "termux-timeout") assert.ok(h.traceRecords.some((entry) => entry.status === "timed_out" && entry.errorCategory === "timeout"));
  if (scenario === "termux-truncated") assert.ok(h.traceRecords.some((entry) => entry.errorCategory === "output-truncated"));
  if (scenario === "allow-external-denied") assert.ok(h.traceRecords.some((entry) => entry.termuxExternalApps === "blocked"));
  if (scenario === "termux-cancelled") {
    const start = h.traceRecords.find((entry) => entry.step === "native.dispatch");
    const finish = h.traceRecords.find((entry) => entry.step === "native.result");
    assert.equal(finish.status, "cancelled");
    assert.equal(finish.commandId, start.commandId, "cancelled callback path retains its dispatch correlation ID");
  }
}

{
  const h = makeHarness("ubuntu", "termux-utf8", false);
  const blocked = await h.readiness({ deep: true, refreshPermission: true });
  assert.equal(blocked.ready, false);
  assert.deepEqual(blocked.reasons, ["run_command_permission_missing"]);
  assert.equal(h.calls.length, 0, "Android grant failure blocks before any Termux service dispatch");
}

// Strict callback contract and source-level one-shot/cancellation/permission assertions.
{
  const h = makeHarness("ubuntu");
  assert.throws(() => h.normalizeNativeCommandResult(null, "js-test"), /TERMUX_NATIVE_RESULT_MISSING/);
  assert.throws(() => h.normalizeNativeCommandResult({ stdout: "", stderr: "", exitCode: 0, timedOut: false, commandId: "js-wrong" }, "js-expected"), /TERMUX_NATIVE_RESULT_ID_MISMATCH/);
  assert.throws(() => h.normalizeNativeCommandResult({ stdout: "", stderr: "", exitCode: 0, timedOut: false, commandId: "tr-wrong" }, "tr-expected"), /TERMUX_NATIVE_RESULT_ID_MISMATCH/);
  assert.throws(() => h.normalizeNativeCommandResult({ stdout: "", stderr: "", exitCode: 0, timedOut: false, nativeCommandId: "bad" }, "js-test"), /TERMUX_NATIVE_RESULT_NATIVE_ID_INVALID/);
  const plugin = fs.readFileSync(path.join(root, "plugins/withTermuxBridge.js"), "utf8");
  assert.match(plugin, /getBundleExtra\("result"\)/, "native receiver reads the official Termux result Bundle");
  assert.match(plugin, /getString\("stdout", ""\)[\s\S]{0,100}getString\("stderr", ""\)/, "stdout and stderr are extracted independently");
  assert.match(plugin, /getInt\("exitCode", -1\)/, "exit status is read from the documented Bundle field");
  assert.match(plugin, /originalLength\("stdout_original_length", stdout\)[\s\S]{0,100}originalLength\("stderr_original_length", stderr\)/, "documented original-length fields detect truncated callback output");
  assert.match(plugin, /results\.putIfAbsent\(id, result\)/, "native callback store accepts one result per request");
  const cancelStart = plugin.indexOf("fun cancel(id: String)");
  const cancelEnd = plugin.indexOf("fun cancelAll()", cancelStart);
  const cancelBody = cancelStart >= 0 && cancelEnd > cancelStart ? plugin.slice(cancelStart, cancelEnd) : "";
  assert.ok(cancelBody.includes("waiters.remove(id)") && cancelBody.includes("results.remove(id)"), "cancel removes pending and already-published callback data");
  assert.match(plugin, /waiters\[id\] \?: return/, "late callback after timeout/cancel is discarded");
  assert.match(plugin, /FLAG_ONE_SHOT/, "each PendingIntent remains one-shot");
  assert.match(plugin, /data = android\.net\.Uri\.parse\("aib-termux:\/\/result\/" \+ id\)/, "unique URI prevents PendingIntent identity hash collisions");
  assert.ok(plugin.includes("(?:js|tr)-[A-Za-z0-9_-]{1,96}"), "native bridge retains both JS and trace ID families");
  assert.match(plugin, /RUN_COMMAND_PERMISSION/, "native source retains the package-scoped Android grant check");
  assert.match(plugin, /allow-external-apps=true/, "Termux setting is only explained as a separate configuration, never bypassed");
}

console.log("OK: v280 fake-native production readiness chain with real command guards, callback integrity, permission separation, both distro parsers, unknown-vs-missing safety, and native one-shot source contracts");
fs.rmSync(fakeBin, { recursive: true, force: true });
fs.rmSync(noStdbufBin, { recursive: true, force: true });
