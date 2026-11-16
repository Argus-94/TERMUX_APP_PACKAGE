import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { typescript as ts } from './test-helpers/load-typescript.mjs';
const root = new URL('../', import.meta.url);
const read = rel => fs.readFileSync(new URL(rel, root), 'utf8');
function compile(rel, deps = {}) {
  const filename = path.resolve(new URL(rel, root).pathname), m = new Module(filename);
  m.filename = filename;
  m.require = id => { if (Object.hasOwn(deps, id)) return deps[id]; throw new Error(`Unexpected dependency ${id}`); };
  m._compile(ts.transpileModule(read(rel), { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText, filename);
  return m.exports;
}
const diagnostic = compile('lib/full-candidate-diagnostic.ts');
const catalog = compile('lib/candidate-full-packages.generated.ts');
assert.equal(catalog.CANDIDATE_PACKAGES.length, 82);
const ids = catalog.CANDIDATE_PACKAGES.map(p => p.name);
const protectedId = catalog.CANDIDATE_PROTECTED_PACKAGES[0];
const removableId = ids.find(id => !catalog.CANDIDATE_PROTECTED_PACKAGES.includes(id));
const jsx = (type, props, key) => ({ type, props, key });
const native = Object.fromEntries(['ActivityIndicator', 'ScrollView', 'Text', 'TextInput', 'TouchableOpacity', 'View'].map(x => [x,x]));
function nodes(tree, type) {
  const out = []; function visit(n) { if (Array.isArray(n)) return n.forEach(visit); if (!n || typeof n !== 'object') return;
    if (n.type === type) out.push(n); visit(n.props?.children); } visit(tree); return out;
}
function text(n) { if (Array.isArray(n)) return n.map(text).join(''); if (n == null || typeof n === 'boolean') return '';
  return typeof n === 'object' ? text(n.props?.children) : String(n); }
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(sessionEnabled = true) {
  const slots = [], calls = [], alerts = [], logs = [], failureSummaries = []; let cursor = 0, flushes = 0;
  let currentSessionEnabled = sessionEnabled;
  const react = {
    useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }]; },
    useMemo(fn) { cursor++; return fn(); },
  };
  let behavior = async (action, selected) => result(action, selected);
  function result(action, selected) { return { ok: true, action, code: `AIB_FULL_CANDIDATE_OK:${action}`,
    log: 'verified fixture', evidencePath: '/data/user/0/com.karat.aibuilder/files/candidate-transactions/tx-abcdefghijkl', qualified: false, productionEnabled: false,
    states: Object.fromEntries((action === 'remove' ? selected : ids).map(id => [id, {
      status: action === 'remove' ? 'absent' : 'installed', version: catalog.CANDIDATE_PACKAGES.find(p => p.name === id).version,
    }])) }; }
  const panel = compile('components/FullCandidatePackagesPanel.tsx', {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'react-native': { ...native, Alert: { alert: (...args) => alerts.push(args) } },
    '../lib/candidate-full-feed': { ...catalog, CANDIDATE_BOOTSTRAP_COMPATIBLE: true,
      CANDIDATE_INSTALL_BLOCKER: 'Requires private runtime', runFullCandidateAction: async (action, selected, options) => {
        calls.push({ action, selected, sessionEnabled: options?.sessionEnabled, liveSessionEnabled: options?.isSessionEnabled?.() }); return behavior(action, selected); } },
    '../lib/candidate-transaction-log': {
      candidateTransactionIdFromEvidencePath: value => typeof value === 'string' && /tx-[A-Za-z0-9-]{12,80}$/.test(value) ? value.split('/').at(-1) : undefined,
      buildCandidateFailureLogEntry: async input => {
        failureSummaries.push(input);
        const tx = typeof input.evidencePath === 'string' ? input.evidencePath.split('/').at(-1) : null;
        return JSON.stringify({ action: input.action, attemptId: input.attemptId, transactionId: /^tx-[A-Za-z0-9-]{12,80}$/.test(tx || '') ? tx : null, resultCode: input.resultCode });
      },
      redactCandidateLog: value => String(value).replace(/\/data\/(?:user\/0|data)\/com\.karat\.aibuilder(?:\/\S*)?/g, '[APP_PRIVATE_PATH]').replace(/\/private|\/secret/g, '[REDACTED]'),
    },
    '../lib/full-candidate-diagnostic': diagnostic,
    '../lib/persistent-logger': { persistentLogger: { add: (...args) => logs.push(args), flush: () => { flushes++; } } },
  }).FullCandidatePackagesPanel;
  const render = () => { cursor = 0; return panel({ colors: {}, language: 'ru', sessionEnabled: currentSessionEnabled }); };
  const bulk = () => nodes(render(), 'TouchableOpacity').find(n => text(n) === 'Установить весь набор (82)');
  const reinstall = () => nodes(render(), 'TouchableOpacity').find(n => text(n) === 'Переустановить весь набор (82)');
  const row = (id, action) => nodes(render(), 'TouchableOpacity').find(n => n.key === `${id}-${action}`);
  return { render, calls, alerts, logs, failureSummaries, get flushes() { return flushes; }, bulk, reinstall, row, result, setBehavior(fn) { behavior = fn; }, setSessionEnabled(value) { currentSessionEnabled = value; render(); } };
}
const f = fixture();
f.bulk().props.onPress(); assert.equal(f.calls.length, 0); assert.equal(f.alerts.length, 1);
assert.match(f.alerts[0][1], /весь согласованный набор из 82/); assert.match(text(f.render()), /ожидается подтверждение/);
f.alerts[0][2][0].onPress(); assert.equal(f.calls.length, 0); assert.match(text(f.render()), /отменена; запрос не отправлен/);
const cancelLogs=f.logs.map(x=>JSON.parse(x[2])); const cancelled=cancelLogs.find(x=>x.stage==='cancel'&&x.action==='install'); assert.ok(cancelled); assert.equal(cancelLogs.find(x=>x.stage==='press'&&x.action==='install').attemptId,cancelled.attemptId);
let settle;
f.setBehavior(() => new Promise(resolve => { settle = resolve; }));
f.bulk().props.onPress(); f.alerts.at(-1)[2][1].onPress();
assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0], { action: 'install', selected: ids, sessionEnabled: true, liveSessionEnabled: true });
const confirmedLogs=f.logs.map(x=>JSON.parse(x[2])).filter(x=>x.action==='install'); const confirmId=confirmedLogs.find(x=>x.stage==='confirm')?.attemptId; assert.ok(confirmId); assert.ok(['press','confirmation-open','confirm','dispatch'].every(stage=>confirmedLogs.some(x=>x.stage===stage&&x.attemptId===confirmId)));
assert.equal(f.bulk().props.disabled, true); assert.match(text(f.render()), /install…/);
settle(f.result('install', ids)); await tick(); assert.equal(f.bulk().props.disabled, false);
const completionLogs=f.logs.map(x=>JSON.parse(x[2])); assert.ok(completionLogs.some(x=>x.stage==='result'&&x.action==='install'&&x.attemptId===confirmId));
assert.match(text(f.render()), /OK · AIB_FULL_CANDIDATE_OK:install/);
f.setBehavior(async (action, selected) => f.result(action, selected));
assert.equal(f.row(removableId, 'install'), undefined, 'a package row must not expose single-name install');
assert.equal(f.row(removableId, 'reinstall'), undefined, 'a package row must not expose single-name reinstall');
f.reinstall().props.onPress(); assert.equal(f.calls.length, 1);
assert.match(f.alerts.at(-1)[1], /весь согласованный набор из 82/);
f.alerts.at(-1)[2][1].onPress(); await tick(); assert.equal(f.calls.at(-1).action, 'reinstall'); assert.deepEqual(f.calls.at(-1).selected, ids);
f.row(removableId, 'check').props.onPress(); await tick();
assert.equal(f.calls.at(-1).action, 'check'); assert.equal(f.calls.at(-1).selected, undefined);
assert.equal(f.row(protectedId, 'remove').props.disabled, true);
f.row(removableId, 'remove').props.onPress(); assert.match(f.alerts.at(-1)[1], /только выбранный пакет/);
f.alerts.at(-1)[2][1].onPress(); await tick(); assert.deepEqual(f.calls.at(-1), { action: 'remove', selected: [removableId], sessionEnabled: true, liveSessionEnabled: true });
const removalLog = f.logs.map(x => JSON.parse(x[2])).find(x => x.action === 'remove' && x.stage === 'dispatch'); assert.ok(removalLog); assert.match(removalLog.attemptId, /^fc-/);
const inputs = nodes(f.render(), 'TextInput'); inputs[1].props.onChangeText(removableId);
const manual = () => nodes(f.render(), 'TouchableOpacity').find(n => text(n) === 'Проверить введённое имя');
manual().props.onPress(); await tick(); assert.deepEqual(f.calls.at(-1), { action: 'check', selected: undefined, sessionEnabled: true, liveSessionEnabled: true });
assert.equal(nodes(f.render(), 'TextInput')[0].props.value, removableId);
inputs[1].props.onChangeText('not-in-signed-catalog'); const before = f.calls.length;
manual().props.onPress(); await tick(); assert.equal(f.calls.length, before); assert.match(text(f.render()), /Отклонено локально/);
const disabled = fixture(false);
assert.equal(disabled.bulk().props.disabled, true);
assert.equal(disabled.row(removableId, 'check').props.disabled, true);
assert.match(text(disabled.render()), /Пакетные действия отключены/);
disabled.row(removableId, 'check').props.onPress(); await tick();
assert.equal(disabled.calls.length, 0, 'disabled check cannot dispatch even when its handler is invoked directly');
disabled.bulk().props.onPress(); disabled.alerts.at(-1)[2][1].onPress(); await tick();
assert.equal(disabled.calls.length, 0, 'confirm after a stale/direct press is stopped before native dispatch');
assert.match(text(disabled.render()), /включите сессию встроенного Termux/);
assert.ok(disabled.logs.map(x => JSON.parse(x[2])).some(x => x.resultCode === 'AIB_FULL_CANDIDATE_SESSION_DISABLED' && x.reasonCategory === 'session_disabled'));
const staleConfirmation = fixture(true);
staleConfirmation.bulk().props.onPress();
staleConfirmation.setSessionEnabled(false);
staleConfirmation.alerts.at(-1)[2][1].onPress(); await tick();
assert.equal(staleConfirmation.calls.length, 0, 'confirmation opened while enabled cannot dispatch after session is disabled');
assert.match(text(staleConfirmation.render()), /включите сессию встроенного Termux/);
f.setBehavior(async action => ({ ok: false, action, code: 'AIB_FULL_CANDIDATE_PRIVATE_RUNTIME_REQUIRED', log: 'not ready' }));
f.bulk().props.onPress(); f.alerts.at(-1)[2][1].onPress(); await tick();
assert.match(text(f.render()), /ERROR · AIB_FULL_CANDIDATE_PRIVATE_RUNTIME_REQUIRED/);
f.setBehavior(async () => { throw new Error('/secret/native-path key=private'); });
f.bulk().props.onPress(); f.alerts.at(-1)[2][1].onPress(); await tick();
assert.match(text(f.render()), /ERROR · Операция не завершена/); assert.equal(text(f.render()).includes('/secret'), false);
const serializedLogs = JSON.stringify(f.logs);
assert.equal(serializedLogs.includes('/private'), false); assert.equal(serializedLogs.includes('/secret'), false);
const rawStdout='https://custom-provider.example/key=output-secret', rawStderr='/home/private username=output-secret';
f.setBehavior(async action => ({ ...f.result(action, ids), ok:false, code:'AIB_FULL_CANDIDATE_UNCONFIRMED', log:`${rawStdout}\n${rawStderr}`,
  diagnostics:{phase:'result_validation',reasonCode:'CANDIDATE_NONZERO_EXIT',exitCode:17,timedOut:false,outputTruncated:false,
    stdoutChars:rawStdout.length,stderrChars:rawStderr.length,stdoutBytes:rawStdout.length,stderrBytes:rawStderr.length} }));
