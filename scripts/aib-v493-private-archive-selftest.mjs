// Host-fixture regression test only; this does not assert Android/device readiness.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'aib-v493-archive-'));
const fixture = path.join(work, 'fixture project');
const prefix = path.join(work, 'private-prefix');
fs.mkdirSync(fixture, { recursive: true });
fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
// Model the embedded private runtime using the host interpreter; no package installation.
fs.symlinkSync(process.execPath === '/usr/bin/python3' ? process.execPath : '/usr/bin/python3', path.join(prefix, 'bin', 'python3'));
if (!fs.existsSync(path.join(prefix, 'bin', 'python3'))) {
  fs.unlinkSync(path.join(prefix, 'bin', 'python3'));
  fs.symlinkSync('/usr/local/bin/python3', path.join(prefix, 'bin', 'python3'));
}
const put = (name, text) => { const file = path.join(fixture, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
put('tracked.txt', 'fixture current content\n');
put('.env.example', 'sample only\n');
put('.env', 'DO_NOT_ARCHIVE=secret\n');
put('.env.production', 'DO_NOT_ARCHIVE=secret\n');
put('node_modules/pkg/x.js', 'exclude');
put('.git/config', 'exclude');
put('.gradle/cache', 'exclude');
put('android/app/build/output', 'exclude');
const outside = path.join(work, 'outside-secret'); fs.writeFileSync(outside, 'outside secret');
fs.symlinkSync(outside, path.join(fixture, 'linked-secret'));
fs.symlinkSync(path.join(work, 'outside-dir'), path.join(fixture, 'linked-dir'));

const repoFile = fileURLToPath(new URL('../lib/github-tools.ts', import.meta.url));
let source = fs.readFileSync(repoFile, 'utf8');
source = source.replace(/^import .*;\n/gm, '');
// The source is intact; interpreter-origin translation occurs only in the intercepted host command below.
source = `const NativeModules = {}; const AI_BUILDER_SHARED_ROOT = '/storage/emulated/0/AIBuilderTermux';\nconst isWithinSharedAppRoot = () => true;\nlet executeGuardedTermuxCommand;\n` + source;
const moduleFile = path.join(work, 'github-tools.ts');
fs.writeFileSync(moduleFile, source);
let captured = '';
let lastResult;
// Inject the intercepted executor into module scope after imports are stripped.
source = fs.readFileSync(moduleFile, 'utf8').replace('let executeGuardedTermuxCommand;', 'const executeGuardedTermuxCommand = globalThis.__archiveRunner;');
fs.writeFileSync(moduleFile, source);
globalThis.__archiveRunner = async (command) => {
  captured = command;
  const originCheck = 'if os.path.commonpath((prefix, runtime)) != prefix: raise SystemExit("GITHUB_PACK_PRIVATE_PYTHON_OUTSIDE_PREFIX")';
  assert.ok(command.includes(originCheck), 'actual script must retain its private interpreter-origin check');
  const hostCommand = command.replace(originCheck, 'if not os.path.isfile(runtime): raise SystemExit("HOST_FIXTURE_PYTHON_MISSING")');
  const run = spawnSync('/bin/sh', ['-c', hostCommand], { encoding: 'utf8', env: { ...process.env, PREFIX: prefix, TMPDIR: work } });
  lastResult = run;
  return { stdout: run.stdout || '', stderr: run.stderr || '', exitCode: run.status ?? 1, timedOut: false, outputTruncated: false };
};
try {
  const { pathToFileURL } = await import('node:url');
  const { githubPackLocalDir } = await import(pathToFileURL(moduleFile).href);
  const archive = path.join(work, 'result.zip');
  const result = await githubPackLocalDir(fixture, archive);
  assert.match(captured, /\$PREFIX\/bin\/python3/);
  assert.doesNotMatch(captured, /command -v zip|pkg install|pip install|npm install/);
  const check = spawnSync('/usr/bin/python3', ['-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); names=set(z.namelist()); expected={"tracked.txt", ".env.example"}; assert expected <= names, names; assert not any(n==".env" or n.startswith((".git/","node_modules/",".gradle/","android/","linked-dir/")) or n=="linked-secret" for n in names), names; assert z.testzip() is None', archive], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
  assert.equal(result.archivePath, archive);
  const oldArchive = fs.readFileSync(archive);
  const empty = path.join(work, 'empty-project'); fs.mkdirSync(empty);
  await assert.rejects(() => githubPackLocalDir(empty, archive), /GITHUB_PACK_FAILED/);
  assert.deepEqual(fs.readFileSync(archive), oldArchive, 'failed export must preserve the previous valid ZIP');
  assert.ok(!fs.readdirSync(work).some(name => name.startsWith('.aib-source-')), 'temporary ZIP must be cleaned after success or failure');
  // A present interpreter that fails must propagate nonzero; never emit success.
  fs.unlinkSync(path.join(prefix, 'bin/python3'));
  fs.writeFileSync(path.join(prefix, 'bin/python3'), '#!/bin/sh\nexit 17\n', { mode: 0o755 });
  await assert.rejects(() => githubPackLocalDir(fixture, path.join(work, 'failed.zip')), /GITHUB_PACK_FAILED/);
  assert.equal(lastResult.status, 17);
  assert.doesNotMatch(lastResult.stdout || '', /AIB_GH_PACK_OK/);
  console.log('PASS: host fixture private ZIP, contents/exclusions, symlink safety, atomic preservation/cleanup, private-python failure status');
} finally {
  delete globalThis.__archiveRunner;
  fs.rmSync(work, { recursive: true, force: true });
}
