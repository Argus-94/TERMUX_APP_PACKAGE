import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Module from 'node:module';
import { typescript as ts } from './test-helpers/load-typescript.mjs';
const filename = new URL('../lib/full-candidate-diagnostic.ts', import.meta.url).pathname;
const m = new Module(filename); m.filename = filename;
m._compile(ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText, filename);
const { classifyCandidateDiagnostic } = m.exports;
const safe = classifyCandidateDiagnostic({action:'install',stage:'result',code:'AIB_FULL_CANDIDATE_REJECTED',durationMs:43.9,attemptId:'fc-17-a2'});
assert.deepEqual(safe, {action:'install',stage:'result',nativePhase:'none',resultCode:'AIB_FULL_CANDIDATE_REJECTED',nativeCode:'AIB_FULL_CANDIDATE_REJECTED',reasonCategory:'native_rejected',durationMs:43,attemptId:'fc-17-a2'});
const hostile = classifyCandidateDiagnostic({action:'install\nTOKEN=x',stage:'result|inject',code:'AIB_FULL_CANDIDATE_REJECTED\n/home/private/token',durationMs:1,attemptId:'fc-1'});
assert.equal(hostile.action,'unknown'); assert.equal(hostile.stage,'result'); assert.equal(hostile.nativeCode,'none');
for (const secretCode of ['AIB_FULL_CANDIDATE_SECRET_TOKEN','AIB_FULL_CANDIDATE_API_KEY','EMBEDDED_SECRET_PATH']) { const x=classifyCandidateDiagnostic({action:'check',stage:'result',code:secretCode,attemptId:'fc-2'}); assert.equal(x.resultCode,'UNCLASSIFIED'); assert.equal(x.nativeCode,'none'); assert.equal(x.reasonCategory,'unclassified'); }
assert.equal(classifyCandidateDiagnostic({action:'verify',stage:'result',durationMs:3600000,attemptId:'fc-1'}).durationMs,1800000);
assert.equal(JSON.stringify(hostile).includes('/home/private'),false); assert.equal(JSON.stringify(hostile).includes('TOKEN'),false);
const dispatch = classifyCandidateDiagnostic({action:'verify',stage:'dispatch',attemptId:'fc-8'});
const result = classifyCandidateDiagnostic({action:'verify',stage:'result',code:'AIB_FULL_CANDIDATE_UNAVAILABLE',durationMs:9,attemptId:'fc-8'});
assert.equal(dispatch.attemptId,result.attemptId); assert.equal(result.reasonCategory,'runtime_unavailable');
// Real production TSX is loaded by the adjacent action selftest; causal correlation and hostile privacy are checked there.


for (const code of ['AIB_FULL_CANDIDATE_STAGE_FILESDIR_NONCANONICAL', 'AIB_FULL_CANDIDATE_STAGE_IO_ACCESS_DENIED', 'AIB_FULL_CANDIDATE_TRANSACTION_IO_NO_SPACE', 'AIB_FULL_CANDIDATE_STAGE_CACHE_HASH_INVALID']) {
 const d=classifyCandidateDiagnostic({action:'verify',stage:'result',code,attemptId:'fc-1'});
 assert.equal(d.resultCode,code); assert.notEqual(d.nativePhase,'none'); assert.notEqual(d.reasonCategory,'unclassified');
}
assert.equal(classifyCandidateDiagnostic({action:'verify',stage:'result',code:'AIB_FULL_CANDIDATE_OK:verify',attemptId:'fc-1'}).reasonCategory,'success');
assert.equal(classifyCandidateDiagnostic({action:'verify',stage:'result',code:'AIB_FULL_CANDIDATE_STAGE_SECRET_TOKEN_ABC',attemptId:'fc-1'}).resultCode,'UNCLASSIFIED');

const measured=classifyCandidateDiagnostic({action:'install',stage:'result',code:'AIB_FULL_CANDIDATE_UNCONFIRMED',attemptId:'fc-9',diagnosticPhase:'result_validation',diagnosticReasonCode:'CANDIDATE_NONZERO_EXIT',exitCode:17,timedOut:false,outputTruncated:false,stdoutChars:24,stderrChars:8,stdoutBytes:28,stderrBytes:8});
assert.equal(measured.diagnosticPhase,'result_validation'); assert.equal(measured.diagnosticReasonCode,'CANDIDATE_NONZERO_EXIT');
assert.deepEqual([measured.exitCode,measured.timedOut,measured.outputTruncated,measured.stdoutChars,measured.stderrChars,measured.stdoutBytes,measured.stderrBytes],[17,false,false,24,8,28,8]);
const hostileMetrics=classifyCandidateDiagnostic({action:'install',stage:'result',code:'AIB_FULL_CANDIDATE_UNCONFIRMED',attemptId:'fc-10',diagnosticPhase:'/private/user',diagnosticReasonCode:'https://provider.example/key=secret',exitCode:9999,timedOut:'yes',outputTruncated:'no',stdoutChars:'TOKEN=x',stderrChars:-1,stdoutBytes:NaN,stderrBytes:Infinity});
assert.equal(hostileMetrics.diagnosticPhase,'unknown'); assert.equal(hostileMetrics.diagnosticReasonCode,'UNCLASSIFIED');
assert.deepEqual([hostileMetrics.exitCode,hostileMetrics.timedOut,hostileMetrics.outputTruncated,hostileMetrics.stdoutChars,hostileMetrics.stderrChars,hostileMetrics.stdoutBytes,hostileMetrics.stderrBytes],[null,null,null,null,null,null,null]);
assert.equal(JSON.stringify(hostileMetrics).includes('/private/user'),false); assert.equal(JSON.stringify(hostileMetrics).includes('provider.example'),false);

console.log('full-candidate-diagnostic-selftest: OK explicit-whitelist native-phase+reason + bounded exit/timeout/output metrics hostile-inputs-redacted success-classified causal-pairing');