f.bulk().props.onPress(); f.alerts.at(-1)[2][1].onPress(); await tick();
const safeFailure=f.logs.map(x=>JSON.parse(x[2])).find(x=>x.action==='install'&&x.stage==='result'&&x.diagnosticPhase==='result_validation');
assert.ok(safeFailure); assert.equal(safeFailure.outcome,'error'); assert.equal(safeFailure.resultCode,'AIB_FULL_CANDIDATE_UNCONFIRMED');
assert.equal(safeFailure.diagnosticReasonCode,'CANDIDATE_NONZERO_EXIT'); assert.equal(safeFailure.exitCode,17);
assert.equal(safeFailure.timedOut,false); assert.equal(safeFailure.outputTruncated,false);
assert.deepEqual([safeFailure.stdoutChars,safeFailure.stderrChars,safeFailure.stdoutBytes,safeFailure.stderrBytes],[rawStdout.length,rawStderr.length,rawStdout.length,rawStderr.length]);
const failureExport=JSON.stringify(f.logs); assert.equal(failureExport.includes(rawStdout),false); assert.equal(failureExport.includes(rawStderr),false);
const jsonLogs = f.logs.map(x => JSON.parse(x[2]));
assert.ok(jsonLogs.some(x => x.stage === 'dispatch' && x.action === 'check' && x.selectionCount === 0 && x.outcome === 'pending'));
for (const group of ['install','remove','check']) { const rows=jsonLogs.filter(x=>x.action===group); assert.ok(rows.every(x=>/^fc-/.test(x.attemptId))); }
assert.equal(new Set(jsonLogs.filter(x=>x.stage==='dispatch').map(x=>x.attemptId)).size, jsonLogs.filter(x=>x.stage==='dispatch').length);
const exactEvidence = '/data/user/0/com.karat.aibuilder/files/candidate-transactions/tx-installfailure';
const checkEvidence = '/data/user/0/com.karat.aibuilder/files/candidate-transactions/tx-checkmarker';
const verifyEvidence = '/data/user/0/com.karat.aibuilder/files/candidate-transactions/tx-verifymarker';
const priorFailureCount = f.failureSummaries.length, priorFlushes = f.flushes;
f.setBehavior(async action => ({ ...f.result(action, ids), ok: action !== 'install',
  code: action === 'install' ? 'AIB_FULL_CANDIDATE_UNCONFIRMED' : `AIB_FULL_CANDIDATE_OK:${action}`,
  log: action === 'install' ? 'AIB_FULL_CANDIDATE_FAIL: coherent install transaction failed\nAIB_FULL_CANDIDATE_PARTIAL_RUNTIME_REPAIR_REQUIRED' : 'verified',
  evidencePath: action === 'install' ? exactEvidence : action === 'check' ? checkEvidence : verifyEvidence,
  diagnostics: { phase: 'result_validation', reasonCode: action === 'install' ? 'CANDIDATE_NONZERO_EXIT' : 'CANDIDATE_CONFIRMED', exitCode: action === 'install' ? 78 : 0, timedOut: false, outputTruncated: false,
    stdoutChars: 0, stderrChars: 0, stdoutBytes: 0, stderrBytes: 0 } }));
