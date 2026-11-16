import { loadBalanceDiagnostic } from './test-helpers/load-balance-diagnostic.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { typescript as ts } from './test-helpers/load-typescript.mjs';
const require = createRequire(import.meta.url);

const file = path.resolve('lib/manus-api.ts');
let calls = [], queue = [], probeResponse;
const fakeTransport = async (provider, route, endpoint, init) => {
  calls.push({provider, route, endpoint, init});
  const item = queue.shift();
  if (!item) throw new Error('unexpected request: '+endpoint);
  if (item instanceof Error) throw item;
  return item instanceof Response ? item : Response.json(item.body ?? item, {status: item.status ?? 200});
};
const fakeProbe = async (draft, signal) => { calls.push({probe: draft, signal}); return probeResponse; };
const mod = new Module(file); mod.filename = file; mod.paths = Module._nodeModulePaths(path.dirname(file));
mod.require = (request) => request === './manus-balance-diagnostic' ? loadBalanceDiagnostic() : request === './persistent-logger' ? { persistentLogger: { add() {} } } : request.includes('productionProviderTransport') ? { securedProviderFetch: fakeTransport, probeManusCredential: fakeProbe } : require(request);
mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText, file);
const api = mod.exports;
const ok = body => ({body});
const page = (messages, extra={}) => ok({ok:true,messages,has_more:false,...extra});
const reset = (...items) => { calls=[]; queue=[...items]; };
const stateCb = list => async s => list.push({...s});
const assistant = (id, content) => ({id,type:'assistant_message',assistant_message:{content}});
const stopped = id => ({id,type:'status_update',status_update:{agent_status:'stopped'}});

assert.equal(typeof api.runManusTask,'function'); assert.equal(typeof api.validateManusAccount,'function');
assert.match(fs.readFileSync(file,'utf8'),/https:\/\/api\.manus\.ai/);
probeResponse=Response.json({ok:true,user_id:'usr_1',name:'Ada'});
assert.deepEqual(await api.validateManusAccount('draft-key'),{userId:'usr_1',name:'Ada'}); assert.equal(calls[0].probe,'draft-key');
reset(ok({ok:true,user_id:'saved',name:'Grace'}));
assert.deepEqual(await api.validateManusAccount(),{userId:'saved',name:'Grace'}); assert.equal(calls[0].endpoint,'v2/user.me'); assert.equal(calls[0].init.method,'GET');
probeResponse=Response.json({ok:false},{status:401});
await assert.rejects(api.validateManusAccount('secret'),/MANUS_UNAUTHORIZED/);
assert.doesNotMatch((await (async()=>{try {await api.validateManusAccount('secret')}catch(e){return e.message}})()),/secret/);

// Exact create RPC contract, persisted marker and separated message/status events.
const persisted=[];
reset(ok({ok:true,task_id:'t1',task_url:'https://manus.im/tasks/t1'}),page([assistant('e1','Done'),stopped('e2')]),ok({ok:true,task:{id:"t1",status:"stopped",has_running_background_jobs:false}}));
assert.equal(await api.runManusTask({prompt:'do it',profile:'max-high',onState:stateCb(persisted)}),'Done');
assert.equal(persisted[0].submissionUnknown,true); assert.equal(persisted.find(s=>s.taskId==='t1').pending,true); assert.equal(persisted.at(-1).pending,false);
assert.equal(calls[0].provider,'manus'); assert.equal(calls[0].route.baseUrl,'https://api.manus.ai');
assert.equal(calls[0].endpoint,'v2/task.create'); assert.equal(calls[0].init.method,'POST');
assert.deepEqual(JSON.parse(calls[0].init.body),{message:{content:'do it'},agent_profile:'max-high',interactive_mode:true,share_visibility:'private'});
assert.equal(calls[1].endpoint.startsWith('v2/task.listMessages?'),true); assert.equal(calls[2].endpoint,'v2/task.detail?task_id=t1');

// Follow-up send, then cursor pagination/dedupe and prior-boundary exclusion.
reset(ok({ok:true}),page([assistant('e1','old'),assistant('e2','A')],{has_more:true,next_cursor:'c1'}),page([assistant('e2','A'),assistant('e3','B'),stopped('e4')]),ok({ok:true,task:{id:"t1",status:"stopped",has_running_background_jobs:false}}));
assert.equal(await api.runManusTask({prompt:'followup',profile:'lite',previous:{taskId:'t1',lastEventId:'e1',pending:false},onState:async()=>{}}),'A\nB');
assert.equal(calls[0].endpoint,'v2/task.sendMessage'); assert.deepEqual(JSON.parse(calls[0].init.body),{task_id:'t1',message:{content:'followup'},agent_profile:'lite'});
assert.match(calls[1].endpoint,/start_event_id=e1/); assert.match(calls[2].endpoint,/cursor=c1/);

