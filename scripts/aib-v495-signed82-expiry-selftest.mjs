import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const privatePaths = createRequire(import.meta.url)('../lib/private-runtime-path.js');
import { typescript as ts } from './test-helpers/load-typescript.mjs';
const read = rel => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const source = read('lib/candidate-full-feed.ts');
const compile = text => ts.transpileModule(text, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
} }).outputText;
const generated = {};
vm.runInNewContext(compile(read('lib/candidate-full-packages.generated.ts')), { exports: generated });
assert.equal(generated.CANDIDATE_RELEASE_VALID_UNTIL, '2026-11-18T18:06:33+00:00');
assert.equal(generated.CANDIDATE_PACKAGES.length, 82);
const expiry = Date.parse(generated.CANDIDATE_RELEASE_VALID_UNTIL);
const removable = generated.CANDIDATE_PACKAGES.find(p => !generated.CANDIDATE_PROTECTED_PACKAGES.includes(p.name)).name;
const fullCohort = generated.CANDIDATE_PACKAGES.map(p => p.name);
function load(now, declaredExpiry = generated.CANDIDATE_RELEASE_VALID_UNTIL) {
  const counts = { nativeLookup: 0, prepare: 0, status: 0, dispatch: 0 };
  const bridge = {
    getTermuxNative() { counts.nativeLookup++; return { runEmbeddedCandidateFullTransaction() {} }; },
    async prepareEmbeddedTermuxRuntime() { counts.prepare++; },
    async getEmbeddedTermuxRuntimeStatus() { counts.status++; return null; },
    async runEmbeddedFullCandidateTransaction() { counts.dispatch++; throw new Error('unexpected dispatch'); },
  };
  const exports = {};
  vm.runInNewContext(compile(source), {
    exports,
    require(id) {
      if (id === './termux-bridge') return bridge;
      if (id === './private-runtime-path.js') return privatePaths;
      if (id === './candidate-full-packages.generated') return { ...generated, CANDIDATE_RELEASE_VALID_UNTIL: declaredExpiry };
      throw new Error(`unexpected import: ${id}`);
    },
    Date: { parse: Date.parse, now: () => now },
  });
  return { api: exports, counts };
}
let cases = 0;
for (const declaredExpiry of [generated.CANDIDATE_RELEASE_VALID_UNTIL, 'invalid-expiry']) {
  const { api, counts } = load(expiry + 1, declaredExpiry);
  for (const action of ['verify', 'check', 'install', 'reinstall', 'remove']) {
    const selected = ['verify', 'check'].includes(action) ? [] : ['install', 'reinstall'].includes(action) ? fullCohort : [removable];
    const result = await api.runFullCandidateAction(action, selected, { sessionEnabled: true });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'AIB_FULL_CANDIDATE_RELEASE_EXPIRED');
    assert.equal(result.mutationStatus, ['verify', 'check'].includes(action) ? 'not_requested' : 'not_dispatched');
    assert.equal(result.qualified, false);
    assert.equal(result.productionEnabled, false);
    assert.deepEqual(counts, { nativeLookup: 0, prepare: 0, status: 0, dispatch: 0 });
    cases++;
  }
}
const { api, counts } = load(expiry - 1);
const result = await api.runFullCandidateAction('verify', [], { sessionEnabled: true });
assert.equal(result.code, 'AIB_FULL_CANDIDATE_PRIVATE_RUNTIME_REQUIRED');
assert.deepEqual(counts, { nativeLookup: 1, prepare: 1, status: 1, dispatch: 0 });
assert.equal(api.CANDIDATE_RELEASE_VALID_UNTIL, generated.CANDIDATE_RELEASE_VALID_UNTIL);
console.log(`AIB_V495_SIGNED82_EXPIRY_SELFTEST_OK cases=${cases + 1} actual-API expiry/invalid=zero-native-I/O pre-expiry=normal-readiness test-only=true NO_DEVICE_PROOF`);
