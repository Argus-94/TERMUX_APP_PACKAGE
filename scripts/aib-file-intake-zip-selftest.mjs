#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const archiveSource = fs.readFileSync(path.join(root, 'lib/archive-utils.ts'), 'utf8');
const intakeSource = fs.readFileSync(path.join(root, 'lib/file-intake.ts'), 'utf8');
assert.match(archiveSource, /source\.size - 65_557/, 'EOCD search must be bounded to the final 65,557 bytes');
assert.match(archiveSource, /MAX_CENTRAL_DIRECTORY_BYTES/, 'central-directory reads must have a fixed upper bound');
assert.match(archiveSource, /function isUnsafePath/, 'archive paths must be normalized and checked for traversal');
assert.match(archiveSource, /MAX_ARCHIVE_UNCOMPRESSED/, 'declared extracted size must be bounded');
assert.match(archiveSource, /MAX_COMPRESSION_RATIO/, 'compression ratio must be bounded');
assert.match(archiveSource, /crc32\(bytes\) !== member\.crc32/, 'selected entries must pass CRC verification');
assert.match(intakeSource, /session\.archive = await inspectZip\(source, archiveFormat\)/,
  'file intake must use the shared production archive parser');
assert.match(intakeSource, /magicType === "ARCHIVE" && detectedType === "UNKNOWN"/,
  'ZIP magic should route extensionless archive attachments to metadata inspection');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aib-file-intake-zip-'));
