import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const archive = path.join(root, 'assets/termux-bootstrap/termux-bootstrap-aarch64.zip');
const provenancePath = `${archive}.provenance.json`;
const checksumPath = `${archive}.sha256`;
for (const file of [archive, provenancePath, checksumPath]) {
  assert.ok(fs.existsSync(file), `required embedded bootstrap asset is missing: ${path.relative(root, file)}`);
}
const manifest = JSON.parse(fs.readFileSync(provenancePath, 'utf8'));
const digest = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
const checksum = fs.readFileSync(checksumPath, 'utf8').trim().split(/\s+/)[0].toLowerCase();
assert.equal(checksum, digest, 'bootstrap SHA-256 sidecar differs from archive bytes');
assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.applicationId, 'com.karat.aibuilder');
assert.equal(manifest.architecture, 'aarch64');
assert.equal(manifest.archiveFile, path.basename(archive));
assert.equal(manifest.archiveSha256, digest);
assert.equal(manifest.archiveStructureVerified, true);
assert.equal(manifest.runtimeVerified, false, 'build provenance must not claim device runtime verification');
assert.equal(manifest.apkIntegrated, false, 'build provenance must not claim APK/runtime verification');
assert.match(manifest.sourceCommit || '', /^[a-f0-9]{40}$/i);
assert.match(manifest.bootstrapVersion || '', /^[A-Za-z0-9._-]{1,80}$/);
assert.ok(typeof manifest.sourceRepository === 'string' && manifest.sourceRepository.startsWith('/'), 'sourceRepository must record the build checkout path');

const run = (cmd, args) => {
  const result = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, `${cmd} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
};
run('node', [path.join(root, 'scripts/aib-verify-custom-termux-bootstrap.mjs'), archive, 'aarch64']);
const entries = run('unzip', ['-Z1', archive]).split(/\r?\n/).filter(Boolean)
  .map((name) => name.replace(/^(?:\.\/)+/, '').replace(/\/$/, ''));
const entrySet = new Set(entries);
for (const required of [
  'bin/bash',
  'SYMLINKS.txt',
  'etc/termux/termux-bootstrap/second-stage/termux-bootstrap-second-stage.sh',
]) {
  assert.ok(entrySet.has(required), `bootstrap archive is missing required member ${required}`);
}
console.log(`PASS: app-specific ARM64 bootstrap archive verified; sha256=${digest}; sourceCommit=${manifest.sourceCommit}; runtimeVerified=false`);
