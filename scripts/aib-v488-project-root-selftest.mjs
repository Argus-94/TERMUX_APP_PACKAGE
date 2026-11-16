#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { parseProjectSourceProofOutput, buildProjectSourcePreflightCommand, buildProjectSourceMarkerRecoveryCommand } from '../lib/project-source-import.ts';
const shared = '/storage/emulated/0/AIBuilderTermux';
const projects = `${shared}/projects`;
const id = 'v488-exact-root';
const encode = s => Buffer.from(s, 'utf8').toString('base64');
const proof = root => `PROJECT_SOURCE_PROOF_V1=${id}.${encode('gradle')}.${encode(`${projects}/demo`)}.${encode(root)}`;
const complete = proof(projects);
assert.ok(parseProjectSourceProofOutput(complete, id));
for (const root of [shared, '/storage/emulated/0', '/foreign', `${shared}/elsewhere`]) assert.equal(parseProjectSourceProofOutput(proof(root), id), null);
for (let n = 1; n < complete.length; n++) assert.equal(parseProjectSourceProofOutput(complete.slice(0, n), id), null, `truncated callback accepted: ${n}`);
let commands = 0;
for (const make of [buildProjectSourcePreflightCommand, buildProjectSourceMarkerRecoveryCommand]) {
  const script = make(`${shared}/incoming/demo.zip`, { proofId: id });
  assert.ok(!script.includes('${AIB_SHARED_ROOT'), 'ambient root must not override the app project root');
  const boundary = Math.min(...['mkdir -p', 'ROOT_CANON='].map(marker => script.indexOf(marker)).filter(index => index > 0));
  assert.ok(boundary > 0);
  const preamble = script.slice(0, boundary) + '\nprintf "%s\\n" "$AIB_ROOT"';
  const r = spawnSync('/bin/bash', ['-c', preamble], { encoding: 'utf8', env: { AIB_SHARED_ROOT: '/foreign', HOME: '/fixture-home' }, timeout: 3000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), shared);
  commands++;
}
console.log(`AIB_V488_PROJECT_ROOT_SELFTEST_OK canonical_default=true hostile_roots_rejected=4 truncated_callbacks_rejected=${complete.length-1} actual_shell_preambles=${commands} no_IO=true Android=NOT_RUN`);
