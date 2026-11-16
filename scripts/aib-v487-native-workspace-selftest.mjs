import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
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
const source = fs.readFileSync(new URL('../plugins/withTermuxBridge.js', import.meta.url), 'utf8');
const kotlin = plugin.__moduleKotlinForTest('com.example.hermetic');
const home = '/data/user/0/com.example/files/termux/home';
const privateAlias = home.replace('/data/user/0/', '/data/data/');
const roots = ['/storage/emulated/0/AIBuilderTermux'];
function lexicalAllowed(input, allFiles) {
  const full = path.posix.resolve(input);
  return [home, privateAlias].some(r => full === r || full.startsWith(r + '/')) ||
    (allFiles && roots.some(r => full === r || full.startsWith(r + '/')));
}
for (const p of [home, `${home}/nested/project`, privateAlias, `${privateAlias}/nested`, '/storage/emulated/0/AIBuilderTermux/a/b']) assert.equal(lexicalAllowed(p, true), true);
for (const p of ['/data/user/0/other/private', '/storage/emulated/0/AIBuilderTermuxX/a', '/sdcard/Android/data/pkg/files', '/tmp/../../data/user/0/other']) assert.equal(lexicalAllowed(p, true), false);
assert.equal(lexicalAllowed('/storage/emulated/0/AIBuilderTermux/a', false), false);
assert.equal(lexicalAllowed('/sdcard/AIBuilderTermux/a', true), false);
// Real host procfd traversal negative: held-directory path cannot escape via a symlink component.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aib-v487-'));
try {
  fs.mkdirSync(path.join(tmp, 'root', 'safe'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'foreign'));
  fs.writeFileSync(path.join(tmp, 'foreign', 'secret'), 'foreign');
  fs.symlinkSync(path.join(tmp, 'foreign'), path.join(tmp, 'root', 'link'));
  const rootfd = fs.openSync(path.join(tmp, 'root'), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try {
    assert.throws(() => fs.openSync(`/proc/self/fd/${rootfd}/link`, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW));
    assert.throws(() => { const parts = '../foreign/secret'.split('/'); if (parts.some(x => !x || x === '.' || x === '..')) throw new Error('rejected traversal'); });
    const safeFd = fs.openSync(`/proc/self/fd/${rootfd}/safe`, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    fs.closeSync(safeFd);
  } finally { fs.closeSync(rootfd); }
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
// Assert the generated Kotlin—not just source fragments—implements the contract.
assert.match(kotlin, /fun getAIBuilderWorkspaceFileCapabilities\(promise: Promise\)/);
assert.match(kotlin, /"procfd-nofollow"/);
assert.match(kotlin, /fun readAIBuilderWorkspaceFile\(relativePath: String, promise: Promise\)/);
assert.match(kotlin, /fun writeAIBuilderWorkspaceFile\(relativePath: String, content: String, promise: Promise\)/);
assert.match(kotlin, /openWorkspaceDirectory\("\/proc\/self\/fd\/\$\{current\.fd\}\/\$part"/);
assert.match(kotlin, /OsConstants\.O_NOFOLLOW/);
assert.match(kotlin, /metadata\.st_mode.*OsConstants\.S_IFREG/);
assert.match(kotlin, /out\.size\(\) \+ n > aiBuilderWorkspaceMaxBytes/);
assert.match(kotlin, /bytes\.size > aiBuilderWorkspaceMaxBytes/);
assert.match(kotlin, /Os\.rename\(temp, target\)/);
assert.match(kotlin, /getAIBuilderWorkspaceFileCapabilities/);
assert.match(kotlin, /result\.putBoolean\("readOnly", true\)/); // SAF remains metadata-only
assert.ok(!/openInputStream\(uri\)|openOutputStream\(uri/.test(kotlin));
const cwdScopeGate = kotlin.indexOf('if (!lexicalInHome && lexicalSharedRoot == null)');
const cwdLstatHelper = kotlin.indexOf('fun cwdLstat(path: String, root: Boolean)');
const cwdLstatCall = kotlin.indexOf('Os.lstat(path)');
const descendantLstat = kotlin.indexOf('cwdLstat(component.absolutePath');
assert.ok(cwdScopeGate >= 0 && cwdScopeGate < cwdLstatHelper && cwdLstatHelper < cwdLstatCall && cwdLstatCall < descendantLstat, 'cwd scope check precedes helper and descendant metadata IO');
assert.match(kotlin, /sharedLexicalRoots = listOf\("\/storage\/emulated\/0\/AIBuilderTermux"\)/);
assert.doesNotMatch(kotlin, /\/sdcard\/AIBuilderTermux/);
assert.match(kotlin, /privateAliasRoot = homePath\.replaceFirst/);
console.log('v487 hermetic native workspace safety checks passed');
