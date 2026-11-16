import { execFileSync } from 'node:child_process';

const script = `
import assert from 'node:assert/strict';
import { parseAgentReply, isUnmarkedJsonToolCall, unmarkedJsonToolProtocolHint, shouldRetryInvalidAgentProtocolReply, MAX_INVALID_AGENT_PROTOCOL_REPLIES } from './lib/termux-agent-protocol.ts';
const reasoning = "Пользователь хочет APK игры 2048. Нам нужно создать проект.\\nНужно выполнить TERMUX_RUN с командами.\\nНам нужно проверить наличие Android SDK.";
const parsedReasoning = parseAgentReply(reasoning);
assert.equal(parsedReasoning.kind, 'final');
assert.equal(parsedReasoning.message, reasoning);
const proseWithMarkerMention = "We need to continue with TERMUX_RUN:\\nthen inspect the SDK. TERMUX_DONE: should only be final.";
assert.equal(parseAgentReply(proseWithMarkerMention).kind, 'final');
assert.deepEqual(parseAgentReply('**TERMUX_RUN:**\\ncommand -v gradle'), { kind: 'run', command: 'command -v gradle' });
assert.deepEqual(parseAgentReply('TERMUX_DONE:\\n/storage/emulated/0/app.apk'), { kind: 'final', message: '/storage/emulated/0/app.apk' });

// Physical log: HTTP 200 body is valid JSON, but not the machine protocol marker.
const unmarked = '{"tool":"fs.read","args":{"path":"/storage/emulated/0/AIBuilderTermux/projects/demo/README.md"}}';
assert.equal(isUnmarkedJsonToolCall(unmarked), true);
assert.deepEqual(parseAgentReply(unmarked), { kind: 'final', message: unmarked }, 'unmarked JSON remains assistant text, never a TERMUX_RUN command');
assert.match(unmarkedJsonToolProtocolHint(unmarked), /not executed/);
assert.match(unmarkedJsonToolProtocolHint(unmarked), /AIB_TOOL:/);
assert.equal(isUnmarkedJsonToolCall('{"message":"hello"}'), false);
assert.equal(isUnmarkedJsonToolCall('AIB_TOOL: {"tool":"fs.read"}'), false, 'marked tool replies follow the separately validated protocol');

let modelCalls = 0;
let invalidReplies = 0;
while (shouldRetryInvalidAgentProtocolReply(invalidReplies)) {
  modelCalls += 1;
  invalidReplies += 1; // model repeats the same malformed-but-JSON reply
}
assert.equal(MAX_INVALID_AGENT_PROTOCOL_REPLIES, 3);
assert.equal(modelCalls, 3, 'always-invalid model response is bounded; no infinite forced-format calls');
assert.equal(shouldRetryInvalidAgentProtocolReply(3), false);
console.log('AIB_TERMUX_PROTOCOL_LOG_REGRESSION_SELFTEST_OK unmarked_json=NOT_EXECUTED retries=3');
`;
process.stdout.write(execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { encoding: 'utf8' }));
