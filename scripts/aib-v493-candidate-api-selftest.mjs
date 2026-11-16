#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { typescript as ts } from './test-helpers/load-typescript.mjs';
const root = path.resolve(new URL('..', import.meta.url).pathname);
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const require = createRequire(import.meta.url);
const generated = ts.transpileModule(read('lib/candidate-feed-probe.ts'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const privateRoot = '/data/user/0/com.karat.aibuilder/files';
const stageRoot = privateRoot + '/candidate-probes/probe-01234567-89ab-cdef-0123-456789abcdef';
const ready = { ready: true, bootstrapManifestValid: true, architecture: 'aarch64', applicationId: 'com.karat.aibuilder', filesDir: privateRoot, termuxPrefix: privateRoot + '/usr' };
function fixture(options = {}) {
  const calls = [];
  const result = options.result || { stdout: 'AIB_CANDIDATE_PROBE_OK\n', stderr: '', exitCode: 0, timedOut: false, outputTruncated: false };
  const bridge = {
    getTermuxNative: () => options.noNative ? undefined : options.noStage ? {} : { stageEmbeddedCandidateFeedProbe: async () => { calls.push('stage'); return options.root ?? stageRoot; } },
    prepareEmbeddedTermuxRuntime: async () => { calls.push('prepare'); if (options.prepareFailure) throw new Error('EMBEDDED_EXEC_RUNTIME_NOT_READY'); return true; },
    getEmbeddedTermuxRuntimeStatus: async () => { calls.push('status'); return { ...ready, ...options.status }; },
    runEmbeddedTermuxCommand: async (command, opts) => { calls.push({ command, opts }); if (options.execFailure) throw new Error('PRIVATE_CALL_FAILED secret-do-not-echo'); if (options.wait) await options.wait; return result; },
  };
  const module = { exports: {} };
  new Function('module', 'exports', 'require', generated)(module, module.exports, (name) => { assert.equal(name, './termux-bridge'); return bridge; });
  return { api: module.exports, calls };
}
const good = fixture();
let r = await good.api.runCandidateFeedProbe();
assert.equal(r.ok, true); assert.equal(r.installed, false); assert.equal(r.installationStatus, 'not_requested');
assert.deepEqual(good.calls.slice(0, 3), ['prepare', 'status', 'stage']);
assert.match(good.calls[3].command, /\/probe\.sh'/); assert.equal(good.calls[3].opts.timeoutMs, 120000);
const installResult = { stdout: 'AIB_CANDIDATE_MAKE_INSTALLED\n', stderr: '', exitCode: 0 };
const install = fixture({ result: installResult });
r = await install.api.installCandidateMake();
assert.equal(r.ok, true); assert.equal(r.installed, true); assert.equal(r.installationStatus, 'verified');
assert.match(install.calls[3].command, /\/install-make\.sh'/);
for (const outcome of [r, await good.api.runCandidateFeedProbe()]) { assert.equal(outcome.qualified, false); assert.equal(outcome.productionEnabled, false); }
for (const options of [
  { noNative: true }, { noStage: true }, { prepareFailure: true },
  { status: { ready: false } }, { status: { bootstrapManifestValid: false } },
  { status: { applicationId: 'com.termux' } }, { status: { architecture: 'x86_64' } },
  { status: { filesDir: '/data/user/10/com.karat.aibuilder/files' } },
  { status: { termuxPrefix: '/data/data/com.termux/files/usr' } },
  { root: stageRoot + '/../usr' }, { root: stageRoot + "'; touch /tmp/pwn; #" },
  { root: '/data/user/0/com.termux/files/candidate-probes/probe-01234567-89ab-cdef-0123-456789abcdef' },
]) {
  const f = fixture(options); const out = await f.api.installCandidateMake();
  assert.equal(out.ok, false); assert.equal(out.installed, false);
  assert.equal(f.calls.some((call) => typeof call === 'object'), false, JSON.stringify(options));
}
for (const result of [
  { ...installResult, exitCode: 1 }, { ...installResult, timedOut: true }, { ...installResult, outputTruncated: true },
  { ...installResult, stdout: '', stderr: installResult.stdout },
  { ...installResult, stdout: 'xAIB_CANDIDATE_MAKE_INSTALLED\n' },
  { ...installResult, stdout: 'AIB_CANDIDATE_MAKE_INSTALLED\nAIB_CANDIDATE_MAKE_INSTALLED\n' },
  { ...installResult, stdout: 'AIB_CANDIDATE_PROBE_OK\n' },
]) {
  const f = fixture({ result }); const out = await f.api.installCandidateMake();
  assert.equal(out.ok, false); assert.equal(out.installed, false); assert.equal(out.installationStatus, 'unconfirmed');
  assert.equal(out.qualified, false); assert.equal(out.productionEnabled, false);
}
const rejected = await fixture({ execFailure: true }).api.installCandidateMake();
assert.equal(rejected.ok, false); assert.equal(rejected.installationStatus, 'unconfirmed'); assert.doesNotMatch(rejected.log, /secret-do-not-echo/);
let release;
const slow = fixture({ wait: new Promise((resolve) => { release = resolve; }) });
const first = slow.api.runCandidateFeedProbe(); const second = slow.api.runCandidateFeedProbe();
assert.equal((await slow.api.installCandidateMake()).code, 'AIB_CANDIDATE_PROBE_BUSY');
release(); await Promise.all([first, second]);
assert.equal(slow.calls.filter((call) => call === 'stage').length, 1);
await slow.api.runCandidateFeedProbe(); assert.equal(slow.calls.filter((call) => call === 'stage').length, 2);

const helper = require(path.join(root, 'plugins/candidateFeedProbe.js'));
assert.throws(() => helper.candidateProbeKotlin('io.aibuilder.app'));
const kotlin = helper.candidateProbeKotlin('com.karat.aibuilder');
assert.match(kotlin, /context\.packageName == "com\.karat\.aibuilder"/);
assert.match(kotlin, /@JvmStatic @Synchronized fun stage/);
assert.match(kotlin, /Os\.lstat/); assert.doesNotMatch(kotlin, /java\.nio\.file/);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aib-v493-assets-'));
try {
  const output = helper.stageCandidateProbeAssets(root, path.join(temp, 'android-assets'));
  const paths = [];
  const walk = (dir, rel = '') => { for (const d of fs.readdirSync(dir, { withFileTypes: true })) d.isDirectory() ? walk(path.join(dir, d.name), rel + d.name + '/') : paths.push(rel + d.name); };
  walk(output); assert.equal(paths.length, 9);
  const assetPath = (rel) => rel.endsWith('.gz') ? rel + '.aibasset' : rel;
  assert.ok(paths.includes(assetPath('dists/stable/main/binary-aarch64/Packages.gz')));
  assert.ok(!paths.includes('dists/stable/main/binary-aarch64/Packages.gz'));
  const inventory = JSON.parse(read('docs/candidate-feed-probe/aggregate-archive-inventory.json')).files;
  for (const rel of paths) {
    const staged = fs.readFileSync(path.join(output, rel));
    const logical = rel.endsWith('.aibasset') ? rel.slice(0, -9) : rel;
    assert.equal(hash(staged), hash(fs.readFileSync(path.join(root, 'assets/termux-candidate-probe', logical))));
    if (!logical.endsWith('.sh')) assert.equal(hash(staged), inventory['aggregate/candidate-feed/' + logical].sha256);
  }
  const project = path.join(temp, 'fixture-project'); fs.mkdirSync(path.join(project, 'assets'), { recursive: true });
  fs.cpSync(path.join(root, 'assets/termux-candidate-probe'), path.join(project, 'assets/termux-candidate-probe'), { recursive: true });
  const body = path.join(project, 'assets/termux-candidate-probe/probe.sh'); fs.appendFileSync(body, '\n');
  assert.throws(() => helper.stageCandidateProbeAssets(project, path.join(temp, 'denied-corrupt')), /size|SHA/);
  fs.copyFileSync(path.join(root, 'assets/termux-candidate-probe/probe.sh'), body);
  fs.writeFileSync(path.join(project, 'assets/termux-candidate-probe/extra.deb'), 'bad');
  assert.throws(() => helper.stageCandidateProbeAssets(project, path.join(temp, 'denied-extra')), /Unlisted/);
  fs.unlinkSync(path.join(project, 'assets/termux-candidate-probe/extra.deb'));
  fs.unlinkSync(body); fs.symlinkSync(path.join(root, 'assets/termux-candidate-probe/probe.sh'), body);
  assert.throws(() => helper.stageCandidateProbeAssets(project, path.join(temp, 'denied-link')), /symlink/);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }

const ui = read('components/PackagesRightMenu.tsx');
assert.match(ui, /FullCandidatePackagesPanel/); assert.doesNotMatch(ui, /installCandidateMake/);
assert.match(read("components/FullCandidatePackagesPanel.tsx"), /CANDIDATE_BOOTSTRAP_COMPATIBLE/);
assert.match(read("components/FullCandidatePackagesPanel.tsx"), /busyRef\.current/);
assert.match(read('lib/private-package-install-policy.ts'), /allowed: false as const/);
assert.doesNotMatch(read('lib/github-tools.ts'), /pkg install -y zip/);
assert.match(read('lib/github-tools.ts'), /GITHUB_PACK_PRIVATE_PYTHON_MISSING/);
assert.match(read('lib/custom-packages.ts'), /CUSTOM_CHECK_COMMAND_REQUIRED/);
assert.match(read('components/AddToolDialog.tsx'), /L\.needCheck/);
console.log('AIB_V493_CANDIDATE_API_SELFTEST_OK private-only=PASS forged-success-denied=PASS singleflight=PASS exact9assets=PASS pin-corruption-extra-symlink-denied=PASS legacy-make-API-mock=PASS(not-menu) production-disabled=PASS mocked-native Android=NOT_RUN');
