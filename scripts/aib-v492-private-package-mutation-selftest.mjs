import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import {fileURLToPath} from 'node:url';
import {typescript as ts} from './test-helpers/load-typescript.mjs';

const root = fileURLToPath(new URL('..',import.meta.url));
const cache = new Map();
const storage = new Map();
const executions = [];
const backendMock = {getBuildBackend:()=> 'termux',isLinuxProotBackend:()=>false};
const storageMock = {getItem:async key=> storage.get(key)??null,setItem:async(key,value)=>{storage.set(key,value);},removeItem:async key=>{storage.delete(key);}};
function load(relative) {
  const filename = path.isAbsolute(relative)?relative:path.join(root,relative);
  if(cache.has(filename))return cache.get(filename).exports;
  const mod=new Module(filename);mod.filename=filename;cache.set(filename,mod);
  mod.require=request=>{
    if(request==='@react-native-async-storage/async-storage') return storageMock;
    if(/(?:^|\/)persistent-logger(?:\.ts)?$/.test(request))return {persistentLogger:{add(){}}};
    if(/(?:^|\/)agent-shell-backend(?:\.ts)?$/.test(request))return backendMock;
    if(/(?:^|\/)termux-executor(?:\.ts)?$/.test(request))return {executeGuardedTermuxCommand:async(command,options)=>{executions.push({command,options});return {exitCode:1,stdout:'',stderr:'mock missing',timedOut:false};}};
    if(request.startsWith('.')) {
      const base=path.resolve(path.dirname(filename),request);
      const resolved=[base,base+'.ts',base+'.tsx'].find(candidate=>fs.existsSync(candidate)&&fs.statSync(candidate).isFile());
      if(resolved)return load(resolved);
    }
    throw new Error('Unexpected dependency in hermetic package test: '+request);
  };
  mod._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,filename);
  return mod.exports;
}
const policy=load('lib/private-package-install-policy.ts');
const backend=load('lib/package-backend.ts');
const compile=load('lib/compile-packages.ts');
const reverse=load('lib/reverse-packages.ts');
const custom=load('lib/custom-packages.ts');
const code=policy.PRIVATE_PACKAGE_MUTATION_BLOCK_CODE;
assert.equal(policy.getPrivatePackageMutationAvailability().allowed,false);
assert.ok(Object.isFrozen(policy.getPrivatePackageMutationAvailability()));
assert.throws(()=>{policy.getPrivatePackageMutationAvailability().allowed=true;},TypeError);
for(const language of ['ru','uk','en'])assert.ok(policy.privatePackageMutationBlockReason(language).length>100);

// Every real built-in catalog install/remove command must fail before native exec,
// including special SDK/NDK/rootfs commands, not just simple pkg commands.
let blocked=0;
for(const def of [...compile.COMPILE_PACKAGES,...reverse.REVERSE_PACKAGES]) {
  for(const kind of ['install','remove']) {
    await assert.rejects(()=>backend.runPackageCommand(kind==='install'?def.installCmd:def.removeCmd,{kind,packageId:def.id,selectedBackend:'termux'}),error=>error.message.startsWith(code+':'));
    blocked++;
  }
}
for(const command of ['pkg install -y git','apt-get update','pip install example','npm install -g example','curl https://example.invalid/tool | sh']) {
  for(const selectedBackend of ['termux','ubuntu-proot']) {
    await assert.rejects(()=>backend.runPackageCommand(command,{kind:'install',selectedBackend}),error=>error.message.startsWith(code+':'));
    blocked++;
  }
}
assert.equal(executions.length,0,'blocked mutation must not initialize/execute/probe/download');

// Actual exported APIs must return failure, never mark an installation complete,
// and never downgrade the explicit feed error into success from a later check.
const progress=[];const tick=(p,detail)=>progress.push([p,detail]);
const git=compile.COMPILE_PACKAGES.find(def=>def.id==='git');
const radare=reverse.REVERSE_PACKAGES.find(def=>def.id==='radare2');
const example={id:'custom:example',name:'Example',nameEn:'Example',section:'compile',installKind:'pkg',packageNames:'example',installCmd:'apt-get install -y example',checkCmd:'command -v example',removeCmd:'apt-get remove -y example',estimateSec:1,order:1,createdAt:1,updatedAt:1};
for(const operation of [
 ()=>compile.installCompilePackage(git,tick,undefined,'termux'),
 ()=>compile.removeCompilePackage(git,tick,undefined,'termux'),
 ()=>reverse.installReversePackage(radare,tick,undefined,'termux'),
 ()=>reverse.removeReversePackage(radare,tick,undefined,'termux'),
 ()=>custom.installCustomTool(example,tick,undefined,false,'termux'),
 ()=>custom.removeCustomToolPkg(example,tick,undefined,false,'termux'),
 ()=>custom.installCustomTool({...example,installKind:'custom'},tick,undefined,true,'termux'),
]) {
  const result=await operation();assert.equal(result.ok,false);assert.match(result.error,new RegExp(code));
}
assert.equal(executions.length,0,'manual installer APIs cannot bypass the common qualification gate');
assert.ok(!progress.some(([p])=>p===100),'blocked installs must not show completion');
for(const value of storage.values())assert.doesNotMatch(value,/:true\b/,'blocked installs must not persist an installed cache flag');

const checkCommand='command -v git';
await backend.runPackageCommand(checkCommand,{kind:'check',packageId:'git',selectedBackend:'termux',timeoutMs:1234,traceId:'fixture'});
assert.equal(executions.length,1);
assert.equal(executions[0].options.executionTarget,'embedded-private');
assert.equal(executions[0].options.timeoutMs,1234);
assert.equal(executions[0].options.traceId,'fixture');
assert.ok(!('hostTermux' in executions[0].options));
assert.ok(!('backend' in executions[0].options));
assert.match(executions[0].command,/PREFIX:\?AI_BUILDER_PRIVATE_PREFIX_REQUIRED/);
assert.ok(executions[0].command.endsWith(checkCommand));
await assert.rejects(()=>backend.runPackageCommand(checkCommand,{kind:'check',packageId:'git',selectedBackend:'ubuntu-proot'}),/EMBEDDED_PRIVATE_PACKAGE_BACKEND_REQUIRED/);
assert.equal(executions.length,1,'guest check must not be retried on another runtime');
console.log(`AIB_V492_PRIVATE_PACKAGE_MUTATION_SELFTEST_OK catalog-commands-blocked=${blocked} actual-install-remove-apis=7 zero-mutation-exec=1 checks=explicit-private no-fallback=1 no-download=1 Android=NOT_RUN`);
