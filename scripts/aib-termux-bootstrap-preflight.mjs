#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const [checkoutArg, appId = 'com.karat.aibuilder', abi = 'aarch64'] = process.argv.slice(2);
const fail = (message) => { console.error(`FAIL: ${message}`); process.exit(2); };
if (!checkoutArg) fail('Usage: node scripts/aib-termux-bootstrap-preflight.mjs /path/to/termux-packages [applicationId] [abi]');
if (appId !== 'com.karat.aibuilder') fail(`Unexpected app ID: ${appId}`);
if (!['aarch64', 'arm', 'i686', 'x86_64'].includes(abi)) fail(`Unsupported ABI: ${abi}`);
const checkout = path.resolve(checkoutArg);
const properties = path.join(checkout, 'scripts', 'properties.sh');
for (const file of [path.join(checkout, '.git'), properties, path.join(checkout, 'scripts', 'build-bootstraps.sh'), path.join(checkout, 'scripts', 'run-docker.sh'), path.join(checkout, 'clean.sh')]) {
  if (!fs.existsSync(file)) fail(`Required upstream path is missing: ${file}`);
}
const source = fs.readFileSync(properties, 'utf8');
const current = [...source.matchAll(/^\s*TERMUX_APP__PACKAGE_NAME\s*=\s*["']([^"']+)["']/gm)];
const alias = [...source.matchAll(/^\s*TERMUX_APP_PACKAGE\s*=\s*["']([^"']+)["']/gm)];
if (current.length !== 1 || current[0][1] !== appId) fail(`Expected exactly one TERMUX_APP__PACKAGE_NAME=${appId}`);
if (alias.length !== 1 || ![appId, '$TERMUX_APP__PACKAGE_NAME'].includes(alias[0][1])) fail(`Expected exactly one deprecated TERMUX_APP_PACKAGE synchronized to ${appId}`);
const commit = spawnSync('git', ['-C', checkout, 'rev-parse', '--verify', 'HEAD'], { encoding: 'utf8' });
if (commit.status !== 0 || !/^[0-9a-f]{40,64}\s*$/i.test(commit.stdout)) fail('Cannot determine upstream source commit');
console.log(JSON.stringify({ ok: true, applicationId: appId, abi, sourceCommit: commit.stdout.trim(), checks: ['git-checkout', 'upstream-build-scripts', 'unique-current-package-name', 'legacy-alias-synchronized'] }, null, 2));
