#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const root = path.resolve(new URL('..', import.meta.url).pathname);
const script = path.join(root, 'scripts/aib-configure-termux-namespace.sh');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aib-termux-namespace-'));
try {
  const good = path.join(dir, 'properties.sh');
  fs.writeFileSync(good, 'TERMUX_APP__PACKAGE_NAME="com.termux"\nTERMUX_APP_PACKAGE="$TERMUX_APP__PACKAGE_NAME" # Deprecated alternative variable\n');
  const result = spawnSync('bash', [script, good], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const configured = fs.readFileSync(good, 'utf8');
  assert.match(configured, /^TERMUX_APP__PACKAGE_NAME="com\.karat\.aibuilder"$/m);
  assert.match(configured, /^TERMUX_APP_PACKAGE="\$TERMUX_APP__PACKAGE_NAME" # Deprecated alias$/m);

  const duplicate = path.join(dir, 'duplicate.sh');
  fs.writeFileSync(duplicate, 'TERMUX_APP__PACKAGE_NAME="com.termux"\nTERMUX_APP__PACKAGE_NAME="com.other"\nTERMUX_APP_PACKAGE="com.termux"\n');
  const rejected = spawnSync('bash', [script, duplicate], { encoding: 'utf8' });
  assert.notEqual(rejected.status, 0, 'duplicate package variable was accepted');
  console.log('PASS: namespace configurator updates current variable and alias; rejects ambiguous properties');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
