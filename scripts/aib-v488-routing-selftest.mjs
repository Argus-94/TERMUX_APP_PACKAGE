#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { typescript as ts } from './test-helpers/load-typescript.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const ensure = read('lib/agent-tools/pkg-ensure.ts');
const provider = read('lib/private-runtime-provider.ts');
const workflow = read('lib/termux-package-workflow-inputs.ts');
const packageBackend = read('lib/package-backend.ts');

assert.match(ensure, /privateRuntimeProvider\.execute\(built\.command/);
assert.doesNotMatch(ensure, /runInActiveEnv|hostTermux\s*:/);
assert.match(ensure, /backend === "ubuntu-proot"[\s\S]*?PKG_PROFILE_GUEST_INSTALL_UNAVAILABLE/);
assert.match(provider, /target === "selected-backend"\) throw new Error\("AGENT_SHELL_EXTERNAL_TARGET_DISABLED"\)/);
assert.match(provider, /backend, hostTermux, executionTarget and other legacy-only controls are stripped/);
assert.match(provider, /return privateProvider\.execute\(command, privateOptions\)/);
assert.match(workflow, /runtime\.bootstrapManifestValid !== true/);
assert.match(workflow, /EXPECTED_APPLICATION_ID = "com\.karat\.aibuilder"/);
assert.match(workflow, /runtime\.architecture !== "aarch64"/);
assert.doesNotMatch(packageBackend, /com\.termux\.permission\.RUN_COMMAND|startService\(/);

console.log('v488 embedded-only package routing checks passed');

// Execute the real TypeScript tool body with mocked dependencies: this verifies
// routing behavior, not merely the presence of expected source strings.
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const source = read('lib/agent-tools/pkg-ensure.ts');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
async function runMocked(backend, args) {
  const calls = [];
  const exports = {};
  const mockedRequire = (id) => {
    if (id === '../private-runtime-provider') return { privateRuntimeProvider: { execute: async (...a) => { calls.push(['private', ...a]); return { exitCode: 0, stdout: 'ok', stderr: '' }; } } };
    if (id === '../agent-shell-backend') return { getBuildBackend: () => backend };
    if (id === './pkg-bootstrap') return {
      listPkgProfiles: () => [{ id: 'base' }],
      buildPkgEnsureCommand: (p, b) => ({ ok: true, command: `ensure:${p}:${b}`, packages: [p] }),
      buildMultiProfileEnsureCommand: (p, b) => ({ ok: true, command: `multi:${p.join(',')}:${b}`, packages: p }),
    };
    if (id === './common') return { isNonEmptyString: (x) => typeof x === 'string' && x.trim().length > 0 };
    return {};
  };
  vm.runInNewContext(js, { exports, require: mockedRequire, module: { exports }, Promise, Math, Number, String, Array });
  const result = await exports.execute(args);
  return { result, calls };
}
const termux = await runMocked('termux', { profile: 'base', timeoutMs: 90000 });
assert.equal(termux.calls.length, 1);
assert.equal(termux.calls[0][0], 'private');
assert.equal(termux.calls[0][1], 'ensure:base:termux');
assert.equal(termux.calls[0][2].timeoutMs, 90000);
const multi = await runMocked('termux', { profiles: ['base', 'node'] });
assert.equal(multi.calls[0][1], 'multi:base,node:termux');
const guest = await runMocked('ubuntu-proot', { profile: 'base' });
assert.equal(guest.result.error, 'PKG_PROFILE_GUEST_INSTALL_UNAVAILABLE');
assert.equal(guest.calls.length, 0, 'guest profile install must fail closed before any execution');
console.log('v488 mocked pkg.ensure runtime routing passed');
