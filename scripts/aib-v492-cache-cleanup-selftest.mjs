import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { typescript as ts } from './test-helpers/load-typescript.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'lib/termux-cache-cleanup.ts'), 'utf8');
const fn = source.match(/function buildCleanupScript\(\): string \{\s*return `([\s\S]*?)`\.trim\(\);\s*\}/);
assert.ok(fn, 'production buildCleanupScript is extracted');
const cleanup = new Function('return `'+fn[1]+'`.trim();')(); // exact trusted production template decoding
assert.match(source, /runEmbeddedTermuxCommand\(buildCleanupScript\(\)/);
assert.match(source, /r\.exitCode === 0 && !r\.timedOut && \/\^CLEANUP_OK\$\/m\.test\(r\.stdout/);
assert.doesNotMatch(cleanup, /apt-get|GRADLE_USER_HOME|\\\/tmp\\\//);

const tmp = fs.mkdtempSync(path.join(root, '.aib-v492-cache-selftest-'));
const prefix = path.join(tmp, 'private', 'usr');
const home = path.join(tmp, 'private', 'home');
const outside = path.join(tmp, 'private', 'data');
const mkdir = p => fs.mkdirSync(p, { recursive: true });
try {
  for (const p of [path.join(prefix, 'bin'), path.join(prefix, 'lib'), path.join(prefix, 'opt'), path.join(prefix, 'tmp'), path.join(prefix, 'var/cache/apt/archives'), path.join(prefix, 'var/lib/proot-distro/installed-rootfs'), home, outside, path.join(home, 'exports'), path.join(home, 'workspace'), path.join(home, '.cache'), path.join(home, '.cache/pip'), path.join(home, '.termux'), path.join(home, '.gradle'), path.join(prefix, 'tools')]) mkdir(p);
  fs.writeFileSync(path.join(home, 'exports', 'preserve.tmp'), 'user data');
  fs.writeFileSync(path.join(home, 'workspace', 'fixture'), 'project');
  fs.writeFileSync(path.join(prefix, 'bin', 'tool'), 'tool');
  fs.writeFileSync(path.join(prefix, 'tools', 'fixture'), 'installed tool');
  fs.writeFileSync(path.join(prefix, 'var/lib/proot-distro/installed-rootfs', 'fixture'), 'rootfs');
  fs.writeFileSync(path.join(home, '.cache', 'pip', 'cachefile'), 'cache');
  fs.mkdirSync(path.join(home, '.cache', 'pnpm'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'escape-data'), 'must survive');
  fs.symlinkSync(outside, path.join(home, '.cache', 'yarn'));
  fs.writeFileSync(path.join(prefix, 'var/cache/apt/archives', 'known.deb'), 'apt cache');
  fs.writeFileSync(path.join(tmp, 'host-tmp'), 'untouched');

  const run = (override = {}) => spawnSync('/bin/sh', ['-c', cleanup], {
    encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, PREFIX: prefix, HOME: home, ...override },
  });
  const ok = run();
  assert.equal(ok.status, 2, 'symlink escape rejects cleanup');
  assert.match(ok.stdout, /CLEANUP_REJECTED:(?:alias|noncanonical_roots)/);
  assert.equal(fs.existsSync(path.join(home, '.cache', 'pip')), false, `known cache cleaned; status=${ok.status} output=${ok.stdout} error=${ok.stderr}`);
  assert.equal(fs.existsSync(path.join(outside, 'escape-data')), true, 'symlink target survives');
  for (const p of [path.join(home, 'exports/preserve.tmp'), path.join(home, 'workspace/fixture'), path.join(prefix, 'bin/tool'), path.join(prefix, 'tools/fixture'), path.join(prefix, 'var/lib/proot-distro/installed-rootfs/fixture'), path.join(tmp, 'host-tmp')]) assert.equal(fs.existsSync(p), true, `${p} preserved`);
  assert.equal(fs.existsSync(path.join(prefix, 'var/cache/apt/archives/known.deb')), false, 'only direct known archive cache is removable');

  for (const env of [{ PREFIX: '' }, { HOME: '' }, { PREFIX: tmp }]) {
    const rejected = run(env);
    assert.notEqual(rejected.status, 0, 'invalid native root rejected');
    assert.doesNotMatch(rejected.stdout, /^CLEANUP_OK$/m);
  }

  fs.unlinkSync(path.join(home, '.cache/yarn'));
  const success = run();
  assert.equal(success.status, 0, success.stdout+success.stderr);
  assert.match(success.stdout, /^CLEANUP_OK$/m, 'real production shell succeeds with safe roots');
  assert.equal(fs.existsSync(path.join(home, 'exports/preserve.tmp')), true);
  assert.equal(fs.existsSync(path.join(home, 'workspace/fixture')), true);
  assert.equal(fs.existsSync(path.join(prefix, 'opt')), true);
  const mismatch = run({HOME:outside});
  assert.notEqual(mismatch.status,0);
  assert.match(mismatch.stdout,/CLEANUP_REJECTED:root_relationship/);

  // Invoke the actual exported async wrapper with only the native bridge mocked.
  const api={};let nextResult;let calls=0;let lastCommand='';
  const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const native=async(command,options)=>{calls++;lastCommand=command;assert.equal(options.timeoutMs,180000);if(nextResult instanceof Error)throw nextResult;return nextResult;};
  vm.runInNewContext(compiled,{exports:api,module:{exports:api},require:id=>{
    if(id==='./termux-bridge')return {runEmbeddedTermuxCommand:native};
    if(id==='./persistent-logger')return {persistentLogger:{add(){}}};
    throw new Error('unexpected wrapper dependency '+id);
  },Math,Number,String,Promise});
  for(const [nativeResult,expected] of [
    [{exitCode:0,timedOut:false,stdout:'CLEANUP_OK\n',stderr:''},true],
    [{exitCode:1,timedOut:false,stdout:'CLEANUP_OK\n',stderr:''},false],
    [{exitCode:0,timedOut:true,stdout:'CLEANUP_OK\n',stderr:''},false],
    [{exitCode:0,timedOut:false,stdout:'other',stderr:''},false],
    [{exitCode:0,timedOut:false,stdout:'',stderr:'CLEANUP_OK\n'},false],
    [new Error('EMBEDDED_EXEC_RUNTIME_NOT_READY'),false],
  ]) {
    nextResult=nativeResult;const progress=[];
    const result=await api.runTermuxCacheCleanup(value=>progress.push(value));
    assert.equal(result.ok,expected);
    assert.equal(progress.at(-1).percent,expected?100:0);
  }
  assert.equal(calls,6,'each wrapper call uses exactly the private native route');
  assert.equal(lastCommand,cleanup,'executed source equals shell fixture under test');
  console.log('aib-v492-cache-cleanup-selftest: PASS (hermetic fixture; Android NOT RUN)');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
