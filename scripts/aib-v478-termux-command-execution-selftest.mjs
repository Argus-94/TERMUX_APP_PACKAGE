import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const native = read("plugins/withTermuxBridge.js");
const bridge = read("lib/termux-bridge.ts");
const consoleScreen = read("app/terminal.tsx");
const sessionManagerSource = read("core/enhancements/terminal/TerminalSessionManager.ts");

// Embedded one-shot commands execute the app-owned Bash directly with a bounded process lifecycle.
assert.match(native, /val builder = ProcessBuilder\(AibEmbeddedTermuxBootstrapInstaller\.shellCommand\(prefix, "--noprofile", "--norc", "-c", wrapper, "aib-embedded", command, rootPidFile\.absolutePath\)\)\.directory\(requestedCwd\)/);
assert.match(native, /awaitAibEmbeddedRootPid\(process!!, rootPidFile, 1_000L\)/);
assert.match(native, /captureAibEmbeddedOutput\(process!!\.inputStream\)/, "stdout is drained from the actual process");
assert.match(native, /captureAibEmbeddedOutput\(process!!\.errorStream\)/, "stderr is drained from the actual process");
assert.match(native, /process!!\.outputStream\.close\(\)/, "one-shot ProcessBuilder stdin is closed to deliver EOF");
assert.match(native, /stopAibEmbeddedProcess\(process!!, processRoot!!, trackedDescendants\)/, "cancellation stops the active embedded process tree");
assert.match(native, /durationMs/);
assert.match(native, /emitEmbedded.*Progress|AibEmbeddedProcessRegistry\.active/, "progress/cancellation are tied to the active native process, not external callbacks");
assert.match(native, /AibEmbeddedProcessRegistry\.active\.putIfAbsent/);
assert.match(native, /cancelEmbeddedTermuxCommand/);
assert.match(native, /waitForAibEmbeddedProcess\(process!!, timeout, processRoot!!, trackedDescendants\)/,
  "the one-shot command wait must monitor the validated root and tracked descendants");
assert.match(native, /outputTruncated/);
assert.match(native, /val code = embeddedExecFailureCode\(error, phase\)\s+promise\.reject\(code, embeddedExecFailureDetail\(error, phase\)\)/);
const heartbeat = native.slice(native.indexOf("private fun emitHeartbeat"), native.indexOf("private val TERMUX_PACKAGE"));
assert.doesNotMatch(heartbeat, /stdoutBytes/,
  "heartbeat must not claim a measured zero-byte count when output is only returned in the final callback");
assert.match(heartbeat, /live stdout не измеряется/);
assert.match(bridge, /callbackMissing\?: boolean/);
assert.match(bridge, /result\.callbackMissing !== undefined && typeof result\.callbackMissing !== "boolean"/);
assert.match(bridge, /errorCategory: "callback-missing"/);
assert.match(bridge, /result callback missing \(completion unknown\)/);
assert.match(consoleScreen, /Output appears when the command finishes; use PTY for commands that wait for input/);
assert.match(consoleScreen, /commandElapsedSeconds/);
assert.match(sessionManagerSource, /subscribeTerminalOutput\(\(event\)/);
assert.match(sessionManagerSource, /appendScrollback\(event\.sessionId, chunk\)/);
assert.doesNotMatch(consoleScreen, /terminalUx\.appendScrollback\(event\.sessionId/,
  "screen unmounting must not be the only owner of terminal output persistence");

const quote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;
function shellHarness(command, timeoutSeconds = 4) {
  const inner = `if ! command -v timeout >/dev/null 2>&1; then exit 126; fi; timeout --signal=TERM --kill-after=1s ${timeoutSeconds}s bash --noprofile --norc -c ${quote(command)} </dev/null`;
  const runner = `if command -v stdbuf >/dev/null 2>&1; then runner() { stdbuf -oL -eL bash -c ${quote(inner)}; }; else runner() { bash -c ${quote(inner)}; }; fi;`;
  return `export PREFIX=/data/data/com.termux/files/usr; set -o pipefail; ${runner} runner 2> >(while IFS= read -r line || [ -n "$line" ]; do :; done) | while IFS= read -r line || [ -n "$line" ]; do printf '%s\\n' "$line"; done; rc=\${PIPESTATUS[0]}; exit "$rc"`;
}
function run(command, timeoutSeconds = 4, wallTimeout = 6000) {
  return spawnSync("bash", ["-c", shellHarness(command, timeoutSeconds)], {
    encoding: "utf8",
    timeout: wallTimeout,
    maxBuffer: 1024 * 1024,
  });
}

// Normal output: the actual test command from the report, executed through the same nested-bash/timeout/EOF/pipeline shape.
const normal = run(`printf 'PREFIX=%s\\n' "$PREFIX"; printf 'DATA=%s\\n' "\${PREFIX%/files/usr}"`);
assert.equal(normal.status, 0, `${normal.stderr}\n${normal.error ?? ""}`);
assert.match(normal.stdout, /PREFIX=\/data\/data\/com\.termux\/files\/usr/);
assert.match(normal.stdout, /DATA=\/data\/data\/com\.termux/);

// A successful command with no stdout is valid, not a broken callback.
const silent = run("true");
assert.equal(silent.status, 0, `${silent.stderr}\n${silent.error ?? ""}`);
assert.equal(silent.stdout, "");

// A command waiting for keyboard input sees EOF immediately in one-shot mode.
const stdin = run("if IFS= read -r value; then printf 'UNEXPECTED_INPUT\\n'; else printf 'STDIN_EOF\\n'; fi");
assert.equal(stdin.status, 0, `${stdin.stderr}\n${stdin.error ?? ""}`);
assert.equal(stdin.stdout, "STDIN_EOF\n");

// Actual command timeout remains exit 124 and distinct from the callback-missing result branch above.
const timed = run("sleep 5; printf 'SHOULD_NOT_PRINT\\n'", 1, 5000);
assert.equal(timed.status, 124, `expected timeout exit 124, got ${timed.status}: ${timed.stderr}`);
assert.equal(timed.stdout, "");

// Simulate embedded output arriving arriving after the Console screen is unmounted/backgrounded.
const { TerminalSessionManager } = await import("../core/enhancements/terminal/TerminalSessionManager.ts");
const { publishTerminalOutput } = await import("../core/terminal/TerminalOutputBus.ts");
const storage = new Map();
const manager = new TerminalSessionManager(
  { get: async (key) => storage.get(key) ?? null, set: async (key, value) => { storage.set(key, value); } },
  {
    createProjectSession: async () => ({ id: "term-v478-bg", cwd: "/data/data/com.termux/files/home", env: {} }),
    closeSession: async () => {},
    send: async (sessionId) => {
      // No screen listener is registered: this is the background/unmounted interval.
      publishTerminalOutput({ sessionId, stream: "stdout", data: "PREFIX=/data/data/com.termux/files/usr\\n" });
      publishTerminalOutput({ sessionId, stream: "stderr", data: "DIAGNOSTIC" });
    },
  },
);
const session = await manager.openProjectSession("demo");
await manager.send(session.id, "printf test\\n");
await new Promise((resolve) => setImmediate(resolve));
const afterResume = await manager.get(session.id);
assert.match(afterResume.scrollback, /PREFIX=\/data\/data\/com\.termux\/files\/usr/);
assert.match(afterResume.scrollback, /DIAGNOSTIC/);

console.log("AIB_V486_EMBEDDED_COMMAND_EXECUTION_SELFTEST_OK normal_output=1 zero_output=1 stdin_eof=1 real_timeout=1 callback_missing_distinct=1 bg_unmounted_output_persisted=1");
