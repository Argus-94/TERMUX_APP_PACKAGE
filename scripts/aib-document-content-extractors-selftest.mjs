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
const temp = fs.mkdtempSync(path.join(root, '.tmp-document-extractors-'));
try {
  for (const [sourceName, outputName] of [
    ['lib/archive-utils.ts', 'archive-utils.cjs'],
    ['lib/document-content-extractors.ts', 'document-content-extractors.cjs'],
  ]) {
    const source = fs.readFileSync(path.join(root, sourceName), 'utf8');
    const output = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
      fileName: sourceName,
    }).outputText.replace('require("./archive-utils")', 'require("./archive-utils.cjs")');
    fs.writeFileSync(path.join(temp, outputName), output);
  }

  const harnessPath = path.join(temp, 'harness.cjs');
  fs.writeFileSync(harnessPath, String.raw`
const assert = require('node:assert/strict');
const { zipSync, strToU8 } = require('fflate');
const { byteArrayZipSource, extractSelectedZipEntries } = require('./archive-utils.cjs');
const { extractDocxContent, extractXlsxContent, extractGenericZipContent, extractApkContent, parseAndroidBinaryManifest } = require('./document-content-extractors.cjs');

function makeAxml() {
  const strings = ['manifest', 'package', 'com.example.fixture'];
  const offsets = [];
  const pieces = [];
  let cursor = 0;
  for (const value of strings) {
    const bytes = Buffer.from(value, 'utf8');
    offsets.push(cursor);
    pieces.push(Buffer.from([value.length, bytes.length]), bytes, Buffer.from([0]));
    cursor += 2 + bytes.length + 1;
  }
  const stringData = Buffer.concat(pieces);
  const stringsStart = 28 + strings.length * 4;
  const poolSize = stringsStart + stringData.length;
  const pool = Buffer.alloc(poolSize);
  pool.writeUInt16LE(0x0001, 0); pool.writeUInt16LE(28, 2); pool.writeUInt32LE(poolSize, 4);
  pool.writeUInt32LE(strings.length, 8); pool.writeUInt32LE(0, 12); pool.writeUInt32LE(0x100, 16);
  pool.writeUInt32LE(stringsStart, 20); pool.writeUInt32LE(0, 24);
  offsets.forEach((offset, i) => pool.writeUInt32LE(offset, 28 + i * 4));
  stringData.copy(pool, stringsStart);

  const start = Buffer.alloc(56);
  start.writeUInt16LE(0x0102, 0); start.writeUInt16LE(16, 2); start.writeUInt32LE(56, 4);
  start.writeUInt32LE(1, 8); start.writeUInt32LE(0xffffffff, 12);
  start.writeUInt32LE(0xffffffff, 16); start.writeUInt32LE(0, 20);
  start.writeUInt16LE(20, 24); start.writeUInt16LE(20, 26); start.writeUInt16LE(1, 28);
  start.writeUInt16LE(0, 30); start.writeUInt16LE(0, 32);
  start.writeUInt32LE(0xffffffff, 36); start.writeUInt32LE(1, 40); start.writeUInt32LE(2, 44);
  start.writeUInt16LE(8, 48); start.writeUInt8(0, 50); start.writeUInt8(0x03, 51); start.writeUInt32LE(2, 52);

  const total = 8 + pool.length + start.length;
  const header = Buffer.alloc(8);
  header.writeUInt16LE(0x0003, 0); header.writeUInt16LE(8, 2); header.writeUInt32LE(total, 4);
  return new Uint8Array(Buffer.concat([header, pool, start]));
}

(async () => {
  const crcProbe = new TextEncoder().encode('123456789');
  const storedProbe = zipSync({ 'probe.txt': crcProbe }, { level: 0 });
  const probeNameBytes = storedProbe.readUInt16LE ? storedProbe.readUInt16LE(26) : storedProbe[26] | (storedProbe[27] << 8);
  assert.ok(probeNameBytes > 0, 'test ZIP has a local member header');

  const docXml = '<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>Hello &amp; world</w:t></w:r></w:p><w:p><w:del><w:delText>hidden</w:delText></w:del></w:p></w:body></w:document>';
  const docx = zipSync({ 'word/document.xml': strToU8(docXml), 'word/header1.xml': strToU8('<w:hdr xmlns:w="urn:w"><w:p><w:r><w:t>Header text</w:t></w:r></w:p></w:hdr>') }, { level: 0 });
  const docResult = await extractDocxContent(byteArrayZipSource(docx));
  assert.match(docResult.text, /Hello & world/, 'DOCX paragraphs and XML entities are extracted as text');
  assert.match(docResult.text, /Header text/, 'DOCX header text is extracted');
  assert.doesNotMatch(docResult.text, /hidden/, 'deleted Word text is not represented as visible content');

  const dtdDocx = zipSync({ 'word/document.xml': strToU8('<!DOCTYPE w:document [<!ENTITY x SYSTEM "file:///etc/passwd">]><w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>&x;</w:t></w:r></w:p></w:body></w:document>') }, { level: 0 });
  const dtdResult = await extractDocxContent(byteArrayZipSource(dtdDocx));
  assert.match(dtdResult.text, /не прошли проверку|неподдерживаемые конструкции/, 'DTD/entity-bearing XML fails closed');
  assert.doesNotMatch(dtdResult.text, /root:/, 'no external file content is exposed');

  const xlsx = zipSync({
    'xl/workbook.xml': strToU8('<workbook xmlns:r="urn:r"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
    'xl/sharedStrings.xml': strToU8('<sst><si><r><t>Widget</t></r><r><t> A</t></r></si></sst>'),
    'xl/worksheets/sheet1.xml': strToU8('<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>OK</t></is></c><c r="C1"><f>1+1</f><v>2</v></c></row></sheetData></worksheet>'),
  }, { level: 0 });
  const xlsxResult = await extractXlsxContent(byteArrayZipSource(xlsx));
  assert.match(xlsxResult.text, /Лист: Data/);
  assert.match(xlsxResult.text, /A1: Widget A/);
  assert.match(xlsxResult.text, /B1: OK/);
  assert.match(xlsxResult.text, /C1: 2 = 1\+1/);
  assert.match(xlsxResult.text, /не вычислялись/, 'formulas are reported but never evaluated');

  const hostileXlsx = zipSync({
    'xl/workbook.xml': strToU8('<workbook xmlns:r="urn:r"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="../../secret.xml"/></Relationships>'),
    'xl/sharedStrings.xml': strToU8('<sst/>'),
    'xl/worksheets/sheet1.xml': strToU8('<worksheet><sheetData><row><c r="A1"><v>untrusted</v></c></row></sheetData></worksheet>'),
    'secret.xml': strToU8('<secret>must not be selected</secret>'),
  }, { level: 0 });
  const hostileResult = await extractXlsxContent(byteArrayZipSource(hostileXlsx));
  assert.doesNotMatch(hostileResult.text, /must not be selected|untrusted/, 'relationship traversal cannot select an outside ZIP member');

  const textZip = zipSync({ 'README.md': strToU8('Plain archive text'), 'install.sh': strToU8('echo not executed') }, { level: 0 });
  const zipResult = await extractGenericZipContent(byteArrayZipSource(textZip));
  assert.match(zipResult.text, /Plain archive text/);
  assert.match(zipResult.text, /echo not executed/);
  assert.equal(zipResult.text.includes('not executed\n'), true, 'script-looking entries are data only');

  const traversalZip = zipSync({ '../secret.txt': strToU8('do not expose') }, { level: 0 });
  const traversalResult = await extractGenericZipContent(byteArrayZipSource(traversalZip));
  assert.match(traversalResult.text, /не прошёл структурные проверки/);
  assert.doesNotMatch(traversalResult.text, /do not expose/);

  const axml = makeAxml();
  const axmlText = parseAndroidBinaryManifest(axml);
  assert.match(axmlText, /package: com\.example\.fixture/);
  assert.match(axmlText, /signature, code and runtime behavior were not verified/);
  const apk = zipSync({ 'AndroidManifest.xml': axml, 'assets/notes.txt': strToU8('APK text asset') }, { level: 0 });
  const apkResult = await extractApkContent(byteArrayZipSource(apk));
  assert.match(apkResult.text, /package: com\.example\.fixture/);
  assert.match(apkResult.text, /APK text asset/);
  assert.match(apkResult.summary, /подпись и поведение не проверялись/);
  assert.doesNotMatch(apkResult.text, /install|INSTALL/i, 'APK parsing never runs or installs the archive');
  assert.throws(() => parseAndroidBinaryManifest(new Uint8Array(8)), /AXML_SIZE_LIMIT|AXML_NOT_BINARY_XML/);

  const corrupt = docx.slice();
  const nameLength = corrupt[26] | (corrupt[27] << 8);
  const extraLength = corrupt[28] | (corrupt[29] << 8);
  const payloadOffset = 30 + nameLength + extraLength;
  corrupt[payloadOffset] ^= 0x01;
  const corruptResult = await extractDocxContent(byteArrayZipSource(corrupt));
  assert.match(corruptResult.text, /не прошли локальные проверки/);

  const selected = await extractSelectedZipEntries(byteArrayZipSource(textZip), 'zip', name => name === 'README.md', { maxEntries: 1, maxEntryBytes: 100, maxTotalBytes: 100 });
  assert.equal(selected.ok, true);
  assert.equal(selected.entries.get('README.md').length, strToU8('Plain archive text').length);

  console.log('AIB_DOCUMENT_CONTENT_EXTRACTORS_SELFTEST_OK docx=extracted xlsx=extracted apk_manifest=decoded zip_text=extracted dtd=blocked traversal=blocked crc_tamper=blocked formulas=not_executed apk=not_installed');
})().catch(error => { console.error(error); process.exitCode = 1; });
`);
  const run = spawnSync(process.execPath, [harnessPath], { cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
  if (run.status !== 0) throw new Error(`document extraction harness failed (status=${run.status}):\n${run.stdout}\n${run.stderr}`);
  process.stdout.write(run.stdout);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
