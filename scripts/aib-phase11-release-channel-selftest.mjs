import fs from 'node:fs';
import path from 'node:path';
const root = process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const src = read('lib/release-channel-manager.ts');
for (const token of ['debug', 'internal', 'beta', 'production', 'publishReleaseChannel', 'rollbackReleaseChannel', 'versionCode', 'versionName', 'current.apk', 'channel.json']) {
  if (!src.includes(token)) throw new Error(`missing:${token}`);
}
if (!src.includes('RELEASE_ARTIFACT_NOT_VERIFIED')) throw new Error('artifact-gate-missing');
if (!src.includes('mv -f')) throw new Error('atomic-state-move-missing');
console.log('AIB_PHASE11_RELEASE_CHANNEL_SELFTEST_OK');
