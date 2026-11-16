#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const expectedVersion = '1.1.0';
const expectedUpstreamSha256 = 'd1b00a7f88258a408da8ba5a1ba6dad4ae58c225041f5ecdb3341ccc1d80d5f9';
const packageRoot = path.join(root, 'node_modules', 'expo-pdf-text-extract');
const target = path.join(packageRoot, 'android/src/main/java/expo/modules/pdfextractor/PdfExtractorModule.kt');
const template = path.join(root, 'plugins/PdfExtractorModuleSafe.kt');
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

export function applyPdfExtractorPatch(projectRoot = root) {
  const manifestPath = path.join(projectRoot, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.dependencies?.['expo-pdf-text-extract'] !== expectedVersion) {
    throw new Error('AIB_PDF_EXTRACTOR_VERSION_UNPINNED');
  }
  const moduleRoot = path.join(projectRoot, 'node_modules', 'expo-pdf-text-extract');
  const nativePath = path.join(moduleRoot, 'android/src/main/java/expo/modules/pdfextractor/PdfExtractorModule.kt');
  const templatePath = path.join(projectRoot, 'plugins/PdfExtractorModuleSafe.kt');
  const upstream = fs.readFileSync(nativePath);
  const safeSource = fs.readFileSync(templatePath);
  const currentHash = sha256(upstream);
  const safeHash = sha256(safeSource);
  if (currentHash === safeHash) return { status: 'already_patched', sha256: safeHash };
  if (currentHash !== expectedUpstreamSha256) throw new Error('AIB_PDF_EXTRACTOR_UPSTREAM_DRIFT');
  const sourceText = safeSource.toString('utf8');
  for (const marker of ['MAX_PDF_INPUT_BYTES', 'MAX_PDF_STORAGE_BYTES', 'MAX_PDF_PAGES', 'BoundedPdfWriter', 'PDF could not be safely extracted']) {
    if (!sourceText.includes(marker)) throw new Error('AIB_PDF_EXTRACTOR_PATCH_INCOMPLETE');
  }
  const temporary = `${nativePath}.aib-${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, safeSource, { mode: 0o644, flag: 'wx' });
    fs.renameSync(temporary, nativePath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  const writtenHash = sha256(fs.readFileSync(nativePath));
  if (writtenHash !== safeHash) throw new Error('AIB_PDF_EXTRACTOR_PATCH_WRITE_FAILED');
  return { status: 'patched', sha256: safeHash };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = applyPdfExtractorPatch();
    console.log(`AIB_PDF_EXTRACTOR_PATCH_OK ${result.status} sha256=${result.sha256}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'AIB_PDF_EXTRACTOR_PATCH_FAILED');
    process.exitCode = 1;
  }
}