try {
  const harnessPath = path.join(temp, 'harness.mjs');
  const archiveUrl = pathToFileURL(path.join(root, 'lib/archive-utils.ts')).href;
  fs.writeFileSync(harnessPath, `
import assert from 'node:assert/strict';
import { byteArrayZipSource, inspectZip, listZipEntryNames } from ${JSON.stringify(archiveUrl)};

const u16 = (b, p, n) => b.writeUInt16LE(n, p);
const u32 = (b, p, n) => b.writeUInt32LE(n >>> 0, p);
function makeZip(entries = []) {
  const locals = [];
  const centrals = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const payload = Buffer.from(entry.payload ?? 'x');
    const compressed = entry.compressedSize ?? payload.length;
    const uncompressed = entry.uncompressedSize ?? payload.length;
    const local = Buffer.alloc(30 + name.length + payload.length);
    u32(local, 0, 0x04034b50); u16(local, 4, 20); u16(local, 6, 0);
    u16(local, 8, 0); u32(local, 14, 0); u32(local, 18, compressed);
    u32(local, 22, uncompressed); u16(local, 26, name.length); u16(local, 28, 0);
    name.copy(local, 30); payload.copy(local, 30 + name.length);
    locals.push(local);

    const central = Buffer.alloc(46 + name.length);
    u32(central, 0, 0x02014b50); u16(central, 4, entry.madeBy ?? 0x031e);
    u16(central, 6, 20); u16(central, 8, 0); u16(central, 10, 0);
    u32(central, 16, 0); u32(central, 20, compressed); u32(central, 24, uncompressed);
    u16(central, 28, name.length); u16(central, 30, 0); u16(central, 32, 0);
    u16(central, 34, 0); u32(central, 38, entry.externalAttributes ?? 0);
    u32(central, 42, localOffset); name.copy(central, 46);
    centrals.push(central);
    localOffset += local.length;
  }
  const centralOffset = localOffset;
  const centralBytes = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  u32(eocd, 0, 0x06054b50); u16(eocd, 4, 0); u16(eocd, 6, 0);
  u16(eocd, 8, entries.length); u16(eocd, 10, entries.length);
  u32(eocd, 12, centralBytes.length); u32(eocd, 16, centralOffset); u16(eocd, 20, 0);
  return Buffer.concat([...locals, centralBytes, eocd]);
}
const asBytes = b => new Uint8Array(b.buffer, b.byteOffset, b.byteLength);

(async () => {
  const valid = await inspectZip(byteArrayZipSource(asBytes(makeZip([
    { name: 'AndroidManifest.xml' }, { name: 'app/build.gradle' }, { name: 'app.config.js' },
  ]))), 'zip');
  assert.equal(valid.safe, true, 'well-formed project ZIP should be safe');
  assert.equal(valid.entryCount, 3);
  assert.equal(valid.projectType, 'android', 'Android project type takes precedence');
  assert.ok(valid.keyFiles.includes('AndroidManifest.xml'));
  assert.ok(valid.keyFiles.includes('app/build.gradle'));
  assert.ok(valid.keyFiles.includes('app.config.js'));
  assert.equal(valid.totalUncompressedBytes, 3);

  const limited = await listZipEntryNames(byteArrayZipSource(asBytes(makeZip([
    { name: 'one.txt' }, { name: 'two.txt' }, { name: 'three.txt' },
  ]))), 'zip', 2);
  assert.equal(limited.inspection.safe, false, 'member enumeration must stop at its explicit count limit');
  assert.ok(limited.inspection.warnings.some(warning => warning.includes('selected entry count exceeds 2')));

  const traversal = await inspectZip(byteArrayZipSource(asBytes(makeZip([{ name: '../private.txt' }]))), 'zip');
  assert.equal(traversal.safe, false, 'path traversal member must be unsafe');
  assert.ok(traversal.warnings.includes('unsafe archive path'));
  assert.ok(!traversal.warnings.some(warning => warning.includes('private.txt')), 'warnings must not expose raw member names');

  const symlink = await inspectZip(byteArrayZipSource(asBytes(makeZip([{ name: 'link', externalAttributes: (0xa1ff << 16) >>> 0 }]))), 'zip');
  assert.equal(symlink.safe, false, 'symlink member must be unsafe');
  assert.ok(symlink.warnings.includes('link or special archive member'));

  const badEocd = makeZip([{ name: 'ok.txt' }]);
  badEocd[badEocd.length - 22] = 0;
  assert.equal((await inspectZip(byteArrayZipSource(asBytes(badEocd)), 'zip')).safe, false, 'corrupt EOCD must fail closed');

  const badCentral = makeZip([{ name: 'ok.txt' }]);
  const centralOffset = badCentral.readUInt32LE(badCentral.length - 22 + 16);
  badCentral[centralOffset] = 0;
  assert.equal((await inspectZip(byteArrayZipSource(asBytes(badCentral)), 'zip')).safe, false, 'corrupt central directory must fail closed');

  const oversized = await inspectZip(byteArrayZipSource(asBytes(makeZip([
    { name: 'large.bin', payload: 'x', compressedSize: 1, uncompressedSize: 2 * 1024 * 1024 * 1024 + 1 },
  ]))), 'zip');
  assert.equal(oversized.safe, false, 'excessive declared uncompressed size must fail closed');
  assert.ok(oversized.warnings.some(warning => warning.includes('declared extracted size exceeds')));

  const body = Buffer.alloc(2 * 1024 * 1024, 0);
  body.writeUInt32LE(0x02014b50, 8);
  const bounded = await inspectZip(byteArrayZipSource(asBytes(body)), 'zip');
  assert.equal(bounded.safe, false);
  assert.ok(bounded.warnings.includes('ZIP EOCD not found in trailing window'));

  console.log('AIB_FILE_INTAKE_ZIP_SELFTEST_OK shared_parser=checked valid_project=checked member_cap=checked traversal=blocked symlink=blocked corrupt_eocd=blocked corrupt_central=blocked size_limit=blocked bounded_eocd_window=checked');
})().catch(error => { console.error(error); process.exitCode = 1; });
`);
  const run = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', harnessPath], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (run.status !== 0) throw new Error(`ZIP selftest subprocess failed (status=${run.status}):\n${run.stdout}\n${run.stderr}`);
  process.stdout.write(run.stdout);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
