import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { typescript as ts } from './test-helpers/load-typescript.mjs';
import { loadBalanceDiagnostic } from './test-helpers/load-balance-diagnostic.mjs';
const diagnostic = loadBalanceDiagnostic();
const build = value => JSON.parse(diagnostic.buildManusBalanceDiagnostic(200, 'success', value, 'accepted'));
const envelope = data => ({ ok: true, data });
const fields = ['total_credits', 'free_credits', 'periodic_credits', 'addon_credits', 'pro_monthly_credits', 'event_credits', 'refresh_credits', 'max_refresh_credits', 'next_refresh_time', 'current_period_end', 'refresh_interval'];
const fixtures = [[null, 'expected_envelope'], [[], 'expected_envelope'], ['secret-root', 'expected_envelope'], [{}, 'expected_successful_envelope'], [{ok:false}, 'expected_successful_envelope'], [{ok:'secret-ok'}, 'expected_successful_envelope'], [{ok:true}, 'expected_data_object'], [{ok:true,data:[]}, 'expected_data_object'], [envelope({}), 'missing_total_credits']];
for (const field of fields) fixtures.push([envelope({total_credits:1, [field]:'secret-field'}), `invalid_${field}`]);
for (const field of fields.filter(field => field !== 'refresh_interval')) {
  for (const value of [null, [], {}, false, 1.25, Infinity, NaN, Number.MAX_SAFE_INTEGER]) fixtures.push([envelope({total_credits:1,[field]:value}), `invalid_${field}`]);
}
for (const [value, reason] of fixtures) {
  const record = build(value);
  assert.equal(record.validator, reason); assert.equal(record.outcome, 'validator_rejected');
}
for (const n of [-2147483648, -5, 0, 2147483647]) assert.equal(build(envelope({total_credits:n})).validator, 'accepted');
assert.equal(build(envelope({total_credits:1, next_refresh_time:-1})).validator, 'invalid_next_refresh_time');
assert.equal(build(envelope({total_credits:1, current_period_end:8640000000001})).validator, 'invalid_current_period_end');
assert.equal(build(envelope({total_credits:1, refresh_interval:'monthly'})).validator, 'invalid_refresh_interval');
for (const interval of ['', 'daily', 'weekly']) assert.equal(build(envelope({total_credits:1, refresh_interval:interval})).validator, 'accepted');
const first = build(envelope({total_credits:871234567, refresh_interval:'daily', next_refresh_time:1900000000}));
const second = build(envelope({total_credits:-12345, refresh_interval:'weekly', next_refresh_time:0}));
assert.deepEqual(first, second, 'all valid numeric and enum metadata values must be indistinguishable');
const poisoned = {ok:true, data:{total_credits:871234567, private_name_583:'sk-secret', request_id:'request-secret', api_key:'key-secret', url:'https://private.invalid/body', refresh_interval:'private-interval'}};
const serialized = diagnostic.buildManusBalanceDiagnostic(200, 'success', poisoned, 'accepted');
for (const secret of ['871234567','private_name_583','sk-secret','request_id','request-secret','api_key','key-secret','https://','private-interval']) assert.equal(serialized.includes(secret), false, secret);
assert.equal(build(envelope({total_credits:0})).free_credits_type, 'absent');
assert.equal(build(envelope({total_credits:'secret'})).total_credits_type, 'string');
assert.equal(build([]).root_type, 'array'); assert.equal(build(null).root_object, false);
assert.equal(JSON.parse(diagnostic.buildManusBalanceDiagnostic(123456789, 'not_attempted', poisoned, 'transport_failed')).http_status, null);
// Production client, mocked transport and logger: no live requests or credentials.
const logs = []; let response, transportError; let requests = 0;
const file = path.resolve('lib/manus-api.ts'), mod = new Module(file); mod.filename = file;
mod.require = name => {
  if (name === './manus-balance-diagnostic') return diagnostic;
  if (name === './persistent-logger') return {persistentLogger:{add(...args){ logs.push(args); }}};
  if (name.includes('productionProviderTransport')) return {securedProviderFetch:async()=>{requests++;if(transportError)throw transportError;return response;},probeManusCredential:async()=>response};
  throw new Error('Unexpected dependency');
};
mod._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,file);
const api = mod.exports;
for (const [reply, expected] of [[Response.json(envelope({total_credits:871234567})), 'accepted'], [Response.json(envelope({total_credits:'sk-secret'})), 'validator_rejected'], [new Response('sk-secret'), 'json_failed'], [Response.json(poisoned,{status:403}), 'http_rejected']]) {
  response = reply; const before = logs.length;
  try { await api.getManusAvailableCredits(); } catch {}
  assert.equal(logs.length,before+1); const [level,tag,message] = logs.at(-1);
  assert.equal(level,'info'); assert.equal(tag,'BalanceDiagnostic'); assert.equal(JSON.parse(message).outcome,expected);
  assert.doesNotMatch(message,/sk-secret|871234567|private_name_583|https:\/\//);
}
transportError = new Error('https://secret.invalid/?key=sk-secret');
await assert.rejects(api.getManusAvailableCredits());
assert.equal(JSON.parse(logs.at(-1)[2]).outcome,'transport_failed');
assert.doesNotMatch(logs.at(-1)[2],/secret|https/);
transportError = null; response = Response.json({ok:true,user_id:'secret-user'});
const before = logs.length; await api.validateManusAccount(); assert.equal(logs.length,before,'account validation must not create balance diagnostics');
response = Response.json({ok:true,task:{status:'stopped',has_running_background_jobs:false}});
await api.runManusTask({prompt:'private prompt',profile:'standard',previous:{taskId:'private-task',stopped:true},onState:async()=>{}}).catch(()=>{});
assert.equal(logs.length,before,'task operations must not create balance diagnostics');
const aborted = new AbortController(); aborted.abort(); const callsBefore = requests;
await assert.rejects(api.getManusAvailableCredits(aborted.signal)); assert.equal(requests,callsBefore); assert.equal(logs.length,before);
console.log(`PASS v489 balance diagnostic: ${fixtures.length} validator rejection fixtures, values/keys/URLs redacted, one record per balance response, account/task isolation, no live API`);
