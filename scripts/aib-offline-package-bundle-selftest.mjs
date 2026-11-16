#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const ts = require('typescript');
const temp = fs.mkdtempSync(path.join(root, '.tmp-offline-bundle-test-'));
try {
  for (const [sourceName, outputName] of [
    ['lib/archive-utils.ts', 'archive-utils.cjs'],
    ['lib/offline-package-bundle.ts', 'offline-package-bundle.cjs'],
    ['lib/termux-bridge.ts', 'termux-bridge.cjs'],
  ]) {
    const source = fs.readFileSync(path.join(root, sourceName), 'utf8');
    const output = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
      fileName: sourceName,
    }).outputText
      .replace('require("./archive-utils")', 'require("./archive-utils.cjs")')
      .replace('require("./offline-package-bundle")', 'require("./offline-package-bundle.cjs")');
    fs.writeFileSync(path.join(temp, outputName), output);
  }

  const harnessPath = path.join(temp, 'harness.cjs');
  fs.writeFileSync(harnessPath, String.raw`
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const originalLoad = Module._load;
let verifierAvailable = true;
let verifierResult = true;
let verifierCalls = [];
let forcedFileHash = null;
let nativeStageResult = { commandId: 'native-stage', stdout: 'AIB_OFFLINE_APT_SIMULATION_OK\n', stderr: '', exitCode: 0, timedOut: false, outputTruncated: false, durationMs: 1, backendId: 'embedded-termux' };
let nativeInstallResult = { commandId: 'native-install', stdout: 'AIB_OFFLINE_INSTALL_VERIFIED\n', stderr: '', exitCode: 0, timedOut: false, outputTruncated: false, durationMs: 1, backendId: 'embedded-termux' };
const nativeStageCalls = [], nativeInstallCalls = [], nativeCancelCalls = [];
const fileBytes = new Map();
const directoryUris = new Set(['file:///cache']);
const joinUri = (base, name) => String(base).replace(/\/$/, '') + '/' + name;
class Directory {
  constructor(...parts) { this.uri = parts.length === 1 && typeof parts[0] === 'string' ? parts[0] : parts.slice(1).reduce((uri, part) => joinUri(uri, part?.uri ?? part), parts[0]?.uri ?? parts[0]); }
  get exists() { return directoryUris.has(this.uri); }
  create() { directoryUris.add(this.uri); }
  createDirectory(name) { const child = new Directory(this, name); directoryUris.add(child.uri); return child; }
  delete() { for (const key of [...fileBytes.keys()]) if (key.startsWith(this.uri + '/')) fileBytes.delete(key); for (const key of [...directoryUris]) if (key === this.uri || key.startsWith(this.uri + '/')) directoryUris.delete(key); }
}
class File {
  constructor(...parts) { this.uri = parts.length === 1 && typeof parts[0] === 'string' ? parts[0] : parts.slice(1).reduce((uri, part) => joinUri(uri, part?.uri ?? part), parts[0]?.uri ?? parts[0]); }
  get exists() { return fileBytes.has(this.uri); }
  get size() { return fileBytes.get(this.uri)?.length ?? 0; }
  slice(start, end) { const bytes = fileBytes.get(this.uri)?.subarray(start, end) ?? new Uint8Array(); const copy = Uint8Array.from(bytes); return { arrayBuffer: async () => copy.buffer }; }
  create() { fileBytes.set(this.uri, new Uint8Array()); }
  write(bytes) { fileBytes.set(this.uri, Uint8Array.from(bytes)); }
  delete() { fileBytes.delete(this.uri); }
}
const Paths = { cache: new Directory('file:///cache') };
const nativeMock = {
  verifyOfflinePackageManifest: async () => verifierResult,
  sha256File: async uri => forcedFileHash ?? crypto.createHash('sha256').update(fileBytes.get(uri) ?? Buffer.alloc(0)).digest('hex'),
  stageOfflinePackageBundle: async (...args) => { nativeStageCalls.push(args); return nativeStageResult; },
  installOfflinePackageBundle: async (...args) => { nativeInstallCalls.push(args); return nativeInstallResult; },
  cancelOfflinePackageBundle: async requestId => { nativeCancelCalls.push(requestId); },
};
Module._load = function(request, parent, isMain) {
  if (request === 'expo-file-system') return { File, Directory, Paths };
  if (request === 'react-native') return { NativeModules: { TermuxBridge: nativeMock }, Platform: { OS: 'android' },
    NativeEventEmitter: class { addListener() { return { remove() {} }; } }, Linking: {} };
  if (request === './termux-bridge') return {
    isOfflinePackageSignatureVerifierAvailable: () => verifierAvailable,
    verifyOfflinePackageManifestSignature: async (manifest, signature) => {
      verifierCalls.push({ manifest: new Uint8Array(manifest), signature: new Uint8Array(signature) });
      return verifierResult;
    },
    getOfflineBundleFileSha256: async uri => forcedFileHash ?? crypto.createHash('sha256').update(fileBytes.get(uri) ?? Buffer.alloc(0)).digest('hex'),
  };
  if (request === './termux-permission-gate') return {
    isAndroidRunCommandPermissionDenied: raw => /AIB_PRIVATE_RUNTIME_REQUIRED|AIB_EMBEDDED_RUNTIME_UNAVAILABLE|EMBEDDED_TERMUX_UNAVAILABLE/i.test(String(raw ?? '')),
    runCommandPermissionStatus: () => 'AIB_EMBEDDED_RUNTIME_UNAVAILABLE',
    RunCommandPermissionGate: class {
      remember() {}
      invalidate() {}
      async check(readPermission) { return (await readPermission()) === true; }
    },
  };
  if (request === './offline-package-bundle') return require('./offline-package-bundle.cjs');
  if (request.endsWith('.cjs')) return originalLoad.call(this, request, parent, isMain);
  if (request.startsWith('./')) return new Proxy({}, { get: () => () => undefined });
  return originalLoad.call(this, request, parent, isMain);
};
const { byteArrayZipSource, listZipEntryNames } = require('./archive-utils.cjs');
const { inspectOfflinePackageBundleSource, prepareOfflinePackageBundleStage } = require('./offline-package-bundle.cjs');
const u16 = (b, p, n) => b.writeUInt16LE(n, p);
const u32 = (b, p, n) => b.writeUInt32LE(n >>> 0, p);
function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function makeZip(entries, { duplicateCentral = false, signatureBytes = 256, symlinkName = null } = {}) {
  const locals = [], centrals = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const payload = Buffer.from(entry.payload ?? '');
    const crc = crc32(payload);
    const local = Buffer.alloc(30 + name.length + payload.length);
    u32(local, 0, 0x04034b50); u16(local, 4, 20); u16(local, 6, 0); u16(local, 8, 0);
    u32(local, 14, crc); u32(local, 18, payload.length); u32(local, 22, payload.length);
    u16(local, 26, name.length); u16(local, 28, 0); name.copy(local, 30); payload.copy(local, 30 + name.length);
    locals.push(local);
    const central = Buffer.alloc(46 + name.length);
    u32(central, 0, 0x02014b50); u16(central, 4, 0x031e); u16(central, 6, 20);
    u16(central, 8, 0); u16(central, 10, 0); u32(central, 16, crc);
    u32(central, 20, payload.length); u32(central, 24, payload.length);
    u16(central, 28, name.length); u16(central, 30, 0); u16(central, 32, 0); u16(central, 34, 0);
    u32(central, 38, entry.name === symlinkName ? ((0xa1ff << 16) >>> 0) : 0);
    u32(central, 42, localOffset); name.copy(central, 46); centrals.push(central);
    localOffset += local.length;
  }
  if (duplicateCentral && centrals.length) centrals.push(Buffer.from(centrals[centrals.length - 1]));
  const centralOffset = localOffset;
  const centralBytes = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  u32(eocd, 0, 0x06054b50); u16(eocd, 4, 0); u16(eocd, 6, 0);
  u16(eocd, 8, centrals.length); u16(eocd, 10, centrals.length);
  u32(eocd, 12, centralBytes.length); u32(eocd, 16, centralOffset); u16(eocd, 20, 0);
  return new Uint8Array(Buffer.concat([...locals, centralBytes, eocd]));
}
const indexPath = 'feed/dists/stable/main/binary-aarch64/Packages';
const debPath = 'feed/pool/hello_2:1.0-1_aarch64.deb';
const debBytes = Buffer.from('fixture-deb-01');
const debHash = crypto.createHash('sha256').update(debBytes).digest('hex');
const indexBytes = Buffer.from(['Package: hello', 'Version: 2:1.0-1', 'Architecture: aarch64', 'Filename: pool/hello_2:1.0-1_aarch64.deb', 'Size: ' + debBytes.length, 'SHA256: ' + debHash, '', ''].join('\n'));
const indexHash = crypto.createHash('sha256').update(indexBytes).digest('hex');
function makeManifest() {
  return {
    format: 'aibuilder-offline-package-bundle', schemaVersion: 2, appId: 'com.karat.aibuilder', architecture: 'aarch64',
    catalogState: 'production-qualified', catalogCommit: 'a'.repeat(40), catalogSha256: indexHash,
    dependencyClosureComplete: true, signatureAlgorithm: 'SHA256withRSA',
    signerCertificateSha256: '661e5c868dbb38f8fe57d380e5c9b35e594e79bedb72d9ad2ad0113665c80418',
    feedRoot: 'feed',
    files: [
      { path: indexPath, sizeBytes: indexBytes.length, sha256: indexHash },
      { path: debPath, sizeBytes: debBytes.length, sha256: debHash },
    ],
    packages: [{ name: 'hello', version: '2:1.0-1', architecture: 'aarch64', filename: debPath,
      sizeBytes: debBytes.length, sha256: debHash, depends: [] }],
  };
}
function makeBundle(manifest = makeManifest(), extras = {}, options = {}) {
  const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
  return { bytes: makeZip([
    { name: 'manifest.json', payload: manifestBytes },
    { name: 'manifest.sig', payload: Buffer.alloc(options.signatureBytes ?? 256, 0x5a) },
    { name: indexPath, payload: indexBytes },
    { name: debPath, payload: debBytes },
    ...Object.entries(extras).map(([name, payload]) => ({ name, payload })),
  ], options), manifestBytes };
}
function makeStageBundle({ architecture = 'aarch64', declaredDebHash = debHash, actualDeb = debBytes, indexFilename = 'pool/hello_2:1.0-1_aarch64.deb' } = {}) {
  const index = Buffer.from(['Package: hello', 'Version: 2:1.0-1', 'Architecture: ' + architecture, 'Filename: ' + indexFilename, 'Size: ' + debBytes.length, 'SHA256: ' + declaredDebHash, '', ''].join('\n'));
  const indexDigest = crypto.createHash('sha256').update(index).digest('hex');
  const manifest = makeManifest();
  manifest.catalogSha256 = indexDigest;
  manifest.files[0] = { path: indexPath, sizeBytes: index.length, sha256: indexDigest };
  manifest.files[1] = { path: debPath, sizeBytes: debBytes.length, sha256: declaredDebHash };
  manifest.packages[0] = { ...manifest.packages[0], architecture, sizeBytes: debBytes.length, sha256: declaredDebHash };
  const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
  return { manifest, manifestBytes, bytes: makeZip([
    { name: 'manifest.json', payload: manifestBytes },
    { name: 'manifest.sig', payload: Buffer.alloc(256, 0x5a) },
    { name: indexPath, payload: index },
    { name: debPath, payload: actualDeb },
  ]) };
}
const inspect = async (fixture, opts = {}) => inspectOfflinePackageBundleSource(byteArrayZipSource(fixture.bytes), opts);
(async () => {
  const validFixture = makeBundle();
  verifierCalls = [];
  const listing = await listZipEntryNames(byteArrayZipSource(validFixture.bytes), 'zip', 258);
  assert.equal(listing.inspection.safe, true);
  const result = await inspect(validFixture);
  assert.deepEqual(result, { status: 'blocked', code: 'AIB_OFFLINE_PACKAGE_NATIVE_PREFLIGHT_UNAVAILABLE', packageCount: 1, declaredPackageBytes: debBytes.length });
  assert.equal(verifierCalls.length, 1, 'Karat verifier must be invoked for the exact raw manifest');
  assert.deepEqual(Buffer.from(verifierCalls[0].manifest), validFixture.manifestBytes);
  assert.equal(verifierCalls[0].signature.length, 256);

  const olderDebPath = 'feed/pool/hello_1.0-1_aarch64.deb';
  const olderDebBytes = Buffer.from('fixture-deb-older');
  const olderDebHash = crypto.createHash('sha256').update(olderDebBytes).digest('hex');
  const olderIndex = Buffer.from(['Package: hello', 'Version: 1.0-1', 'Architecture: aarch64', 'Filename: pool/hello_1.0-1_aarch64.deb', 'Size: ' + olderDebBytes.length, 'SHA256: ' + olderDebHash].join('\n'));
  const multiIndexBytes = Buffer.from(indexBytes.toString('utf8').trimEnd() + '\n\n' + olderIndex.toString('utf8') + '\n\n');
  const multiIndexHash = crypto.createHash('sha256').update(multiIndexBytes).digest('hex');
  const multiManifest = makeManifest();
  multiManifest.catalogSha256 = multiIndexHash;
  multiManifest.files[0] = { path: indexPath, sizeBytes: multiIndexBytes.length, sha256: multiIndexHash };
  multiManifest.files.push({ path: olderDebPath, sizeBytes: olderDebBytes.length, sha256: olderDebHash });
  multiManifest.packages.push({ name: 'hello', version: '1.0-1', architecture: 'aarch64', filename: olderDebPath,
    sizeBytes: olderDebBytes.length, sha256: olderDebHash, depends: [] });
  const multiManifestBytes = Buffer.from(JSON.stringify(multiManifest), 'utf8');
  const multiArchive = makeZip([
    { name: 'manifest.json', payload: multiManifestBytes },
    { name: 'manifest.sig', payload: Buffer.alloc(256, 0x5a) },
    { name: indexPath, payload: multiIndexBytes },
    { name: debPath, payload: debBytes },
    { name: olderDebPath, payload: olderDebBytes },
  ]);
  verifierCalls = [];
  const multiVersionResult = await inspect({ bytes: multiArchive, manifestBytes: multiManifestBytes });
  assert.equal(multiVersionResult.code, 'AIB_OFFLINE_PACKAGE_NATIVE_PREFLIGHT_UNAVAILABLE', 'two signed versions of one package name pass the JS catalog/index checks');
  assert.equal(multiVersionResult.packageCount, 2);
  assert.equal(multiVersionResult.declaredPackageBytes, debBytes.length + olderDebBytes.length);
  assert.equal(verifierCalls.length, 1);
  assert.deepEqual(Buffer.from(verifierCalls[0].manifest), multiManifestBytes);

  // The verifier is invoked before even decoding or validating the manifest schema.
  const archIndependent = makeManifest(); archIndependent.packages[0].architecture = 'all';
  assert.equal((await inspect(makeBundle(archIndependent))).code, 'AIB_OFFLINE_PACKAGE_NATIVE_PREFLIGHT_UNAVAILABLE', 'Architecture: all is valid for aarch64-compatible packages');
  const foreignArchitecture = makeManifest(); foreignArchitecture.packages[0].architecture = 'x86_64';
  assert.equal((await inspect(makeBundle(foreignArchitecture))).code, 'AIB_OFFLINE_PACKAGE_RECORD_INVALID', 'foreign package architecture is rejected');

  // The verifier is invoked before even decoding or validating the manifest schema.
  verifierCalls = [];
  const malformed = makeBundle({ schemaVersion: 1 });
  const malformedResult = await inspect(malformed);
  assert.equal(malformedResult.code, 'AIB_OFFLINE_PACKAGE_MANIFEST_SCHEMA_INVALID');
  assert.equal(verifierCalls.length, 1, 'signature validation must precede JSON schema use');

  verifierCalls = [];
  verifierResult = false;
  const tamperedResult = await inspect(validFixture);
  assert.equal(tamperedResult.code, 'AIB_OFFLINE_PACKAGE_SIGNATURE_INVALID');
  assert.equal(verifierCalls.length, 1);
  verifierResult = true;

  const wrongApp = makeManifest(); wrongApp.appId = 'com.example.other';
  assert.equal((await inspect(makeBundle(wrongApp))).code, 'AIB_OFFLINE_PACKAGE_BUNDLE_IDENTITY_INVALID');
  const wrongCert = makeManifest(); wrongCert.signerCertificateSha256 = '0'.repeat(64);
  assert.equal((await inspect(makeBundle(wrongCert))).code, 'AIB_OFFLINE_PACKAGE_MANIFEST_FIELDS_INVALID');

  const wrongHash = makeManifest(); wrongHash.files[1].sha256 = 'f'.repeat(64); wrongHash.packages[0].sha256 = 'f'.repeat(64);
  assert.equal((await inspect(makeBundle(wrongHash))).status, 'blocked', 'content hashes require native streaming preflight and are not trusted here');
  const wrongSize = makeManifest(); wrongSize.files[1].sizeBytes++; wrongSize.packages[0].sizeBytes++;
  assert.equal((await inspect(makeBundle(wrongSize))).code, 'AIB_OFFLINE_PACKAGE_SIZE_MISMATCH');
  const badPath = makeManifest(); badPath.files[0].path = 'feed/../outside';
  assert.equal((await inspect(makeBundle(badPath))).code, 'AIB_OFFLINE_PACKAGE_FILE_RECORD_INVALID');
  const duplicatePath = makeManifest(); duplicatePath.files.push({ ...duplicatePath.files[0] });
  assert.equal((await inspect(makeBundle(duplicatePath))).code, 'AIB_OFFLINE_PACKAGE_FILE_RECORD_INVALID');
  const metadataMismatch = makeManifest(); metadataMismatch.packages[0].version = 'bad version';
  assert.equal((await inspect(makeBundle(metadataMismatch))).code, 'AIB_OFFLINE_PACKAGE_RECORD_INVALID');
  const dependencyClaim = makeManifest(); dependencyClaim.packages[0].depends = ['missing-package (>= 1)'];
  assert.equal((await inspect(makeBundle(dependencyClaim))).status, 'blocked', 'dependency closure is not claimed as checked without native package parsing and APT simulation');

  const unexpected = await inspect(makeBundle(makeManifest(), { 'feed/install.sh': Buffer.from('no') }));
  assert.equal(unexpected.code, 'AIB_OFFLINE_PACKAGE_MEMBERS_DO_NOT_MATCH_MANIFEST');
  const traversalZip = makeBundle();
  const traversal = await inspect({ bytes: makeZip([
    { name: 'manifest.json', payload: traversalZip.manifestBytes }, { name: 'manifest.sig', payload: Buffer.alloc(256) },
    { name: '../escape', payload: 'x' },
  ]) });
  assert.equal(traversal.code, 'AIB_OFFLINE_PACKAGE_ARCHIVE_STRUCTURE_INVALID');
  const duplicateFixture = makeBundle();
  const duplicate = await inspect({ bytes: makeZip([
    { name: 'manifest.json', payload: duplicateFixture.manifestBytes }, { name: 'manifest.sig', payload: Buffer.alloc(256) },
    { name: debPath, payload: debBytes }, { name: debPath, payload: debBytes },
  ], { duplicateCentral: true }) });
  assert.equal(duplicate.code, 'AIB_OFFLINE_PACKAGE_ARCHIVE_STRUCTURE_INVALID');
  const symlinkFixture = makeBundle();
  const symlink = await inspect({ bytes: makeZip([
    { name: 'manifest.json', payload: symlinkFixture.manifestBytes }, { name: 'manifest.sig', payload: Buffer.alloc(256) },
    { name: indexPath, payload: indexBytes }, { name: debPath, payload: debBytes },
  ], { symlinkName: debPath }) });
  assert.equal(symlink.code, 'AIB_OFFLINE_PACKAGE_ARCHIVE_STRUCTURE_INVALID');
  assert.equal((await inspect(makeBundle(makeManifest(), {}, { signatureBytes: 127 }))).code, 'AIB_OFFLINE_PACKAGE_METADATA_SIZE_INVALID');

  verifierAvailable = false;
  assert.equal((await inspect(validFixture)).code, 'AIB_OFFLINE_PACKAGE_KARAT_VERIFIER_UNAVAILABLE');
  verifierAvailable = true;

  const controller = new AbortController(); controller.abort();
  assert.equal((await inspect(validFixture, { signal: controller.signal })).code, 'AIB_OFFLINE_PACKAGE_CANCELLED');
  let lastProgress = 0;
  const progress = await inspect(validFixture, { onProgress: item => { lastProgress = Math.max(lastProgress, item.percent); } });
  assert.equal(progress.status, 'blocked'); assert.equal(lastProgress, 100);

  const validStageFixture = makeStageBundle();
  fileBytes.set('memory://valid-stage', validStageFixture.bytes);
  const staged = await prepareOfflinePackageBundleStage('memory://valid-stage', 'stage-valid-00000001');
  assert.equal(staged.status, 'ready', 'valid signed archive is extracted after structural preflight');
  assert.equal(staged.packageCount, 1);
  assert.equal(staged.packages[0].architecture, 'aarch64');
  assert.equal(fileBytes.get(staged.stageDirectoryUri + '/' + indexPath).length, indexBytes.length);
  assert.equal(Buffer.from(fileBytes.get(staged.stageDirectoryUri + '/manifest.json')).toString(), validStageFixture.manifestBytes.toString());

  const allStageFixture = makeStageBundle({ architecture: 'all' });
  fileBytes.set('memory://all-stage', allStageFixture.bytes);
  assert.equal((await prepareOfflinePackageBundleStage('memory://all-stage', 'stage-all-0000000001')).status, 'ready', 'architecture=all is accepted when the index agrees');
  const foreignStageFixture = makeStageBundle({ architecture: 'x86_64' });
  fileBytes.set('memory://foreign-stage', foreignStageFixture.bytes);
  assert.equal((await prepareOfflinePackageBundleStage('memory://foreign-stage', 'stage-for-0000000001')).code, 'AIB_OFFLINE_PACKAGE_RECORD_INVALID');

  const badCrc = Uint8Array.from(validStageFixture.bytes);
  const debOffset = Buffer.from(badCrc).indexOf(debBytes);
  badCrc[debOffset] ^= 1;
  fileBytes.set('memory://bad-crc-stage', badCrc);
  const badCrcStage = await prepareOfflinePackageBundleStage('memory://bad-crc-stage', 'stage-crc-0000000001');
  assert.notEqual(badCrcStage.status, 'ready', 'corrupt CRC is rejected before stage success');

  const mismatchFixture = makeStageBundle({ declaredDebHash: 'f'.repeat(64) });
  fileBytes.set('memory://hash-mismatch-stage', mismatchFixture.bytes);
  forcedFileHash = 'e'.repeat(64);
  const hashMismatch = await prepareOfflinePackageBundleStage('memory://hash-mismatch-stage', 'stage-hash-00000001');
  forcedFileHash = null;
  assert.equal(hashMismatch.code, 'AIB_OFFLINE_PACKAGE_HASH_MISMATCH');
  assert.equal(directoryUris.has('file:///cache/offline-bundle-stage-hash-00000001'), false, 'failed partial extraction deletes the entire stage');

  const cancelController = new AbortController();
  fileBytes.set('memory://cancel-stage', validStageFixture.bytes);
  const cancelledStage = await prepareOfflinePackageBundleStage('memory://cancel-stage', 'stage-cancel-00000001', cancelController.signal,
    event => { if (event.phase === 'extracting') cancelController.abort(); });
  assert.equal(cancelledStage.status, 'cancelled');
  assert.equal(directoryUris.has('file:///cache/offline-bundle-stage-cancel-00000001'), false, 'cancelled extraction removes its stage directory');

  const bridgeSource = fs.readFileSync(path.resolve(process.cwd(), 'lib/termux-bridge.ts'), 'utf8');
  assert.match(bridgeSource, /stageOfflinePackageBundle\(prepared\.stageDirectoryUri, stageId, requestId\)/, 'only the private directory is passed to native stage');
  assert.match(bridgeSource, /isAllowedOfflineBundleInputUri[\s\S]*Paths\.cache\.uri[\s\S]*DocumentPicker/, 'copied picker files are accepted only inside the app cache picker directory');
  assert.match(bridgeSource, /AIB_OFFLINE_APT_SIMULATION_OK/);
  assert.match(bridgeSource, /AIB_OFFLINE_INSTALL_VERIFIED/);
  assert.match(bridgeSource, /result\.exitCode === 0 && result\.timedOut === false && result\.outputTruncated === false/);
  assert.doesNotMatch(bridgeSource.slice(bridgeSource.indexOf('export async function stageOfflinePackageBundle'), bridgeSource.indexOf('export async function inspectOfflinePackageBundle')), /apt-get|\bapt\b|runEmbeddedTermuxCommand|execAsync|spawn\s*\(/, 'JavaScript staging does not dispatch shell or apt commands');

  const bridge = require('./termux-bridge.cjs');
  const outsideCache = await bridge.stageOfflinePackageBundle('file:///cache/untrusted/native-good.zip', 'req-native-outside-cache');
  assert.equal(outsideCache.code, 'AIB_OFFLINE_BUNDLE_URI_INVALID', 'arbitrary file:// sources remain rejected');
  fileBytes.set('file:///cache/DocumentPicker/native-good.zip', validStageFixture.bytes);
  fileBytes.set('content://provider/document/native-good', validStageFixture.bytes);
  nativeStageResult = { ...nativeStageResult, stdout: 'APT dry run\nAIB_OFFLINE_APT_SIMULATION_OK\n' };
  const pickedCacheUri = 'file:///cache/DocumentPicker/native-good.zip';
  const nativeReady = await bridge.stageOfflinePackageBundle(pickedCacheUri, 'req-native-ready');
  assert.equal(nativeReady.status, 'ready', 'copied app-cache archive plus exact clean native simulation marker is ready');
  assert.equal(fileBytes.has(pickedCacheUri), false, 'temporary native picker copy is removed after staging');
  assert.match(nativeReady.stageId, /^[A-Za-z0-9_-]{16,128}$/);
  assert.equal(nativeStageCalls.at(-1)[0], 'file:///cache/offline-bundle-' + nativeReady.stageId, 'native receives the private cache directory, never the source URI');
  assert.equal(nativeStageCalls.at(-1)[1], nativeReady.stageId);
  assert.equal(nativeInstallCalls.length, 0, 'stage does not install before the UI invokes the explicit install wrapper');
  nativeInstallResult = { ...nativeInstallResult, stdout: 'Packages verified\nAIB_OFFLINE_INSTALL_VERIFIED\n' };
  const installed = await bridge.installOfflinePackageBundle(nativeReady.stageId, 'req-native-ready');
  assert.equal(installed.status, 'installed', 'only exact clean verified native install marker reports installed');
  assert.deepEqual(installed.installed, [{ name: 'hello', version: '2:1.0-1' }]);
  assert.equal(directoryUris.has('file:///cache/offline-bundle-' + nativeReady.stageId), false, 'installed stage is deleted');

  nativeStageResult = { ...nativeStageResult, stdout: 'AIB_OFFLINE_APT_SIMULATION_OK\n', exitCode: 1 };
  const notReady = await bridge.stageOfflinePackageBundle('content://provider/document/native-good', 'req-native-fail');
  assert.equal(notReady.status, 'blocked', 'nonzero native simulation cannot produce ready');
  assert.equal(directoryUris.has('file:///cache/offline-bundle-' + nativeStageCalls.at(-1)[1]), false, 'native stage failure deletes JS cache data');
  nativeStageResult = { ...nativeStageResult, exitCode: 0, stdout: 'APT simulation done\n' };
  const missingMarker = await bridge.stageOfflinePackageBundle('content://provider/document/native-good', 'req-native-marker');
  assert.equal(missingMarker.status, 'blocked', 'a clean exit without exact marker fails closed');
  assert.equal(directoryUris.has('file:///cache/offline-bundle-' + nativeStageCalls.at(-1)[1]), false);

  nativeStageResult = { ...nativeStageResult, stdout: 'AIB_OFFLINE_APT_SIMULATION_OK\n' };
  const installGateStage = await bridge.stageOfflinePackageBundle('content://provider/document/native-good', 'req-install-gate');
  nativeInstallResult = { ...nativeInstallResult, stdout: 'exit 0 without verified marker\n' };
  assert.equal((await bridge.installOfflinePackageBundle(installGateStage.stageId, 'req-install-gate')).status, 'blocked', 'missing install marker never reports installed');
  assert.equal(directoryUris.has('file:///cache/offline-bundle-' + installGateStage.stageId), false);

  const cancelStage = await bridge.stageOfflinePackageBundle('content://provider/document/native-good', 'req-cancel-stage');
  await bridge.cancelOfflinePackageBundle('req-cancel-stage');
  assert.equal(directoryUris.has('file:///cache/offline-bundle-' + cancelStage.stageId), false, 'cancel after staging deletes the owned cache stage');
  assert.equal(nativeCancelCalls.includes('req-cancel-stage'), true, 'request-scoped native cancellation is invoked');

  const uiSource = fs.readFileSync(path.resolve(process.cwd(), 'components/PackagesRightMenu.tsx'), 'utf8');
  const stageStart = uiSource.indexOf('const selectOfflineBundle');
  const stageEnd = uiSource.indexOf('useEffect(() => () => cancelOfflineBundleWork()', stageStart);
  assert.ok(stageStart >= 0 && stageEnd > stageStart, 'offline stage flow exists');
  const stageFlow = uiSource.slice(stageStart, stageEnd);
  assert.match(stageFlow, /await pickOfflinePackageArchive\(\)/, 'Android system picker is launched through the native activity-result bridge');
  assert.doesNotMatch(stageFlow, /DocumentPicker\.getDocumentAsync/, 'offline archive selection no longer relies on the Expo picker activity result');
  assert.match(stageFlow, /stageOfflinePackageBundle\(selection\.uri, requestId\)/, 'native app-cache archive URI is sent to the existing secure stage flow');
  assert.match(stageFlow, /if \(result\.status !== "ready"\)\s*\{[\s\S]*?return;/, 'blocked and rejected stages return before confirmation');
  assert.match(stageFlow, /result\.stageId[\s\S]*exactPackageList/, 'ready stage requires an opaque stage ID and complete exact package summary');
  assert.match(stageFlow, /result\.packageCount === result\.packages\.length/);
  assert.match(stageFlow, /pkg\.name[\s\S]*pkg\.version[\s\S]*pkg\.architecture[\s\S]*pkg\.sizeBytes/);
  assert.match(stageFlow, /maxVisiblePackages = 10[\s\S]*result\.packageCount/);
  assert.match(stageFlow, /formatOfflineBundleBytes\(result\.totalBytes!\)/, 'confirmation includes aggregate archive and .deb bytes');
  assert.match(stageFlow, /APT index is unsigned[\s\S]*Karat manifest signature[\s\S]*SHA-256 for every archive file[\s\S]*local-only APT simulation/);
  assert.match(stageFlow, /showDialog\([\s\S]*?onPress: \(\) => void installReadyOfflineBundle\(staged\)/, 'install is reachable only from the explicit destructive confirmation callback');
  assert.match(uiSource, /const installReadyOfflineBundle[\s\S]*?installOfflinePackageBundle\(stage\.stageId, requestId\)/, 'native install receives only opaque stageId and fresh correlated requestId');
  const nonConfirmText = stageFlow.slice(0, stageFlow.indexOf('showDialog('));
  assert.doesNotMatch(nonConfirmText, /installOfflinePackageBundle\s*\(/, 'no install call occurs during staging');
  assert.match(uiSource, /cancelOfflinePackageBundle\(active\.requestId\)/, 'explicit cancellation calls native cancel for the active request');
  assert.match(uiSource, /cancelOfflinePackageBundle\(staged\.requestId\)/, 'discarding or closing expires the staged native entry');
  assert.match(uiSource, /Cancel preflight[\s\S]*Cancel install/);
  assert.match(uiSource, /event\.requestId !== requestId[\s\S]*Math\.min\(99/);
  assert.match(uiSource, /offlineBundleState === "partial"[\s\S]*no rollback is claimed/);
  assert.doesNotMatch(uiSource, /Native installer did not report a completed result/);
  assert.doesNotMatch(uiSource, /runEmbeddedFullCandidateTransaction/);
  console.log('AIB_OFFLINE_PACKAGE_BUNDLE_SELFTEST_OK schema=v2 signature=Karat-before-JSON paths=bounded duplicates=blocked symlink=blocked helper-without-native-preflight=blocked UI=native-stage-explicit-confirmation-then-install nonready=fail-closed exact-confirmation-details=cancellation-correlated no-payload-fixture-claim=1');
})().catch(error => { console.error(error); process.exitCode = 1; });
`);
  const run = spawnSync(process.execPath, [harnessPath], { cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
  if (run.status !== 0) throw new Error(`offline bundle harness failed (status=${run.status}):\n${run.stdout}\n${run.stderr}`);
  process.stdout.write(run.stdout);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
