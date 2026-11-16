#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { redactBuildDiagnostics, redactPersistentLogPayload } from "../lib/log-redaction.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const intake = fs.readFileSync(path.join(root, "lib/file-intake.ts"), "utf8");
const chat = fs.readFileSync(path.join(root, "app/index.tsx"), "utf8");
const context = fs.readFileSync(path.join(root, "lib/session-log-context.ts"), "utf8");
const loggerHook = fs.readFileSync(path.join(root, "hooks/useLogger.ts"), "utf8");
const privateName = "PRIVATE_CLIENT_RECORD_never_log_82917.pdf";

const intakeLogCalls = [...intake.matchAll(/persistentLogger\.add\([\s\S]*?\);/g)].map((m) => m[0]);
assert.ok(intakeLogCalls.length >= 5, "EXPECTED_INTAKE_SUCCESS_FAILURE_AND_ARCHIVE_LOGS");
for (const call of intakeLogCalls) {
  assert.doesNotMatch(call, /attachment\.displayName|filename=|name=|session\.error|warnings\.join/i,
    "persistent intake log must contain safe metadata only, not names/errors/archive member paths");
}
assert.match(intake, /READY type=\$\{detectedType\} extension=[\s\S]*?size=\$\{size\}/,
  "SUCCESS_PATH_MUST_KEEP_SAFE_TYPE_EXTENSION_AND_SIZE_METADATA");
assert.match(intake, /PRE_ANALYSIS_FAILED type=\$\{detectedType\} extension=[\s\S]*?size=\$\{size\}/,
  "FAILURE_PATH_MUST_KEEP_SAFE_TYPE_EXTENSION_AND_SIZE_METADATA");

const appLogCalls = [...chat.matchAll(/(?:logInfo|logWarn|logError|logDebug)\([\s\S]*?\);/g)].map((m) => m[0]);
for (const call of appLogCalls) {
  assert.doesNotMatch(call, /\$\{attachment\.(?:name|displayName)\}/,
    "chat persistent logs must not interpolate the attachment display name");
  assert.doesNotMatch(call, /\$\{resolvedUri\}|Materialized attachment|materialized attachment/i,
    "chat persistent logs must not contain the materialized attachment URI or path");
}
assert.match(chat, /attachment materialized type=\$\{attType\} extension=\$\{safeExtension\}/,
  "MATERIALIZATION_LOG_MUST_KEEP_ONLY_SAFE_FILE_METADATA");
assert.match(chat, /FILE_PARSE_FAILED type=\$\{attType\} extension=\$\{safeExtension\}/,
  "PARSE_FAILURE_LOG_MUST_USE_SAFE_METADATA");

// Exercise the exact privacy sanitizer used when formatting agent diagnostic lines.
const agentSanitizerBody = context.match(/function safeAgentLogMessage\(e: LogEntry\): string \{([\s\S]*?)\n\}/)?.[1];
assert.ok(agentSanitizerBody, "AGENT_ATTACHMENT_LOG_SANITIZER_NOT_FOUND");
const safeAgentLogMessage = new Function("e", agentSanitizerBody);
const success = safeAgentLogMessage({ tag: "FileIntake", message: "READY type=DOCUMENT extension=pdf size=456 actions=doc-summary durationMs=3" });
const rawSuccess = `READY name=${privateName} type=DOCUMENT extension=pdf mime=application/pdf size=456 actions=doc-summary`;
const rawFailure = `PRE_ANALYSIS_FAILED name=${privateName} type=ARCHIVE extension=zip size=456 error=failed ${privateName}`;
const persistedSuccess = redactPersistentLogPayload("FileIntake", rawSuccess);
const persistedFailure = redactPersistentLogPayload("FileIntake", rawFailure);
const failure = safeAgentLogMessage({ tag: "FileIntake", message: rawFailure });
const persistedFailureAgent = safeAgentLogMessage({ tag: "FileIntake", message: persistedFailure });
assert.match(success, /READY type=DOCUMENT extension=pdf size=456/);
assert.match(failure, /PRE_ANALYSIS_FAILED type=ARCHIVE extension=zip size=456/);
assert.equal(failure.includes(privateName), false, "agent diagnostic context must omit historical attachment display names and free-form errors");
assert.match(persistedFailureAgent, /PRE_ANALYSIS_FAILED type=ARCHIVE extension=zip size=456/);
assert.equal(persistedFailureAgent.includes(privateName), false);
for (const line of [persistedSuccess, persistedFailure]) {
  assert.equal(line.includes(privateName), false, "persistent success/failure log payloads must omit original display names");
}
assert.match(persistedSuccess, /READY type=DOCUMENT extension=pdf size=456/);
assert.match(persistedFailure, /PRE_ANALYSIS_FAILED type=ARCHIVE extension=zip size=456/);

// New success/failure records stay private through the actual export redactor.
assert.match(loggerHook, /redactLogText\(content\)/, "log export must retain its redaction boundary");
const exported = redactBuildDiagnostics([
  `[10:00:00] [INFO] [app] [session] [FileIntake] ${persistedSuccess}`,
  `[10:00:01] [ERROR] [app] [session] [FileIntake] ${persistedFailure}`,
].join("\n"));
assert.equal(exported.includes(privateName), false, "exported success/failure log text must not contain the private attachment name");
assert.match(exported, /READY type=DOCUMENT/);
assert.match(exported, /PRE_ANALYSIS_FAILED type=ARCHIVE/);
console.log("PASS: attachment display names omitted from intake logs, export text, and agent diagnostics on success/failure paths");
