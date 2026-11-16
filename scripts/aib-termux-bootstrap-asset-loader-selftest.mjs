import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Module from 'node:module';

const pluginPath = new URL('../plugins/withTermuxBridge.js', import.meta.url).pathname;
const pluginSource = fs.readFileSync(pluginPath, 'utf8');
const testModulePath = `${pluginPath}.asset-selftest.cjs`;
const originalLoad = Module._load;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aib-termux-assets-'));
const projectRoot = path.join(temp, 'project');
const outsideArchive = path.join(temp, 'outside.zip');
const archiveRoot = path.join(temp, 'archive-root');
const baseArchive = path.join(temp, 'fixture.zip');

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

function makeProject(overrides = {}) {
  const source = path.join(projectRoot, 'assets/termux-bootstrap');
  fs.rmSync(projectRoot, { recursive: true, force: true });
  fs.mkdirSync(source, { recursive: true });
  const archive = path.join(source, 'termux-bootstrap-aarch64.zip');
  fs.copyFileSync(baseArchive, archive);
  const digest = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  write(`${archive}.sha256`, `${overrides.sidecar || digest}  termux-bootstrap-aarch64.zip\n`);
  const manifest = {
    schemaVersion: 1,
    applicationId: 'com.karat.aibuilder',
    architecture: 'aarch64',
    archiveFile: 'termux-bootstrap-aarch64.zip',
    archiveSha256: digest,
    sourceCommit: 'b'.repeat(40),
    bootstrapVersion: 'custom-unreleased',
    archiveStructureVerified: true,
    runtimeVerified: false,
    apkIntegrated: false,
    ...overrides.manifest,
  };
  write(`${archive}.provenance.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  return { source, archive, digest };
}

try {
  fs.mkdirSync(path.join(archiveRoot, 'bin'), { recursive: true });
  write(path.join(archiveRoot, 'bin/bash'), '#!/bin/sh\nexit 0\n');
  const zipResult = spawnSync('zip', ['-qr', baseArchive, '.'], { cwd: archiveRoot, encoding: 'utf8' });
  assert.equal(zipResult.status, 0, `could not create ZIP fixture: ${zipResult.stderr}`);
  fs.copyFileSync(baseArchive, outsideArchive);

  fs.writeFileSync(testModulePath, `${pluginSource}\nmodule.exports={loadBootstrapArtifact};\n`, 'utf8');
  Module._load = function(request, parent, isMain) {
    if (request === '@expo/config-plugins') {
      return {
        withAndroidManifest(config) { return config; },
        withMainApplication(config) { return config; },
        withDangerousMod(config) { return config; },
      };
    }
    return originalLoad.apply(this, arguments);
  };
  const imported = await import(`file://${testModulePath}?t=${Date.now()}`);
  const loadBootstrapArtifact = imported.loadBootstrapArtifact || imported.default?.loadBootstrapArtifact;
  assert.equal(typeof loadBootstrapArtifact, 'function', 'bootstrap asset loader was not exported by the plugin');

  const valid = makeProject();
  const loaded = loadBootstrapArtifact(projectRoot, 'com.karat.aibuilder');
  assert.equal(loaded.archiveSha256, valid.digest);
  assert.equal(loaded.sourceCommit, 'b'.repeat(40));
  assert.equal(loaded.bootstrapVersion, 'custom-unreleased');
  assert.equal(loaded.sourceDirectory, valid.source);
  assert.throws(() => loadBootstrapArtifact(projectRoot, 'com.termux'), /pinned to applicationId/);

  makeProject({ sidecar: '0'.repeat(64) });
  assert.throws(() => loadBootstrapArtifact(projectRoot, 'com.karat.aibuilder'), /hash, identity, architecture, or provenance/);

  makeProject({ manifest: { applicationId: 'com.termux' } });
  assert.throws(() => loadBootstrapArtifact(projectRoot, 'com.karat.aibuilder'), /hash, identity, architecture, or provenance/);

  makeProject();
  const currentArchive = path.join(projectRoot, 'assets/termux-bootstrap/termux-bootstrap-aarch64.zip');
  fs.rmSync(currentArchive);
  fs.symlinkSync(outsideArchive, currentArchive);
  assert.throws(() => loadBootstrapArtifact(projectRoot, 'com.karat.aibuilder'), /not a regular project file/);
  console.log('PASS: bundled bootstrap loader accepts only exact app/ABI SHA-256 provenance and rejects bad digest, wrong app and symlinked assets');
} finally {
  Module._load = originalLoad;
  fs.rmSync(testModulePath, { force: true });
  fs.rmSync(temp, { recursive: true, force: true });
}
