#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyPdfExtractorPatch } from './aib-apply-pdf-extractor-patch.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aib-pdf-patch-'));
try {
  const packageRoot = path.join(temp, 'node_modules/expo-pdf-text-extract');
  const nativePath = path.join(packageRoot, 'android/src/main/java/expo/modules/pdfextractor/PdfExtractorModule.kt');
  const templatePath = path.join(temp, 'plugins/PdfExtractorModuleSafe.kt');
  fs.mkdirSync(path.dirname(nativePath), { recursive: true });
  fs.mkdirSync(path.dirname(templatePath), { recursive: true });
  fs.writeFileSync(path.join(temp, 'package.json'), JSON.stringify({ dependencies: { 'expo-pdf-text-extract': '1.1.0' } }));
  fs.copyFileSync(path.join(root, 'node_modules/expo-pdf-text-extract/android/src/main/java/expo/modules/pdfextractor/PdfExtractorModule.kt'), nativePath);
  fs.copyFileSync(path.join(root, 'plugins/PdfExtractorModuleSafe.kt'), templatePath);

  const first = applyPdfExtractorPatch(temp);
  assert.ok(['patched', 'already_patched'].includes(first.status));
  const safe = fs.readFileSync(nativePath, 'utf8');
  assert.match(safe, /MAX_PDF_INPUT_BYTES/);
  assert.match(safe, /BoundedPdfWriter/);
  assert.equal(applyPdfExtractorPatch(temp).status, 'already_patched', 'a matching patched module should be idempotent');

  fs.writeFileSync(nativePath, `${safe}\n// drift`);
  assert.throws(() => applyPdfExtractorPatch(temp), /AIB_PDF_EXTRACTOR_UPSTREAM_DRIFT/, 'unexpected module changes must fail closed');
  fs.writeFileSync(nativePath, 'upstream changed');
  assert.throws(() => applyPdfExtractorPatch(temp), /AIB_PDF_EXTRACTOR_UPSTREAM_DRIFT/);

  const wrongVersionRoot = path.join(temp, 'wrong-version');
  fs.mkdirSync(path.join(wrongVersionRoot, 'node_modules/expo-pdf-text-extract/android/src/main/java/expo/modules/pdfextractor'), { recursive: true });
  fs.mkdirSync(path.join(wrongVersionRoot, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(wrongVersionRoot, 'package.json'), JSON.stringify({ dependencies: { 'expo-pdf-text-extract': '^1.1.0' } }));
  fs.copyFileSync(path.join(root, 'node_modules/expo-pdf-text-extract/android/src/main/java/expo/modules/pdfextractor/PdfExtractorModule.kt'), path.join(wrongVersionRoot, 'node_modules/expo-pdf-text-extract/android/src/main/java/expo/modules/pdfextractor/PdfExtractorModule.kt'));
  fs.copyFileSync(path.join(root, 'plugins/PdfExtractorModuleSafe.kt'), path.join(wrongVersionRoot, 'plugins/PdfExtractorModuleSafe.kt'));
  assert.throws(() => applyPdfExtractorPatch(wrongVersionRoot), /AIB_PDF_EXTRACTOR_VERSION_UNPINNED/);
  console.log('AIB_PDF_EXTRACTOR_PATCH_SELFTEST_OK source_pin=idempotent upstream_drift=blocked version_drift=blocked');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