// Pending resume polls only; never sends supplied prompt.
reset(page([assistant('e6','Resumed'),stopped('e7')]),ok({ok:true,task:{id:"t1",status:"stopped",has_running_background_jobs:false}}));
assert.equal(await api.runManusTask({prompt:'ignored',profile:'standard',previous:{taskId:'t1',lastEventId:'e5',pending:true},onState:async()=>{}}),'Resumed existing Manus task (the supplied prompt was not sent).\nResumed');
assert.equal(calls.length,2); assert.match(calls[0].endpoint,/start_event_id=e5/);

// Waiting status stores non-pending waiting state, returns explanation and warns that follow-up skips action.
const waiting=[];
reset(page([{id:'ew',type:'status_update',status_update:{agent_status:'waiting',status_detail:{waiting_description:'Approve payment?'}}}]));
const w=await api.runManusTask({prompt:'x',profile:'standard',previous:{taskId:'tw',taskUrl:'https://manus.im/tasks/tw',pending:true},onState:stateCb(waiting)});
assert.match(w,/Approve payment\?[\s\S]*https:\/\/manus\.im\/tasks\/tw[\s\S]*No action was confirmed[\s\S]*follow-up/i); assert.equal(calls.length,1);
assert.equal(waiting.at(-1).pending,false); assert.equal(waiting.at(-1).waiting,true);

// Background jobs delay completion; persisted stopped status survives a later polling cycle.
const old=globalThis.setTimeout; globalThis.setTimeout=(fn)=>old(fn,0);
try {
 reset(page([stopped('eb')]),ok({ok:true,task:{id:"t1",status:"stopped",has_running_background_jobs:true}}),page([]),ok({ok:true,task:{id:"t1",status:"stopped",has_running_background_jobs:false}}));
 assert.equal(await api.runManusTask({prompt:'x',profile:'standard',previous:{taskId:'tb',pending:true},onState:async()=>{}}),'Resumed existing Manus task (the supplied prompt was not sent).\nManus task completed.');
} finally { globalThis.setTimeout=old; }

// Error message fixture is distinct from status update; safe errors never leak bodies.
reset(page([{id:'err',type:'error_message',error_message:{content:'secret provider details'}}]));
await assert.rejects(api.runManusTask({prompt:'x',profile:'standard',previous:{taskId:'te',pending:true},onState:async()=>{}}),e=>e.message==='MANUS_REMOTE_ERROR: The Manus task encountered an error.');
const ac=new AbortController(); ac.abort(); await assert.rejects(api.runManusTask({prompt:'x',profile:'standard',signal:ac.signal,onState:async()=>{}}),/MANUS_TIMEOUT/);
reset({status:500,body:{error:'private response body'}});
await assert.rejects(api.runManusTask({prompt:'x',profile:'standard',onState:async()=>{}}),e=>{assert.match(e.message,/MANUS_REQUEST_FAILED/);assert.doesNotMatch(e.message,/private response body/);return true;});
// Unknown task ID persists guard before the POST and is never auto-retried.
reset(new Error('connection lost'));
const unknown=[]; await assert.rejects(api.runManusTask({prompt:'ambiguous',profile:'standard',onState:stateCb(unknown)}));
assert.equal(unknown[0].submissionUnknown,true);
await assert.rejects(api.runManusTask({prompt:'retry?',profile:'standard',previous:unknown.at(-1),onState:async()=>{}}),/MANUS_SUBMISSION_UNKNOWN.*Check cloud task history/);

// A definitive rejected create may be explicitly retried; ambiguous POST may not.
reset({status:401,body:{error:'do not print'}});
const rejected=[];
await assert.rejects(api.runManusTask({prompt:'x',profile:'standard',onState:stateCb(rejected)}),/MANUS_UNAUTHORIZED/);
assert.equal(rejected.at(-1).submissionUnknown,false);
reset(ok({ok:true,task_id:'retry'}),page([assistant('a','accepted'),stopped('s')]),ok({ok:true,task:{id:"t1",status:"stopped",has_running_background_jobs:false}}));
assert.equal(await api.runManusTask({prompt:'x',profile:'standard',previous:rejected.at(-1),onState:async()=>{}}),'accepted');
assert.equal(calls[0].endpoint,'v2/task.create');

// Question text is not lost while waiting, and no confirmAction is invoked.
reset(page([assistant('q1','Which colour?'),{id:'q2',type:'status_update',status_update:{agent_status:'waiting',status_detail:{waiting_for_event_type:'messageAskUser'}}}]));
assert.match(await api.runManusTask({prompt:'x',profile:'standard',previous:{taskId:'q',pending:true},onState:async()=>{}}),/Which colour/);
assert.equal(calls.some(c=>c.endpoint?.includes('confirmAction')),false);