f.bulk().props.onPress(); f.alerts.at(-1)[2][1].onPress(); await tick();
const installFailure = f.logs.filter(x => x[1] === 'FullCandidateFailure').map(x => JSON.parse(x[2])).find(x => x.transactionId === 'tx-installfailure');
assert.ok(installFailure, 'a failed install is written to the ordinary persistent log');
assert.equal(installFailure.action, 'install');
assert.equal(installFailure.attemptId, f.failureSummaries.at(-1).attemptId);
assert.equal(installFailure.resultCode, 'AIB_FULL_CANDIDATE_UNCONFIRMED');
assert.equal(f.failureSummaries.at(-1).evidencePath, exactEvidence, 'the internal bounded reader receives only this failed action transaction');
assert.equal(f.failureSummaries.length, priorFailureCount + 1);
assert.equal(f.flushes, priorFlushes + 1, 'the failure record is flushed for later ordinary-log export');
f.row(removableId, 'check').props.onPress(); await tick();
assert.equal(f.calls.at(-1).action, 'check');
assert.equal(text(f.render()).includes(exactEvidence), false, 'the app-private absolute path is not shown in the UI');
assert.equal(f.failureSummaries.length, priorFailureCount + 1, 'a later successful check does not rewrite the failed-install record');
const verifyButton = nodes(f.render(), 'TouchableOpacity').find(n => text(n).startsWith('Проверить feed'));
verifyButton.props.onPress(); await tick();
assert.equal(f.calls.at(-1).action, 'verify');
assert.equal(f.failureSummaries.length, priorFailureCount + 1, 'a later successful verify does not rewrite the failed-install record');
assert.equal(f.logs.filter(x => x[1] === 'FullCandidateFailure').map(x => JSON.parse(x[2])).find(x => x.transactionId === 'tx-installfailure').action, 'install');
assert.doesNotMatch(text(f.render()), /Поделиться apply\.log|Share this transaction's apply\.log/, 'there is no separate share/export UI');
console.log('AIB_V495_FULL_PANEL_ACTIONS_SELFTEST_OK actual-production-TSX+mock-hooks Alert cancel/no-dispatch confirm82 busy/result row-install82 remove-single protected-disabled row/manual-check-no-selection invalid-name-zero-dispatch safe-diagnostics+bounded-result-metrics no-raw-exports NO_DEVICE_PROOF');
