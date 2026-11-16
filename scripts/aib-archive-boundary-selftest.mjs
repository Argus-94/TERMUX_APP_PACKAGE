#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const packs = fs.readFileSync(path.join(root, 'lib/termux-packs.ts'), 'utf8');
const agent = fs.readFileSync(path.join(root, 'lib/termux-agent.ts'), 'utf8');
const importer = fs.readFileSync(path.join(root, 'lib/project-source-import.ts'), 'utf8');
const builtin = fs.readFileSync(path.join(root, 'lib/builtin-build-script.ts'), 'utf8');

const zipGuardMatch = packs.match(/const SAFE_ZIP_EXTRACT_CHECK\s*=\s*`([\s\S]*?)`;/);
const tarGuardMatch = packs.match(/const SAFE_TAR_EXTRACT_CHECK\s*=\s*`([\s\S]*?)`\s*;/);
assert.ok(zipGuardMatch, 'production SAFE_ZIP_EXTRACT_CHECK template missing');
assert.ok(tarGuardMatch, 'production SAFE_TAR_EXTRACT_CHECK template missing');
for (const token of ['2147483648', '8589934592', '100000', 'zip special/link member is forbidden']) {
  assert.ok(packs.includes(token), `tool-pack archive guard missing ${token}`);
}
assert.ok(packs.includes('unsafe tar special/link member'), 'tar special/link guard missing');

const analyzerStart = agent.indexOf('// Analyze sources in archive/folder');
const analyzerValidation = agent.indexOf('SAFE_PROJECT_ZIP_CHECK', analyzerStart);
const analyzerExtract = agent.indexOf('unzip -oq "$SRC" -d "$STAGE"', analyzerStart);
assert.ok(analyzerStart >= 0 && analyzerValidation > analyzerStart, 'source analysis must invoke the shared ZIP validator');
assert.ok(analyzerExtract > analyzerValidation, 'ZIP validation must happen before source-analysis extraction');
assert.ok(agent.includes('buildProjectArchiveValidationCommand()'), 'agent must use the shared validator');
assert.ok(importer.includes('buildProjectArchiveValidationCommand()'), 'visible project import must use the same validator');
assert.ok(importer.indexOf('buildProjectArchiveValidationCommand()') < importer.indexOf('unzip -oq "$SRC" -d "$TREE"'), 'visible project import must validate before extraction');
assert.ok(builtin.includes('buildProjectArchiveValidationCommand()'), 'built-in ZIP build script must embed the shared archive validator');
assert.ok(builtin.includes('return buildValidatedBuiltinScript();'), 'built-in script is generated through the guarded extraction builder');
const generatedBuiltin = execFileSync(process.execPath, [
  '--experimental-strip-types',
  '--input-type=module',
  '-e',
  `import { getBuiltinBuildScript } from ${JSON.stringify(pathToFileURL(path.join(root, 'lib/builtin-build-script.ts')).href)}; process.stdout.write(getBuiltinBuildScript());`,
], { cwd: root, encoding: 'utf8' });
assert.ok(generatedBuiltin.indexOf('unzip -tqq "$SRC"') >= 0, 'generated built-in script contains the shared ZIP integrity check');
assert.ok(generatedBuiltin.indexOf('PROJECT_ARCHIVE_UNSAFE_MEMBER') < generatedBuiltin.indexOf('unzip -q "$ZIP" -d "$EXTRACT_DIR"'), 'generated built-in script validates member paths before extraction');
const generatedSyntax = spawnSync('bash', ['-n'], { input: generatedBuiltin, encoding: 'utf8' });
assert.equal(generatedSyntax.status, 0, `generated built-in script must parse: ${generatedSyntax.stderr}`);

