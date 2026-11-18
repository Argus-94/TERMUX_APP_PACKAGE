import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { typescript } from "./test-helpers/load-typescript.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = relative => fs.readFileSync(path.join(root, relative), "utf8");
const nativeSource = read("plugins/withTermuxBridge.js");
const nativeStart = nativeSource.indexOf("fun readEmbeddedCandidateApplyLog(");
const nativeEnd = nativeSource.indexOf("/** Reports whether the app-private bootstrap", nativeStart);
assert.ok(nativeStart >= 0 && nativeEnd > nativeStart, "native bounded reader exists");
const nativeReader = nativeSource.slice(nativeStart, nativeEnd);
assert.match(nativeReader, /transactionId: String, promise: Promise/);
assert.match(nativeReader, /transactionId\.matches\(Regex\("\^tx-/);
assert.match(nativeReader, /File\(filesRoot, "candidate-transactions"\)/);
assert.match(nativeReader, /Os\.lstat\(transactionRoot\.path\)/);
assert.match(nativeReader, /Os\.lstat\(transaction\.path\)/);
assert.match(nativeReader, /OsConstants\.O_NOFOLLOW/);
assert.match(nativeReader, /Os\.fstat\(input\.fd\)/);
assert.match(nativeReader, /OsConstants\.S_IFREG/);
assert.match(nativeReader, /val maxBytes = 64 \* 1024/);
assert.match(nativeReader, /validStart < 3/);
assert.match(nativeReader, /bytes\.copyOfRange\(validStart, bytes\.size\)/);
assert.doesNotMatch(nativeReader, /transactionId\s*==\s*null|listFiles\(\)|sortedWith/,
  "there is no latest-transaction fallback; the reader is bound to the exact operation ID");
assert.doesNotMatch(nativeReader, /runEmbeddedTermuxCommand|hasAIBuilderAllFilesAccess|ACTION_MANAGE|delete\(|\.delete\(|remove\(|install\(|repair\(/,
  "reading a log does not run shell, request broad storage access, or mutate packages");

const bridgeSource = read("lib/termux-bridge.ts");
assert.match(bridgeSource, /readEmbeddedCandidateApplyLog\?\(transactionId: string\): Promise<unknown>/);
assert.match(bridgeSource, /export async function readEmbeddedCandidateApplyLog\(transactionId: string\)/);
assert.match(bridgeSource, /!\/\^tx-\[A-Za-z0-9-\]\{12,80\}\$\//);
assert.doesNotMatch(bridgeSource, /readEmbeddedCandidateApplyLog\?\(transactionId: string \| null\)/);

const helperSource = read("lib/candidate-transaction-log.ts");
const transpiled = typescript.transpileModule(helperSource, {
  compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 },
}).outputText;
const tx = "tx-install-abcdefghijkl";
let rawApplyLog = [
  "E: Sub-process /data/user/0/com.karat.aibuilder/files/usr/bin/dpkg returned an error code (1)",
  "Authorization: Bearer bearer-secret",
  "token=secret-token",
  '"api_key": "json-secret value"',
  "https://user:pass@example.test/private-feed",
].join("\n");
const nativeCalls = [];
const helperExports = {};
vm.runInNewContext(transpiled, {
  exports: helperExports,
  require: id => {
    assert.equal(id, "./termux-bridge");
    return { readEmbeddedCandidateApplyLog: async transactionId => {
      nativeCalls.push(transactionId);
      return { transactionId, content: rawApplyLog, byteLength: Buffer.byteLength(rawApplyLog, "utf8"), truncated: false };
    } };
  },
  Buffer,
});
const helper = helperExports;
const exactPath = `/data/user/0/com.karat.aibuilder/files/candidate-transactions/${tx}`;
assert.equal(helper.candidateTransactionIdFromEvidencePath(exactPath), tx);
assert.equal(helper.candidateTransactionIdFromEvidencePath(`/data/data/com.karat.aibuilder/files/candidate-transactions/${tx}`), tx);
for (const invalid of [
  `/storage/emulated/0/AIBuilderTermux/${tx}`,
  `${exactPath}/apply.log`,
  `/data/data/other.package/files/candidate-transactions/${tx}`,
  "/data/data/com.karat.aibuilder/files/candidate-transactions/tx-../secret",
]) assert.equal(helper.candidateTransactionIdFromEvidencePath(invalid), undefined);

const aptFailure = await helper.buildCandidateFailureLogEntry({
  action: "install",
  attemptId: "fc-mv4x-1",
  resultCode: "AIB_FULL_CANDIDATE_UNCONFIRMED",
  evidencePath: exactPath,
  output: "AIB_FULL_CANDIDATE_FAIL: coherent install transaction failed\nAIB_FULL_CANDIDATE_PARTIAL_RUNTIME_REPAIR_REQUIRED",
  diagnostics: { phase: "result_validation", reasonCode: "CANDIDATE_NONZERO_EXIT", exitCode: 78, timedOut: false, outputTruncated: false },
});
const aptRecord = JSON.parse(aptFailure);
assert.deepEqual(nativeCalls, [tx], "only the exact failed transaction ID is passed to native code");
assert.equal(aptRecord.action, "install");
assert.equal(aptRecord.attemptId, "fc-mv4x-1");
assert.equal(aptRecord.transactionId, tx);
assert.equal(aptRecord.failureStage, "APT_APPLY_FAILED");
assert.equal(aptRecord.applyLogStatus, "read");
assert.equal(aptRecord.aptDetail, "DPKG_FAILED");
assert.equal(aptRecord.dpkgExitCode, 1);
assert.equal(aptRecord.candidateExitCode, 78);
assert.equal(aptRecord.partialMutation, true);
for (const secret of ["bearer-secret", "secret-token", "json-secret", "user:pass", "/data/user/0/com.karat.aibuilder", "private-feed"]) {
  assert.equal(aptFailure.includes(secret), false, `ordinary-log entry must not contain ${secret}`);
}
assert.ok(aptFailure.length < 2_000, "the persistent log entry is a short summary, not raw APT output");

rawApplyLog = "E: No space left on device while unpacking";
const diskFailure = JSON.parse(await helper.buildCandidateFailureLogEntry({
  action: "reinstall", attemptId: "fc-mv4x-2", resultCode: "AIB_FULL_CANDIDATE_UNCONFIRMED",
  evidencePath: exactPath, output: "AIB_FULL_CANDIDATE_FAIL: coherent install transaction failed",
  diagnostics: { phase: "result_validation", reasonCode: "CANDIDATE_NONZERO_EXIT", exitCode: 78 },
}));
assert.equal(diskFailure.aptDetail, "STORAGE_EXHAUSTED");
assert.equal(nativeCalls.length, 2);

const beforePostVerify = nativeCalls.length;
const registryFailure = JSON.parse(await helper.buildCandidateFailureLogEntry({
  action: "install", attemptId: "fc-mv4x-3", resultCode: "AIB_FULL_CANDIDATE_UNCONFIRMED",
  evidencePath: exactPath,
  output: "AIB_FULL_CANDIDATE_FAIL: private registry outcome mismatch: make",
  diagnostics: { phase: "result_validation", reasonCode: "CANDIDATE_NONZERO_EXIT", exitCode: 78 },
}));
assert.equal(registryFailure.failureStage, "POST_APT_DPKG_VERIFY_FAILED");
assert.equal(registryFailure.packageName, "make");
assert.equal(registryFailure.applyLogStatus, "not_required");
assert.equal(nativeCalls.length, beforePostVerify, "post-install verification is distinguished from APT apply without reading another log");
const payloadFailure = JSON.parse(await helper.buildCandidateFailureLogEntry({
  action: "install", attemptId: "fc-mv4x-4", resultCode: "AIB_FULL_CANDIDATE_UNCONFIRMED",
  evidencePath: exactPath, output: "AIB_FULL_CANDIDATE_FAIL: installed payload hash mismatch (immutable signed payload)",
}));
assert.equal(payloadFailure.failureStage, "POST_APT_PAYLOAD_HASH_VERIFY_FAILED");

const noIdentity = JSON.parse(await helper.buildCandidateFailureLogEntry({
  action: "install", attemptId: "fc-mv4x-5", resultCode: "AIB_FULL_CANDIDATE_UNCONFIRMED",
  evidencePath: "/storage/emulated/0/not-an-app-path/tx-newer-check",
  output: "AIB_FULL_CANDIDATE_FAIL: coherent install transaction failed",
}));
assert.equal(noIdentity.transactionId, null);
assert.equal(noIdentity.applyLogStatus, "transaction_id_unavailable");
const beforeInvalidIdentity = nativeCalls.length;
assert.equal(beforeInvalidIdentity, beforePostVerify, "post-install checks do not read a different transaction log");
assert.equal(nativeCalls.length, beforeInvalidIdentity, "invalid identity never falls back to the newest transaction");

const panel = read("components/FullCandidatePackagesPanel.tsx");
assert.match(panel, /buildCandidateFailureLogEntry\(/);
assert.match(panel, /persistentLogger\.add\("error", "FullCandidateFailure"/);
assert.match(panel, /persistentLogger\.flush\(\)/);
assert.match(panel, /await record\(result, action, attempt\)/);
assert.doesNotMatch(panel, /saveTextAsFile|shareTextFile|exportApplyLog|Поделиться apply\.log|Share this transaction's apply\.log/,
  "there is no separate share/export UI");
assert.match(panel, /candidateTransactionIdFromEvidencePath\(r\.evidencePath\)/);
const ordinaryLogExport = read("hooks/useLogger.ts");
assert.match(ordinaryLogExport, /persistentLogger\.getAll\(\)/);
assert.match(ordinaryLogExport, /current\.map\(/);
assert.match(ordinaryLogExport, /redactLogText\(content\)/,
  "the failure record is included in the usual exported log and the full export is redacted");

const releaseGate = read("scripts/aib-pre-release.mjs");
assert.match(releaseGate, /aib-v502-candidate-failure-log-selftest\.mjs/);
assert.equal(JSON.parse(read("package.json")).version, "1.10.113");
assert.match(read("app.config.ts"), /versionCode: 513/);
console.log("aib-v502-candidate-failure-log-selftest: PASS (exact transaction only, 64-KiB native bound, APT and post-APT stage classification, secret/path-free persistent summary, no share UI, no feed/device/APT actions)");
