#!/usr/bin/env node
// v379: escalation ladder — pure helper self-test.
// Run: node --experimental-transform-types scripts/aib-agent-escalation-selftest.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const m = await import(pathToFileURL(path.join(root, 'lib/agent-escalation.ts')).href);

// protocol abort detection
assert.equal(m.isProtocolAbortText('AGENT_PROTOCOL_ABORT: bad'), true);
assert.equal(m.isProtocolAbortText('x\n[REPAIR_AGENT_PROTOCOL_ABORT] y'), true);
assert.equal(m.isProtocolAbortText('all good'), false);

// finished-build detection
assert.equal(m.looksLikeFinishedBuild('TERMUX_DONE: /storage/emulated/0/AIBuilderTermux/out/app-debug.apk'), true);
assert.equal(m.looksLikeFinishedBuild('Не удалось собрать'), false);
assert.equal(m.looksLikeFinishedBuild('[AGENT_HANDOFF_ERROR] x /a/b.apk'), false);
assert.equal(m.looksLikeFinishedBuild('AGENT_PROTOCOL_ABORT: /a/b.apk'), false);

// rungs
assert.deepEqual([...m.ESCALATION_RUNGS], ['new-strategy', 'strict-protocol']);

// task prompts keep safety rules and never invite the user to fix things
for (const rung of m.ESCALATION_RUNGS) {
  const t = m.buildEscalationTask({
    userTask: 'build apk', rung, kind: 'toolchain', failureLog: 'NO_JAVA', triedStrategies: ['a', 'b'], projectPath: '/p',
  });
  assert.match(t, /SAFETY RULES/);
  assert.match(t, /proot-distro reset\/remove/);
  assert.match(t, /compilation settings/);
  assert.match(t, /NO_JAVA/);
  assert.doesNotMatch(t, /ask the user to install manually/i);
}
const strict = m.buildEscalationTask({ userTask: 'u', rung: 'strict-protocol', kind: 'gradle', failureLog: 'x', triedStrategies: [] });
assert.match(strict, /exactly ONE line/);
const fresh = m.buildEscalationTask({ userTask: 'u', rung: 'new-strategy', kind: 'gradle', failureLog: 'x', triedStrategies: ['s1'] });
assert.match(fresh, /DIFFERENT fix layer/);
assert.match(fresh, /do NOT repeat/);

// honest report: exact cause, no "check it yourself"
const rep = m.buildEscalationReport({
  kind: 'toolchain', kindMessage: '', failureLog: 'ok\nsdk_dir=MISSING\nNO_JAVA', rungsTried: ['new-strategy', 'strict-protocol'], recoveryCycles: 3, lastAgentOutput: 'gave up',
});
assert.match(rep, /NO_JAVA/);
assert.match(rep, /3 цикл/);
assert.match(rep, /new-strategy → strict-protocol/);
assert.doesNotMatch(rep, /проверьте/i);


// v380: manual model-switch hint appears once, only after a protocol abort, never as an automatic switch
const repAbort = m.buildEscalationReport({
  kind: 'build-command', kindMessage: '', failureLog: 'x\n[REPAIR_AGENT_PROTOCOL_ABORT] bad', rungsTried: ['strict-protocol', 'new-strategy'], recoveryCycles: 2,
  lastAgentOutput: 'AGENT_PROTOCOL_ABORT: stopped.\n\u2192 \u041d\u0430\u0441\u0442\u0440\u043e\u0439\u043a\u0438: \u0441\u043c\u0435\u043d\u0438\u0442\u0435 \u043c\u043e\u0434\u0435\u043b\u044c \u043d\u0430 \u0431\u043e\u043b\u0435\u0435 \u0441\u0438\u043b\u044c\u043d\u0443\u044e',
});
assert.equal((repAbort.match(/смените/gi) || []).length, 1);
assert.match(repAbort, /вручную в настройках/);
const repPlain = m.buildEscalationReport({
  kind: 'toolchain', kindMessage: '', failureLog: 'NO_JAVA', rungsTried: ['new-strategy'], recoveryCycles: 1, lastAgentOutput: 'gave up',
});
assert.doesNotMatch(repPlain, /смените/i);

// wiring: the old hard-stop messages are gone from the pipeline
const src = fs.readFileSync(path.join(root, 'lib/termux-agent.ts'), 'utf8');
assert.doesNotMatch(src, /Повтор сборки остановлен до запуска Gradle; проверьте/);
assert.doesNotMatch(src, /Восстановление остановлено: модель несколько раз вернула неверный формат/);
assert.match(src, /runEscalationLadder\(/);
assert.equal((src.match(/completeOrEscalate\(/g) || []).length >= 3, true);
console.log('AIB_AGENT_ESCALATION_SELFTEST_OK');
