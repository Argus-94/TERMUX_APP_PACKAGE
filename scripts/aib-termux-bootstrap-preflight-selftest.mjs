#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const root = path.resolve(new URL('..', import.meta.url).pathname);
const script = path.join(root, 'scripts/aib-termux-bootstrap-preflight.mjs');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aib-bootstrap-preflight-'));
try {
  const repo = path.join(temp, 'repo'); fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true }); fs.mkdirSync(path.join(repo, '.git'));
  fs.writeFileSync(path.join(repo, 'scripts/properties.sh'), 'TERMUX_APP__PACKAGE_NAME="com.karat.aibuilder"\nTERMUX_APP_PACKAGE="$TERMUX_APP__PACKAGE_NAME" # Deprecated alias\n');
  for (const f of ['scripts/build-bootstraps.sh', 'scripts/run-docker.sh', 'clean.sh']) fs.writeFileSync(path.join(repo, f), '# fixture\n');
  const git = (args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  assert.equal(git(['init', '-q']).status, 0); assert.equal(git(['-c','user.name=Test','-c','user.email=test@example.invalid','commit','--allow-empty','-qm','fixture']).status, 0);
  const ok = spawnSync(process.execPath, [script, repo, 'com.karat.aibuilder', 'aarch64'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, `${ok.stdout}\n${ok.stderr}`); assert.match(ok.stdout, /"ok": true/);
  const wrongId = spawnSync(process.execPath, [script, repo, 'com.termux', 'aarch64'], { encoding: 'utf8' }); assert.notEqual(wrongId.status, 0);
  fs.writeFileSync(path.join(repo, 'scripts/properties.sh'), 'TERMUX_APP__PACKAGE_NAME="com.karat.aibuilder"\nTERMUX_APP_PACKAGE="com.termux"\n');
  const mismatch = spawnSync(process.execPath, [script, repo], { encoding: 'utf8' }); assert.notEqual(mismatch.status, 0);
  console.log('PASS: bootstrap preflight validates upstream checkout, build scripts, package namespace, alias, and ABI');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
