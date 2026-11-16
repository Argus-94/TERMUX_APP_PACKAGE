#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadTs } from "./aib-interceptor-test-helper.mjs";

const { redactCommandForLogs, redactCommandOutputForLogs, summarizeCommandOutputForLogs, utf8ByteLengthForDiagnostics } = loadTs("lib/command-log-redaction.ts");
const { redactSecrets, redactPersistentLogPayload } = loadTs("lib/log-redaction.ts");

const pairCommand = 'adb pair "192.0.2.5:37123" "123456"';
assert.equal(redactCommandForLogs(pairCommand).includes("123456"), false);
assert.equal(redactCommandOutputForLogs(pairCommand, "Enter pairing code 123456\nSuccessfully paired").includes("123456"), false);

const envCommand = 'OPENROUTER_KEY="mock-secret-value" command';
assert.equal(redactCommandForLogs(envCommand).includes("mock-secret-value"), false);
assert.equal(redactCommandOutputForLogs(envCommand, "OPENROUTER_KEY=mock-secret-value").includes("mock-secret-value"), false);

const optionCommand = "tool --api-key mock-cli-secret";
assert.equal(redactCommandForLogs(optionCommand).includes("mock-cli-secret"), false);
assert.equal(redactCommandOutputForLogs(optionCommand, "Authorization: Bearer mock-cli-secret").includes("mock-cli-secret"), false);
const syntheticGitlabCredential = "glpat-" + "x".repeat(24);
assert.equal(redactSecrets(`provider token=${syntheticGitlabCredential}`).includes(syntheticGitlabCredential), false, "GitLab PAT content is removed before logging or persistence");
for (const uri of [
  "https://mock-user:mock-password@private.example/private/repository?token=mock-url-secret&sig=mock-signature",
  "wss://private.example/private/socket?auth=mock-websocket-secret",
  "file:///storage/emulated/0/private-project/config.json",
  "content://com.example.provider/private/document/123",
  "github://mock-user/private-repository",
]) {
  const safe = redactSecrets(`request ${uri} failed`);
  assert.equal(safe.includes("://"), false, "logged URI scheme must not be exposed");
  assert.equal(safe.includes("private.example"), false);
  assert.equal(safe.includes("private/repository"), false);
  assert.equal(safe.includes("mock-url-secret"), false);
  assert.equal(safe.includes("storage/emulated/0"), false);
}
const bridgeSource = await readFile(new URL("../lib/termux-bridge.ts", import.meta.url), "utf8");
const useLlmSource = await readFile(new URL("../hooks/useLLM.ts", import.meta.url), "utf8");
assert.match(useLlmSource, /Отправка запроса mode=\$\{mode\}[\s\S]*?chars=\$\{message\.length\}/);
assert.doesNotMatch(useLlmSource, /Отправка[^\n]*\$\{message\}[\s\S]{0,40}persistentLogger/);
assert.match(bridgeSource, /const safeCommand = redactCommandForLogs\(command\)/);
assert.match(bridgeSource, /summarizeCommandOutputForLogs\("", text\)/);
assert.match(bridgeSource, /const stdout = redactCommandOutputForLogs\(command/);
assert.match(bridgeSource, /const workdirLabel = opts\?\.workdir \? "\(custom\)" : "\(default\)"/);
assert.match(bridgeSource, /workdir=\$\{workdirLabel\}/);
assert.match(bridgeSource, /cwd=\$\{workdirLabel\}/);
assert.doesNotMatch(bridgeSource, /workdir=\$\{opts\?\.workdir|cwd=\$\{opts\?\.workdir/);

const callbackOutput = "AIB_PROBE_BEGIN\nAIB_LIST_MODE:quiet\nAIB_PROBE_ID:debian\nprivate shell output🙂";
const callbackSummary = summarizeCommandOutputForLogs("proot-distro", callbackOutput);
assert.match(callbackSummary, new RegExp(`chars=${callbackOutput.length} utf8Bytes=${utf8ByteLengthForDiagnostics(callbackOutput)}`), "metrics describe the callback payload before redaction");
assert.notEqual(callbackOutput.length, utf8ByteLengthForDiagnostics(callbackOutput), "fixture exercises UTF-16 code-unit vs UTF-8 byte divergence");
const persistedSummary = redactPersistentLogPayload("Linux:Debian:js-probe:stdout", callbackSummary);
assert.equal(persistedSummary, callbackSummary, "persistent export validates and preserves a canonical safe summary instead of measuring its text again");
assert.equal(persistedSummary.includes("private shell output"), false, "raw callback shell output remains omitted");
assert.match(bridgeSource, /metricSource=live-stream-transport stdoutStreamChars=/, "live chunks are labelled as transport metrics");
assert.match(bridgeSource, /stdoutBytes: utf8ByteLength\(stdout\)/, "authoritative callback byte count is derived from final normalized output");
assert.match(bridgeSource, /stdoutChars: stdout\.length/, "callback character count is separately recorded");
console.log("AIB_COMMAND_LOG_REDACTION_SELFTEST_OK callback_metrics=consistent-by-source live_stream=labelled_utf8=checked repeated_redaction=stable raw_output=omitted secrets=redacted");
