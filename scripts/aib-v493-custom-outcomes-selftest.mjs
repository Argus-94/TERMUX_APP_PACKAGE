#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { typescript as ts } from './test-helpers/load-typescript.mjs';
const root = path.resolve(new URL('..', import.meta.url).pathname);
const source = fs.readFileSync(path.join(root, 'lib/custom-packages.ts'), 'utf8');
const fragment = source.slice(source.indexOf('const PACKAGE_PATTERNS'), source.indexOf('export async function loadCustomTools'));
const module = { exports: {} };
new Function('module', 'exports', ts.transpileModule(fragment + '\nmodule.exports={buildCommandsFromKind};', { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText)(module, module.exports);
const { buildCommandsFromKind } = module.exports;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aib-v493-custom-'));
try {
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  const log = path.join(dir, 'calls.log');
  const write = (name, body) => fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nprintf "%s\\n" "' + name + ' $*" >> "$CALL_LOG"\n' + body + '\n', { mode: 0o700 });
  write('apt-get', 'exit 42');
  write('dpkg-query', 'printf "%s" "${MOCK_STATUS:-installed}"; exit 0');
  write('python3', 'case "$3" in --version) exit 0;; install) exit 43;; show) exit 0;; uninstall) exit 44;; esac; exit 99');
  write('npm', 'case "$1" in --version) exit 0;; install) exit 45;; ls) exit 0;; uninstall) exit 46;; esac; exit 99');
  const run = (command, extra = {}) => spawnSync('/bin/bash', ['-c', command], { env: { ...process.env, PATH: bin + ':/usr/bin:/bin', CALL_LOG: log, ...extra }, encoding: 'utf8' });
  for (const [kind, names, removeExit] of [['pkg', 'aib-definitely-not-a-binary', 42], ['pip', 'requests>=2.31', 44], ['npm', '@scope/old-tool@2', 46]]) {
    const generated = buildCommandsFromKind(kind, names);
    const install = run(generated.installCmd);
    assert.equal(install.status, 1, `${kind}: an existing old distribution must not hide install failure`);
    assert.doesNotMatch(install.stdout, /CUSTOM_(?:PKG|PIP|NPM)_OK/);
    assert.equal(run(generated.removeCmd).status, removeExit, `${kind}: removal status must not be swallowed`);
    if (kind !== 'pkg') assert.doesNotMatch(generated.installCmd, /apt-get|--upgrade pip/, 'no hidden prerequisite installation/upgrade');
    const syntax = spawnSync('bash', ['-n'], { input: generated.installCmd + '\n' + generated.removeCmd, encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
  }
  const pkg = buildCommandsFromKind('pkg', 'aib-definitely-not-a-binary');
  assert.equal(run(pkg.checkCmd, { MOCK_STATUS: 'config-files' }).status, 1, 'residual dpkg metadata is not an installed package');
  assert.equal(run(pkg.checkCmd, { MOCK_STATUS: 'installed' }).status, 0);
  for (const check of ['', undefined, 'true', ':', ' true ']) {
    const custom = buildCommandsFromKind('custom', '', 'echo install', check);
    assert.equal(run(custom.checkCmd).status, 78, 'missing/no-op check cannot mark a custom tool installed');
    assert.match(custom.checkCmd, /CUSTOM_CHECK_NOT_CONFIGURED/);
  }
  assert.equal(buildCommandsFromKind('custom', '', 'echo install', 'test -f marker').checkCmd, 'test -f marker');
  assert.match(buildCommandsFromKind('pip', 'requests>=2.31').removeCmd, /uninstall -y 'requests'/);
  assert.match(buildCommandsFromKind('npm', '@scope/old-tool@2').removeCmd, /uninstall -g '@scope\/old-tool'/);
  assert.doesNotMatch(fs.readFileSync(log, 'utf8'), /--upgrade pip|apt-get install -y (python|nodejs)/);
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
let executions = 0;
const full = { exports: {} };
const dependencies = {
  './package-backend': { runPackageCommand: async () => { executions++; return { exitCode: 0 }; } },
  './agent-shell-backend': { getBuildBackend: () => 'termux' },
  './private-package-install-policy': { getPrivatePackageMutationAvailability: () => ({ allowed: false }) },
  './package-check-outcome': { checkPackageCommand: async (fn) => { await fn(); return { status: 'installed' }; } },
};
new Function('module', 'exports', 'require', ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText)(full, full.exports, (name) => dependencies[name] || {});
const raw = { id: 'custom-raw-check', installKind: 'custom', checkCmd: 'pkg install -y zip' };
assert.deepEqual(await full.exports.checkCustomToolInstalled(raw, true, 'termux'), { status: 'error', detail: 'CUSTOM_RAW_CHECK_BLOCKED_UNQUALIFIED_FEED' });
assert.equal(executions, 0, 'an install/download command labeled check must not bypass ordinary package qualification');
assert.equal((await full.exports.checkCustomToolInstalled({ ...raw, checkCmd: 'true' }, true, 'termux')).detail, 'CUSTOM_CHECK_COMMAND_REQUIRED');
assert.equal((await full.exports.checkCustomToolInstalled(raw, false, 'termux')).detail, 'CUSTOM_COMMAND_REQUIRES_USER_REVIEW');
console.log('AIB_V493_CUSTOM_OUTCOMES_SELFTEST_OK failed-install-not-old-success=PASS remove-errors-preserved=PASS no-hidden-prerequisites=PASS real-check-required=PASS residual-status-not-installed=PASS raw-check-install-bypass-blocked=PASS hermetic-stubs-only');
