/** Source-contract self-test for Phase 10 release artifact management. */
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const errors = [];
const src = read('lib/release-artifact-manager.ts');
const index = read('core/index.ts');
const pkg = JSON.parse(read('package.json'));

for (const token of [
  'createReleaseArtifact',
  'release-manifest.json',
  'qa-report.json',
  'SHA256SUM.txt',
  'checksums.txt',
  'zip -q -r',
  'tar -czf',
  'RELEASE_GATE_NOT_PASSED',
  'RELEASE_BUNDLE_CREATED',
]) if (!src.includes(token)) errors.push(`ARTIFACT_CONTRACT_MISSING:${token}`);
if (!index.includes('createReleaseArtifact')) errors.push('CORE_EXPORT_MISSING');
if (pkg.scripts?.['test:phase10-release-artifact'] !== 'node scripts/aib-phase10-release-artifact-selftest.mjs') errors.push('PACKAGE_SCRIPT_MISSING');
if (src.includes('Buffer.from')) errors.push('RN_BUFFER_DEPENDENCY_FORBIDDEN');

if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log(`AIB_PHASE10_RELEASE_ARTIFACT_SELFTEST_OK version=${pkg.version}`);