// Legacy state without a checkpoint obtains a boundary BEFORE sending a follow-up.
reset(page([stopped('old')]),ok({ok:true}),page([stopped('old'),assistant('new','fresh'),stopped('newstop')]),ok({ok:true,task:{id:"t1",status:"stopped",has_running_background_jobs:false}}));
assert.equal(await api.runManusTask({prompt:'next',profile:'standard',previous:{taskId:'legacy',pending:false},onState:async()=>{}}),'fresh');
assert.match(calls[0].endpoint,/order=desc/);assert.equal(calls[1].endpoint,'v2/task.sendMessage');

// A newer running event overrides an older stopped event; no premature completion.
const savedTimer=globalThis.setTimeout;globalThis.setTimeout=(fn,ms)=>savedTimer(fn,ms===1500?0:ms);
try {
 reset(page([stopped('oldstop'),{id:'running',type:'status_update',status_update:{agent_status:'running'}}]),ok({ok:true,task:{id:"t1",status:"stopped",has_running_background_jobs:false}}),page([assistant('newresult','later'),stopped('newstop')]),ok({ok:true,task:{id:"t1",status:"stopped",has_running_background_jobs:false}}));
 assert.match(await api.runManusTask({prompt:'x',profile:'standard',previous:{taskId:'active',pending:true},onState:async()=>{}}),/later/);
 assert.equal(calls.length,4);
} finally {globalThis.setTimeout=savedTimer;}

// Failure to persist the ambiguity marker prevents any remote request.
reset();await assert.rejects(api.runManusTask({prompt:'x',profile:'standard',onState:async()=>{throw new Error('disk');}}),/disk/);assert.equal(calls.length,0);

console.log('AIB_V482_MANUS_SELFTEST_OK contract=task-v2 pagination=cursor+dedupe resume=followup waiting=explicit background=checked auth=safe-errors');

// v484: real task.detail envelope; root-level fields must never decide completion.
const taskDetail = (status, jobs, extra = {}) => ok({ok:true,task:{id:'nested',status,...(jobs === undefined ? {} : {has_running_background_jobs:jobs})},...extra});
const fastTimer=globalThis.setTimeout;
globalThis.setTimeout=(fn,ms)=>fastTimer(fn,ms===1500?0:ms);
try {
 // A missing background field is unknown, not false (older task schema).
 reset(page([assistant('n1','Kept'),stopped('n2')]),taskDetail('stopped',undefined,{has_running_background_jobs:false}),page([]),taskDetail('stopped',false));
 const nestedStates=[];
 assert.match(await api.runManusTask({prompt:'x',profile:'standard',previous:{taskId:'nested',pending:true},onState:stateCb(nestedStates)}),/Kept/);
 assert.equal(calls.length,4); assert.equal(nestedStates.at(-1).pending,false);
 // A newer running snapshot overrides an older stopped event, even with jobs=false.
 reset(page([stopped('old')]),taskDetail('running',false),page([assistant('final','New result'),stopped('new')]),taskDetail('stopped',false));
 assert.match(await api.runManusTask({prompt:'x',profile:'standard',previous:{taskId:'nested',pending:true},onState:async()=>{}}),/New result/);
 assert.equal(calls.length,4);
 // Detail stopped alone cannot bypass a new turn's event boundary.
 reset(page([]),taskDetail('stopped',false),page([assistant('late','Last page result'),stopped('late-stop')]),taskDetail('stopped',false));
 assert.match(await api.runManusTask({prompt:'x',profile:'standard',previous:{taskId:'nested',pending:true},onState:async()=>{}}),/Last page result/);
 assert.equal(calls.length,4);
 // Persisted stopped checkpoints from v483 resume without creating or sending again.
 reset(page([]),taskDetail('stopped',false));
 assert.match(await api.runManusTask({prompt:'ignored',profile:'standard',previous:{taskId:'nested',lastEventId:'done',pending:true,stopped:true,collectedOutput:'Saved answer'},onState:async()=>{}}),/Saved answer/);
 assert.equal(calls.length,2); assert.equal(calls.every(c=>c.init.method==='GET'),true);
} finally {globalThis.setTimeout=fastTimer;}
for (const [status,code] of [['error','MANUS_REMOTE_ERROR'],['deleted','MANUS_NOT_FOUND']]) {
 const states=[]; reset(page([]),taskDetail(status,false));
 await assert.rejects(api.runManusTask({prompt:'x',profile:'standard',previous:{taskId:'nested',pending:true},onState:stateCb(states)}),new RegExp(code));
 assert.equal(states.at(-1).pending,false);
}
for (const body of [{ok:true,has_running_background_jobs:false},{ok:true,task:[]},{ok:true,task:{status:'stopped',has_running_background_jobs:'false'}}]) {
 reset(page([stopped('s')]),ok(body));
 await assert.rejects(api.runManusTask({prompt:'x',profile:'standard',previous:{taskId:'nested',pending:true},onState:async()=>{}}),/MANUS_INVALID_RESPONSE/);
 assert.equal(calls.length,2);
}
console.log('AIB_V484_MANUS_SELFTEST_OK detail=nested-task root-fields=ignored missing-jobs=unknown running=not-final resume=no-repost invalid=safe');
