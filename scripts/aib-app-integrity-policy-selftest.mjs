#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const policyPath = path.join(root, "lib", "release-integrity-policy.ts");
const ts = requireTypeScript();
const source = fs.readFileSync(policyPath, "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const policyModule = new Module(policyPath);
policyModule.filename = policyPath;
policyModule.paths = Module._nodeModulePaths(path.dirname(policyPath));
policyModule._compile(compiled, policyPath);
const {
  EXPECTED_RELEASE_CERT_SHA256,
  LEGACY_RELEASE_CERT_SHA256,
  EXPECTED_RELEASE_APPLICATION_ID,
  evaluateReleaseIntegrityEvidence,
  assertReleaseIntegrityAllowsSensitiveAction,
} = policyModule.exports;

function requireTypeScript() {
  const req = Module.createRequire(import.meta.url);
  return req("typescript");
}

const validEvidence = {
  applicationId: EXPECTED_RELEASE_APPLICATION_ID,
  debugBuild: false,
  debuggable: false,
  probeComplete: true,
  hookScanComplete: true,
  signerSha256: [EXPECTED_RELEASE_CERT_SHA256],
  hookSignals: [],
};

assert.deepEqual(evaluateReleaseIntegrityEvidence(validEvidence), {
  allowed: true, debugBuild: false, reason: "ok", hookSignals: [],
});
assert.equal(evaluateReleaseIntegrityEvidence({ ...validEvidence, signerSha256: [LEGACY_RELEASE_CERT_SHA256] }).allowed, true,
  "the old lineage signer remains valid for pre-API-28 V1/V2 fallback; native API-specific checks enforce where it is accepted");
assert.equal(evaluateReleaseIntegrityEvidence({ debugBuild: true }).allowed, true,
  "compiled debug builds must remain usable with the debug signer");
assert.equal(evaluateReleaseIntegrityEvidence(null).reason, "probe_unavailable");
assert.equal(evaluateReleaseIntegrityEvidence({ ...validEvidence, signerSha256: ["0".repeat(64)] }).reason, "signature_mismatch",
  "a re-signed/altered signer must be rejected");
assert.equal(evaluateReleaseIntegrityEvidence({ ...validEvidence, signerSha256: [EXPECTED_RELEASE_CERT_SHA256, "1".repeat(64)] }).reason, "signer_set_invalid",
  "unexpected multi-signer APKs must be rejected");
assert.equal(evaluateReleaseIntegrityEvidence({ ...validEvidence, applicationId: "other.app" }).reason, "application_id_mismatch");
assert.equal(evaluateReleaseIntegrityEvidence({ ...validEvidence, debuggable: true }).reason, "release_debuggable");
assert.equal(evaluateReleaseIntegrityEvidence({ ...validEvidence, probeComplete: false }).reason, "probe_incomplete");
assert.equal(evaluateReleaseIntegrityEvidence({ ...validEvidence, hookScanComplete: false }).reason, "hook_scan_incomplete");
assert.equal(evaluateReleaseIntegrityEvidence({ ...validEvidence, hookSignals: ["debugger_attached"] }).reason, "runtime_hook_detected",
  "known debugger/hook evidence must block sensitive operations");
assert.equal(evaluateReleaseIntegrityEvidence({ ...validEvidence, hookSignals: ["new_unknown_signal"] }).reason, "unknown_hook_signal",
  "unknown native hook signals must fail closed");
assert.equal(evaluateReleaseIntegrityEvidence({ ...validEvidence, hookSignals: [null] }).reason, "hook_evidence_invalid");
assert.throws(() => assertReleaseIntegrityAllowsSensitiveAction(evaluateReleaseIntegrityEvidence({
  ...validEvidence, signerSha256: ["f".repeat(64)],
})), (error) => error?.code === "AIB_APP_INTEGRITY_BLOCKED" && error?.integrityReason === "signature_mismatch");
assert.doesNotThrow(() => assertReleaseIntegrityAllowsSensitiveAction(evaluateReleaseIntegrityEvidence(validEvidence)));

console.log("AIB_APP_INTEGRITY_POLICY_SELFTEST_OK new_signer=true legacy_fallback=true altered_signer_rejected=true multi_signer_rejected=true hook_failure_rejected=true malformed_probe_rejected=true debug_build_preserved=true");
