#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const root = path.resolve(new URL('..', import.meta.url).pathname);
const require = createRequire(import.meta.url);
const paths = require(path.join(root, 'plugins/candidateAssetPaths.js'));
const probe = require(path.join(root, 'plugins/candidateFeedProbe.js'));
const full = require(path.join(root, 'plugins/candidateFullFeed.js'));
const map = paths.candidateAssetPath;
assert.equal(map('dists/stable/Packages.gz'), 'dists/stable/Packages.gz.aibasset');
assert.equal(map('dists/stable/Packages'), 'dists/stable/Packages');
assert.equal(map('pool/main/tool.deb'), 'pool/main/tool.deb');
assert.doesNotThrow(() => paths.assertUniqueCandidateAssetPaths(['Packages', 'Packages.gz']));
assert.doesNotThrow(() => paths.assertUniqueCandidateAssetPaths(['Packages', 'Packages.gz.aibasset']));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aib-v494-assets-'));
const hash = bytes => require('node:crypto').createHash('sha256').update(bytes).digest('hex');
function filesUnder(dir) {
  const result = new Map();
  const walk = (at, rel = '') => {
    for (const e of fs.readdirSync(at, { withFileTypes: true })) {
      const key = rel + e.name, target = path.join(at, e.name);
      if (e.isSymbolicLink()) throw new Error('unexpected symlink in fixture: ' + key);
      if (e.isDirectory()) walk(target, key + '/'); else result.set(key, fs.readFileSync(target));
    }
  };
  walk(dir); return result;
}
function checkMapping(staged, source, label, excluded = []) {
  const actual = filesUnder(staged), originals = filesUnder(source);
  for (const rel of excluded) assert.ok(originals.has(rel) && !actual.has(map(rel)), `${label}: expected non-APK metadata ${rel}`);
  assert.equal(actual.size, originals.size - excluded.length, `${label}: all APK files represented`);
  for (const [logical, bytes] of originals) {
    if (excluded.includes(logical)) continue;
    const encoded = map(logical);
    assert.ok(actual.has(encoded), `${label}: mapped path ${encoded}`);
    assert.equal(hash(actual.get(encoded)), hash(bytes), `${label}: byte identity ${logical}`);
  }
  const normalized = [...actual.keys()].map(p => p.endsWith('.aibasset') ? p.slice(0, -'.aibasset'.length) : p);
  assert.equal(new Set(normalized).size, normalized.length, `${label}: no Android normalized path collision`);
  return [...actual].map(([p, b]) => [p, hash(b)]).sort((a, b) => a[0].localeCompare(b[0]));
}
try {
  const probeSource = path.join(root, 'assets/termux-candidate-probe');
  const probeDest = path.join(temp, 'probe-apk-assets');
  const p1 = probe.stageCandidateProbeAssets(root, probeDest);
  const probeSnapshot = checkMapping(p1, probeSource, 'probe');
  assert.deepEqual(checkMapping(probe.stageCandidateProbeAssets(root, probeDest), probeSource, 'probe-repeat'), probeSnapshot, 'probe staging idempotent');
  const probeKotlin = probe.candidateProbeKotlin('com.karat.aibuilder');
  assert.match(probeKotlin, /private fun assetPath\(rel: String\).*rel \+ "\.aibasset"/);
  assert.match(probeKotlin, /context\.assets\.open\("candidate-probe\/" \+ assetPath\(rel\)\)/);

  const fullSource = path.join(root, 'assets/termux-candidate-full');
  const fullDest = path.join(temp, 'full-apk-assets');
  const f1 = full.stageFullCandidateAssets(root, fullDest);
  const fullSnapshot = checkMapping(f1, fullSource, 'full', ['local-pins.json']);
  assert.deepEqual(checkMapping(full.stageFullCandidateAssets(root, fullDest), fullSource, 'full-repeat', ['local-pins.json']), fullSnapshot, 'full staging idempotent');
  const fullKotlin = full.candidateFullKotlin('com.karat.aibuilder', root);
  assert.match(fullKotlin, /private fun assetPath\(rel: String\).*rel \+ "\.aibasset"/);
  assert.match(fullKotlin, /context\.assets\.open\(ASSET_PREFIX \+ assetPath\(entry\.rel\)\)/);
  assert.ok(fullKotlin.includes('Packages.gz'), 'signed pin table retains logical Packages.gz path');
  assert.ok(!fullKotlin.includes('Packages.gz.aibasset'), 'APK suffix is not written into logical signed pin table');

  // Signed-source pins remain authoritative: changing an input byte must still reject staging.
  const corruptProject = path.join(temp, 'corrupt-project');
  fs.mkdirSync(path.join(corruptProject, 'assets'), { recursive: true });
  fs.cpSync(probeSource, path.join(corruptProject, 'assets/termux-candidate-probe'), { recursive: true });
  const corruptFile = path.join(corruptProject, 'assets/termux-candidate-probe/dists/stable/Release');
  const bytes = fs.readFileSync(corruptFile); bytes[0] ^= 1; fs.writeFileSync(corruptFile, bytes);
  assert.throws(() => probe.stageCandidateProbeAssets(corruptProject, path.join(temp, 'rejected-corrupt')), /size|SHA|pin/i);
  // Existing candidate API regression retains explicit symlink rejection as well.
  const linkedProject = path.join(temp, 'linked-project');
  fs.mkdirSync(path.join(linkedProject, 'assets'), { recursive: true });
  fs.cpSync(probeSource, path.join(linkedProject, 'assets/termux-candidate-probe'), { recursive: true });
  const probeScript = path.join(linkedProject, 'assets/termux-candidate-probe/probe.sh');
  fs.unlinkSync(probeScript); fs.symlinkSync(path.join(probeSource, 'probe.sh'), probeScript);
  assert.throws(() => probe.stageCandidateProbeAssets(linkedProject, path.join(temp, 'rejected-link')), /symlink/i);
  console.log(`AIB_V494_CANDIDATE_ASSET_MAPPING_OK probe=${probeSnapshot.length} full=${fullSnapshot.length} byte-identical=PASS collision-free=PASS idempotent=PASS Kotlin-remap=PASS source-pin-rejection=PASS symlink-rejection=PASS`);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
