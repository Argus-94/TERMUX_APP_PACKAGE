#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
const root = path.resolve(new URL('..', import.meta.url).pathname);
const require = createRequire(import.meta.url);
for (const [program, args] of [
  [process.execPath, ['scripts/aib-v493-full-candidate-api-selftest.mjs']],
  [process.execPath, ['scripts/aib-v493-full-candidate-ui-selftest.mjs']],
  ['python3', ['scripts/aib-v493-coherent-provenance-selftest.py']],
  ['python3', ['scripts/aib-v493-full-candidate-shell-selftest.py']],
]) {
  const run = spawnSync(program, args, { cwd: root, encoding: 'utf8' });
  process.stdout.write(run.stdout ?? ''); process.stderr.write(run.stderr ?? '');
  assert.equal(run.status, 0, `${program} ${args.join(' ')} failed`);
}
const helper = require(path.join(root, 'plugins/candidateFullFeed.js'));
const source = helper.candidateFullKotlin('com.karat.aibuilder', root);
assert.ok(source.includes('AibCandidateFullFeed') && source.includes('arm64-v8a'));
const temp = fs.mkdtempSync(path.join(fs.existsSync('/dev/shm') ? '/dev/shm' : os.tmpdir(), 'aib-v493-asset-proof-'));
try {
  const staged = helper.stageFullCandidateAssets(root, temp);
  const files = [];
  function walk(dir) { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) entry.isDirectory() ? walk(path.join(dir, entry.name)) : files.push(path.join(dir, entry.name)); }
  walk(staged);
  assert.equal(files.length, 92);
  assert.equal(files.filter(file => file.endsWith('.deb')).length, 82);
  assert.equal(helper.stageFullCandidateAssets(root, temp), staged, 'second prebuild must validate without rewriting');
  fs.writeFileSync(path.join(staged, 'unlisted.deb'), 'not a trusted artifact');
  assert.throws(() => helper.stageFullCandidateAssets(root, temp), /extra_file/);
  fs.unlinkSync(path.join(staged, 'unlisted.deb'));
  assert.equal(helper.stageFullCandidateAssets(root, temp), staged);
  console.log('FULL_CANDIDATE_SOURCE_GATES_OK exact82+metadata+localinputs=92 APK-asset-stage=PASS idempotent=PASS unlisted-denied=PASS bootstrap-dependency-plan=PASS production=false Android=NOT_RUN');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
