import fs from 'node:fs';
const shim = fs.readFileSync(new URL('../gradlew', import.meta.url), 'utf8');
if (!shim.includes('pnpm exec expo prebuild --platform android --no-install')) throw new Error('PNPM_PREBUILD_MISSING');
if (/\bnpx\s+expo\s+prebuild/.test(shim)) throw new Error('UNPINNED_NPX_PREBUILD');
if (!shim.includes('pnpm install --frozen-lockfile')) throw new Error('FROZEN_RETRY_MISSING');
if (!shim.includes('Never let npx fetch an unpinned Expo package')) throw new Error('NO_NPX_POLICY');
console.log('AIB_CBE_NO_NPX_SELFTEST_OK pinned=pnpm9.15.0 npx_prebuild=blocked frozen_retry=enabled');