const helperUrl = pathToFileURL(path.join(root, 'lib/project-source-import.ts')).href;
const validator = execFileSync(process.execPath, [
  '--experimental-strip-types',
  '--input-type=module',
  '-e',
  `import { buildProjectArchiveValidationCommand } from ${JSON.stringify(helperUrl)}; process.stdout.write(buildProjectArchiveValidationCommand());`,
], { cwd: root, encoding: 'utf8' });
assert.match(validator, /unzip -tqq/);
assert.match(validator, /PROJECT_ARCHIVE_UNSAFE_MEMBER/);
assert.match(validator, /PROJECT_ARCHIVE_LINK_OR_SPECIAL_FILE_DENIED/);
assert.match(validator, /PROJECT_ARCHIVE_SIZE_LIMIT_EXCEEDED/);

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aib-archive-'));
const shellQuote = (value) => `'${value.replace(/'/g, `'\\''`)}'`;
const run = (script) => spawnSync('bash', ['-c', script], { cwd: temp, encoding: 'utf8' });
const runProjectValidator = (archive) => run(`SRC=${shellQuote(archive)}\n${validator}`);
const runPackGuard = (template, archive) => run(template.replaceAll('ARCHIVE_PATH', archive));

try {
  const safeRoot = path.join(temp, 'safe');
  fs.mkdirSync(safeRoot);
  fs.writeFileSync(path.join(safeRoot, 'ok.txt'), 'ok');
  const safeZip = path.join(temp, 'safe.zip');
  execFileSync('zip', ['-q', '-r', safeZip, 'safe'], { cwd: temp });

  const traversalZip = path.join(temp, 'traversal.zip');
  execFileSync('python3', ['-c', "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],'w'); z.writestr('../escape.txt','x'); z.close()", traversalZip]);

  const linkRoot = path.join(temp, 'links');
  fs.mkdirSync(linkRoot);
  fs.symlinkSync('../outside.txt', path.join(linkRoot, 'escape'));
  const linkZip = path.join(temp, 'links.zip');
  execFileSync('zip', ['-q', '-y', '-r', linkZip, 'links'], { cwd: temp });

  const corruptZip = path.join(temp, 'corrupt.zip');
  fs.writeFileSync(corruptZip, 'not a zip archive');

  assert.equal(runProjectValidator(safeZip).status, 0, 'production project ZIP validator must accept a safe archive');
  assert.notEqual(runProjectValidator(traversalZip).status, 0, 'production project ZIP validator must reject traversal');
  assert.notEqual(runProjectValidator(linkZip).status, 0, 'production project ZIP validator must reject symlinks');
  assert.notEqual(runProjectValidator(corruptZip).status, 0, 'production project ZIP validator must reject corrupt archives');

  assert.equal(runPackGuard(zipGuardMatch[1].replaceAll('ARCHIVE_PATH', safeZip)).status, 0, 'production tool-pack ZIP guard must accept safe archive');
  assert.notEqual(runPackGuard(zipGuardMatch[1].replaceAll('ARCHIVE_PATH', traversalZip)).status, 0, 'production tool-pack ZIP guard must reject traversal');
  assert.notEqual(runPackGuard(zipGuardMatch[1].replaceAll('ARCHIVE_PATH', linkZip)).status, 0, 'production tool-pack ZIP guard must reject symlink');

  const safeTarRoot = path.join(temp, 'tar-safe');
  fs.mkdirSync(safeTarRoot);
  fs.writeFileSync(path.join(safeTarRoot, 'ok.txt'), 'ok');
  const safeTar = path.join(temp, 'safe.tar');
  execFileSync('tar', ['-cf', safeTar, '-C', safeTarRoot, 'ok.txt']);

  const badTarRoot = path.join(temp, 'tar-links');
  fs.mkdirSync(badTarRoot);
  fs.symlinkSync('../outside.txt', path.join(badTarRoot, 'escape'));
  const badTar = path.join(temp, 'bad.tar');
  execFileSync('tar', ['-cf', badTar, '-C', badTarRoot, 'escape']);

  const fifoRoot = path.join(temp, 'tar-fifo');
  fs.mkdirSync(fifoRoot);
  execFileSync('mkfifo', [path.join(fifoRoot, 'pipe')]);
  const fifoTar = path.join(temp, 'fifo.tar');
  execFileSync('tar', ['-cf', fifoTar, '-C', fifoRoot, 'pipe']);

  assert.equal(runPackGuard(tarGuardMatch[1], safeTar).status, 0, 'production tool-pack TAR guard must accept safe archive');
  assert.notEqual(runPackGuard(tarGuardMatch[1], badTar).status, 0, 'production tool-pack TAR guard must reject symlink');
  assert.notEqual(runPackGuard(tarGuardMatch[1], fifoTar).status, 0, 'production tool-pack TAR guard must reject special files');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log('AIB_ARCHIVE_BOUNDARY_SELFTEST_OK production_project_zip=checked toolpack_zip_tar=checked traversal=blocked links=blocked special_files=blocked size_limits=8GB/2GB/100k');
