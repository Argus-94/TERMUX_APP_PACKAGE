#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
let ts;
try { ts = require('typescript'); } catch {
  const tsc = fs.realpathSync(execFileSync('sh', ['-c', 'command -v tsc'], { encoding: 'utf8' }).trim());
  ts = require(path.resolve(path.dirname(tsc), '../lib/typescript.js'));
}
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const files = ['app/runtime.tsx', 'app/terminal.tsx', 'app/_layout.tsx', 'app/settings.tsx', 'app/log-screen.tsx', 'app/permissions-onboarding.tsx', 'app/termux-settings.tsx', 'components/TermuxContext.tsx', 'components/AddToolDialog.tsx', 'components/PackagesRightMenu.tsx'];
const parsed = new Map();
for (const name of files) {
  const sf = ts.createSourceFile(name, read(name), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  assert.equal(sf.parseDiagnostics.length, 0, `${name}: JSX/TS syntax must be valid`);
  parsed.set(name, sf);
}
const runtime = read('app/runtime.tsx');
assert.match(runtime, /const privateBuildQualificationConfirmed = false;/);
function declaration(sf, name) {
  let found;
  function walk(n) { if (ts.isVariableDeclaration(n) && n.name.getText(sf) === name) found = n; ts.forEachChild(n, walk); }
  walk(sf); assert.ok(found, `missing ${name}`); return found;
}
const sf = parsed.get('app/runtime.tsx');
const printer = ts.createPrinter();
let actualCallbacks = 0;
for (const [name, setter] of [['onWorkspaceBuild', 'setWorkspaceBuildOutput'], ['onProjectGenerate', 'setProjectGenerateOutput'], ['onCodingAgent', 'setCodingAgentOutput']]) {
  const d = declaration(sf, name);
  assert.ok(ts.isCallExpression(d.initializer));
  const callback = d.initializer.arguments[0];
  assert.ok(ts.isArrowFunction(callback));
  const expression = printer.printNode(ts.EmitHint.Expression, callback, sf);
  const js = ts.transpileModule(`const candidate = ${expression};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  for (const language of ['ru', 'uk', 'en']) {
    const messages = [];
    let facadeCalls = 0;
    const fn = new Function('privateBuildQualificationConfirmed', 'language', setter, 'getRuntimeFacade', js + '\nreturn candidate;')(
      false, language, value => messages.push(value), () => { facadeCalls++; throw new Error('QUALIFICATION_BYPASS'); },
    );
    await fn();
    assert.equal(facadeCalls, 0, name);
    assert.equal(messages.length, 1, name);
    assert.match(messages[0], /feed/);
    actualCallbacks++;
  }
  assert.ok(runtime.includes(`onPress={() => void ${name}()} disabled={!containerId || `), 'visible control must also be disabled');
}
const menu = read('components/PackagesRightMenu.tsx');
assert.ok(!menu.includes('copyInstallCommand'));
assert.ok(!menu.includes('buildManualTermuxInstallCommand'));
assert.ok(!read('app/_layout.tsx').includes('openRunCommandPermissionSettings'));
for (const name of files) assert.ok(!/com\.termux\.app\.|com\.termux\.permission\.RUN_COMMAND|market:\/\/details\?id=com\.termux/.test(read(name)), name);
const terminalSf = parsed.get('app/terminal.tsx');
const probe = declaration(terminalSf, 'probe').initializer;
assert.ok(ts.isNoSubstitutionTemplateLiteral(probe));
const namespaceCheck = probe.text.slice(0, probe.text.indexOf("printf 'AIB_PRIVATE_EXEC_OK"));
assert.ok(namespaceCheck.includes('case "$PREFIX:$HOME"'));
let shellCases = 0;
for (const [prefix, home, exit] of [
  ['/data/data/com.karat.aibuilder/files/usr', '/data/data/com.karat.aibuilder/files/home', 0],
  ['/data/user/0/com.karat.aibuilder/files/usr', '/data/user/0/com.karat.aibuilder/files/home', 0],
  ['/foreign/com.karat.aibuilder/usr', '/foreign/home', 42],
  ['/data/data/com.karat.aibuilder/files/usr', '/foreign/home', 42],
]) {
  const r = spawnSync('/bin/bash', ['-c', namespaceCheck], { env: { PREFIX: prefix, HOME: home }, encoding: 'utf8', timeout: 3000 });
  assert.equal(r.status, exit, r.stderr || r.stdout); shellCases++;
}
console.log(`AIB_V488_UI_SELFTEST_OK parsed_files=${files.length} executed_callback_cases=${actualCallbacks} namespace_shell_cases=${shellCases} external_setup=absent Android=NOT_RUN`);
