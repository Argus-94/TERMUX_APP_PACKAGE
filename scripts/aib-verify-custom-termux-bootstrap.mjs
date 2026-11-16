#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const fail = (message) => { console.error(`ERROR: ${message}`); process.exit(2); };
const [archiveArg, expectedArchArg] = process.argv.slice(2);
if (!archiveArg) fail('Usage: node scripts/aib-verify-custom-termux-bootstrap.mjs /path/to/termux-bootstrap-ARCH.zip [ARCH]');
const archive = path.resolve(archiveArg);
const expectedArch = expectedArchArg || process.env.AIB_TERMUX_ARCH || '';
const provenancePath = `${archive}.provenance.json`;
const checksumPath = `${archive}.sha256`;
for (const file of [archive, provenancePath, checksumPath]) if (!fs.existsSync(file)) fail(`Required artifact missing: ${file}`);
const run = (cmd, args) => {
  const result = spawnSync(cmd, args, { encoding: 'utf8' });
  if (result.error) fail(`${cmd} could not run: ${result.error.message}`);
  if (result.status !== 0) fail(`${cmd} failed: ${(result.stderr || result.stdout || '').trim()}`);
  return result.stdout;
};
run('unzip', ['-t', archive]);
const entries = run('unzip', ['-Z1', archive]).split(/\r?\n/).filter(Boolean);
const normalizedEntries = entries.map((entry) => entry.replace(/^(?:\.\/)+/, ''));
if (!normalizedEntries.includes('bin/bash')) fail('Archive has no prefix-root bin/bash entrypoint');
if (entries.some((entry) => entry.startsWith('/') || entry.includes('\\') || entry.split('/').includes('..') || /^[A-Za-z]:/.test(entry))) fail('Archive contains an unsafe absolute, backslash, or parent-traversal path');
const entryNames = new Set();
for (const entry of entries) {
  if (entryNames.has(entry)) fail(`Archive contains duplicate entry: ${entry}`);
  entryNames.add(entry);
}
// Runtime text under these paths must not retain another app's private data directory.
// This catches upstream configure defaults such as /data/data/com.termux in executables.
const runtimeEntries = normalizedEntries.filter((entry) =>
  !entry.endsWith('/') && (
    /^bin\/[^/]+$/.test(entry)
    || /^etc\//.test(entry)
    || /^var\/lib\/dpkg\/info\/[^/]+\.(?:preinst|postinst|prerm|postrm)$/.test(entry)
    || /^(?:libexec|share)\/.*\.(?:sh|py|pl)$/i.test(entry)
  ),
);
const privateAppPath = /\/data\/(?:data|user\/0|user_de\/0)\/(com\.[A-Za-z0-9_.-]+)(?=\/|[\s"'`]|$)/g;
for (const entry of runtimeEntries) {
  const result = spawnSync('unzip', ['-p', archive, entry], { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 });
  if (result.error) fail(`unzip could not read runtime entry ${entry}: ${result.error.message}`);
  if (result.status !== 0) fail(`unzip failed to read runtime entry ${entry}: ${(result.stderr || '').toString().trim()}`);
  let payload = result.stdout || Buffer.alloc(0);
  if (!payload.includes(0)) {
    payload = Buffer.from(payload.toString('latin1').split(/\r?\n/).filter((line) => !line.trimStart().startsWith('#')).join('\n'), 'latin1');
  }
  privateAppPath.lastIndex = 0;
  for (const match of payload.toString('latin1').matchAll(privateAppPath)) {
    if (match[1] !== 'com.karat.aibuilder') fail(`Runtime entry ${entry} contains a foreign Android app path for ${match[1]}`);
  }
}
const digestOutput = run('sha256sum', [archive]);
const digest = digestOutput.trim().split(/\s+/)[0];
const checksum = fs.readFileSync(checksumPath, 'utf8').trim().split(/\s+/)[0];
if (!/^[a-f0-9]{64}$/.test(checksum) || digest !== checksum) fail('SHA-256 sidecar does not match archive bytes');
let manifest;
try { manifest = JSON.parse(fs.readFileSync(provenancePath, 'utf8')); } catch { fail('Provenance sidecar is not valid JSON'); }
if (manifest.schemaVersion !== 1) fail('Unsupported provenance schemaVersion');
if (manifest.applicationId !== 'com.karat.aibuilder') fail('Provenance applicationId must be com.karat.aibuilder');
if (!['aarch64', 'arm', 'i686', 'x86_64'].includes(manifest.architecture)) fail('Provenance architecture is missing or unsupported');
if (expectedArch && manifest.architecture !== expectedArch) fail(`Architecture mismatch: expected ${expectedArch}, got ${manifest.architecture}`);
if (typeof manifest.sourceRepository !== 'string' || !manifest.sourceRepository.startsWith('/')) fail('Provenance sourceRepository must be an absolute checkout path');
if (typeof manifest.sourceBranch !== 'string') fail('Provenance sourceBranch is missing');
if (typeof manifest.sourceCommit !== 'string' || !/^[a-f0-9]{7,40}$/i.test(manifest.sourceCommit)) fail('Provenance sourceCommit is missing or malformed');
if (typeof manifest.builtAtUtc !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(manifest.builtAtUtc) || Number.isNaN(Date.parse(manifest.builtAtUtc))) fail('Provenance builtAtUtc is missing or malformed');
if (manifest.archiveFile !== path.basename(archive)) fail('Provenance archiveFile does not match selected archive');
if (manifest.archiveSha256 !== digest) fail('Provenance archiveSha256 does not match archive bytes');
if (manifest.archiveStructureVerified !== true) fail('Provenance does not assert archive structure verification');
if (manifest.runtimeVerified !== false || manifest.apkIntegrated !== false) fail('Build provenance must not claim runtime/APK verification');
console.log(`PASS: ${archive}`);
console.log(`  applicationId=${manifest.applicationId}`);
console.log(`  architecture=${manifest.architecture}`);
console.log(`  sha256=${digest}`);
console.log('  runtimeVerified=false; apkIntegrated=false');
