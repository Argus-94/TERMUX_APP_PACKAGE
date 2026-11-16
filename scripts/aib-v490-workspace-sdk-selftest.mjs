import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const originalLoad = Module._load;
let plugin;
try {
  Module._load = function(request, parent, isMain) {
    if (request === '@expo/config-plugins') return { withAndroidManifest: config => config, withMainApplication: config => config, withDangerousMod: config => config };
    return originalLoad.call(this, request, parent, isMain);
  };
  plugin = require('../plugins/withTermuxBridge.js');
} finally { Module._load = originalLoad; }
const kotlin = plugin.__moduleKotlinForTest('com.karat.aibuilder');
const helper = kotlin.slice(kotlin.indexOf('private fun openWorkspaceDirectory('), kotlin.indexOf('/** Keeps parent directory handles'));
assert.match(helper, /Os\.open\(path, OsConstants\.O_RDONLY or OsConstants\.O_NOFOLLOW or OsConstants\.O_NONBLOCK or OsConstants\.O_CLOEXEC, 0\)/);
assert.match(helper, /\(Os\.fstat\(fd\)\.st_mode and OsConstants\.S_IFMT\) != OsConstants\.S_IFDIR/);
assert.ok(helper.indexOf('Os.fstat(fd)') < helper.indexOf('return fd'));
assert.match(helper, /catch \(e: Exception\) \{\s*try \{ Os\.close\(fd\) \} catch \(_: Exception\) \{ \}\s*throw e/);
assert.doesNotMatch(kotlin, /OsConstants\.O_DIRECTORY|Os\.unlink\(/);
for (const call of ['openWorkspaceDirectory(rootPath.path)', 'openWorkspaceDirectory(aiBuilderWorkspaceRoot)', 'openWorkspaceDirectory("/proc/self/fd/${current.fd}/$part")', 'openWorkspaceDirectory("/proc/self/fd/${root.fd}/.")']) assert.ok(kotlin.includes(call), call);
assert.equal((kotlin.match(/openWorkspaceDirectory\(/g) || []).length, 5, 'helper plus all four directory opens');
assert.match(kotlin, /finally \{ try \{ Os\.remove\(temp\) \} catch \(_: Exception\) \{ \} \}/);
assert.match(kotlin, /val temp = "\/proc\/self\/fd\/\$\{parent\.fd\}\/\$tempName"/);
assert.match(kotlin, /OsConstants\.O_CREAT or OsConstants\.O_EXCL or OsConstants\.O_NOFOLLOW/);
assert.match(kotlin, /Os\.rename\(temp, target\)/);
assert.match(kotlin, /aiBuilderWorkspaceRoot = "\/storage\/emulated\/0\/AIBuilderTermux"/);
assert.match(kotlin, /finally \{ handles\.asReversed\(\)\.forEach/);
assert.match(kotlin, /finally \{ root\.close\(\) \}/);

// Linux host analogue of the exact flags and fstat policy, NOT Android runtime proof.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aib-v490-sdk-'));
const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
function openDirectory(p) {
  const fd = fs.openSync(p, flags);
  try {
    if (!fs.fstatSync(fd).isDirectory()) throw new Error('AIB_WORKSPACE_NOT_DIRECTORY');
    return fd;
  } catch (e) { fs.closeSync(fd); throw e; }
}
try {
  const root = path.join(tmp, 'root');
  fs.mkdirSync(path.join(root, 'nested'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'outside'));
  fs.writeFileSync(path.join(root, 'file'), 'regular');
  fs.writeFileSync(path.join(tmp, 'outside', 'secret'), 'outside');
  fs.symlinkSync(path.join(tmp, 'outside'), path.join(root, 'link'));
  fs.symlinkSync(root, path.join(tmp, 'root-link'));
  const fifo = path.join(root, 'fifo');
  const mkfifo = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
  assert.equal(mkfifo.status, 0, mkfifo.stderr);
  assert.throws(() => openDirectory(path.join(tmp, 'root-link')));
  const rootfd = openDirectory(root);
  try {
    const proc = `/proc/self/fd/${rootfd}`;
    const probe = openDirectory(`${proc}/.`); fs.closeSync(probe);
    assert.throws(() => openDirectory(`${proc}/link`));
    assert.throws(() => openDirectory(`${proc}/file`), /NOT_DIRECTORY/);
    // Child timeout makes loss of O_NONBLOCK fail promptly instead of hanging the suite.
    const fifoProbe = spawnSync(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs'; const fd=fs.openSync(${JSON.stringify(fifo)}, ${flags}); try { if(fs.fstatSync(fd).isDirectory()) process.exit(2); } finally { fs.closeSync(fd); }`], { timeout: 2000, encoding: 'utf8' });
    assert.equal(fifoProbe.status, 0, `FIFO must open nonblocking and be rejected as non-directory: ${fifoProbe.error || fifoProbe.stderr}`);
    const nestedfd = openDirectory(`${proc}/nested`);
    try {
      const nested = `/proc/self/fd/${nestedfd}`;
      const temp = `${nested}/.aib-test.tmp`;
      const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      try { fs.writeFileSync(fd, 'safe'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temp, `${nested}/output`);
      assert.equal(fs.readFileSync(`${nested}/output`, 'utf8'), 'safe');
      fs.symlinkSync(path.join(tmp, 'outside', 'secret'), `${nested}/leaf-link`);
      assert.throws(() => fs.openSync(`${nested}/leaf-link`, flags));
      // Held parent remains stable even if the lexical path is replaced by a symlink.
      fs.renameSync(path.join(root, 'nested'), path.join(root, 'held'));
      fs.symlinkSync(path.join(tmp, 'outside'), path.join(root, 'nested'));
      assert.equal(fs.readFileSync(`${nested}/output`, 'utf8'), 'safe');
      assert.equal(fs.readFileSync(path.join(tmp, 'outside', 'secret'), 'utf8'), 'outside');
      assert.throws(() => openDirectory(`${proc}/nested`));
    } finally { fs.closeSync(nestedfd); }
  } finally { fs.closeSync(rootfd); }
  const countFds = () => fs.readdirSync('/proc/self/fd').length;
  const before = countFds();
  for (let i = 0; i < 64; i++) assert.throws(() => openDirectory(path.join(root, 'file')), /NOT_DIRECTORY/);
  assert.equal(countFds(), before, 'directory type rejection must close raw descriptors');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }

// Optional verification against a real installed PUBLIC SDK, not hand-written stubs.
if (process.env.AIB_ANDROID_JAR) {
  const api = spawnSync('javap', ['-classpath', process.env.AIB_ANDROID_JAR, 'android.system.Os', 'android.system.OsConstants'], { encoding: 'utf8' });
  assert.equal(api.status, 0, api.stderr);
  assert.match(api.stdout, /java\.io\.FileDescriptor open\(java\.lang\.String, int, int\)/);
  assert.match(api.stdout, /android\.system\.StructStat fstat\(java\.io\.FileDescriptor\)/);
  assert.match(api.stdout, /void remove\(java\.lang\.String\)/);
  for (const name of ['O_RDONLY', 'O_NOFOLLOW', 'O_NONBLOCK', 'O_CLOEXEC', 'S_IFMT', 'S_IFDIR']) assert.ok(api.stdout.includes(`int ${name};`), name);
  assert.doesNotMatch(api.stdout, /int O_DIRECTORY;|void unlink\(/);
  console.log('PASS: public SDK API signatures verified with javap');
}
console.log('PASS: v490 generated workspace API contract and host no-follow/fstat fixtures (not Android runtime tests)');
