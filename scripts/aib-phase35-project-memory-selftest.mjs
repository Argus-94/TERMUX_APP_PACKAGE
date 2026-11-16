import fs from 'node:fs';
const root = new URL('..', import.meta.url).pathname;
const file = `${root}core/workspace/AIProjectMemory.ts`;
const test = `${root}core/workspace/AIProjectMemory.test.ts`;
if (!fs.existsSync(file) || !fs.existsSync(test)) throw new Error('PHASE35_MEMORY_FILES_MISSING');
const source = fs.readFileSync(file,'utf8');
for (const marker of ['schemaVersion: 1','successfulFixes','knownErrors','testHistory','[redacted]']) if (!source.includes(marker)) throw new Error(`PHASE35_MEMORY_MARKER_MISSING:${marker}`);
console.log('AIB_PHASE35_PROJECT_MEMORY_SELFTEST_OK');
