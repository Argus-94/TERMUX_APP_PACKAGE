#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const script = path.join(root, 'scripts/autobuild/aib-autobuild.sh');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aib-v488-build-boundary-'));
try {
  const bin = path.join(temp, 'bin');
  fs.mkdirSync(bin);
  const calls = path.join(temp, 'calls');
  for (const tool of ['mkdir', 'pkg', 'apt-get', 'curl', 'wget', 'git', 'java', 'gradle', 'sdkmanager']) {
    fs.writeFileSync(path.join(bin, tool), `#!/bin/sh\nprintf '%s\\n' '${tool}' >> "$AIB_TEST_CALLS"\nexit 99\n`, { mode: 0o755 });
  }
  let count = 0;
  for (const [prefix, home, expected] of [
    ['', temp, 'AIB_PRIVATE_RUNTIME_REQUIRED'],
    ['/foreign/private/usr', '/foreign/private/home', 'AIB_PRIVATE_RUNTIME_REQUIRED'],
    ['/data/data/com.karat.aibuilder/files/usr', '/data/data/com.karat.aibuilder/files/home', 'AIB_PRIVATE_TOOLCHAIN_NOT_QUALIFIED'],
    ['/data/user/0/com.karat.aibuilder/files/usr', '/data/user/0/com.karat.aibuilder/files/home', 'AIB_PRIVATE_TOOLCHAIN_NOT_QUALIFIED'],
  ]) {
    for (const sourced of [false, true]) {
      const args = sourced ? ['-c', 'source "$1"; status=$?; printf "SOURCE_STATUS=%s\\n" "$status"; exit "$status"', 'fixture', script] : [script];
      const result = spawnSync('/bin/bash', args, {
        env: { PATH: bin, PREFIX: prefix, HOME: home, AIB_TEST_CALLS: calls, AIB_PRIVATE_ROOT: path.join(temp, 'forbidden-work'), AIB_AB_BACKEND: 'ubuntu-proot', AIB_PRIVATE_FEED_QUALIFIED: '1' },
        encoding: 'utf8', timeout: 3000,
      });
      assert.equal(result.status, 78, result.stderr || result.stdout);
      assert.match(result.stderr, new RegExp(expected));
      assert.ok(!fs.existsSync(calls), 'blocked operation invoked an external tool');
      assert.ok(!fs.existsSync(path.join(temp, 'forbidden-work')), 'blocked operation wrote workspace/cache files');
      count++;
    }
  }
  const generated = spawnSync(process.execPath, ['scripts/aib-gen-autobuild.mjs', '--check'], { cwd: root, encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr || generated.stdout);
  console.log(`AIB_V488_AUTOBUILD_BOUNDARY_OK actual_bash_cases=${count} no_IO=true no_env_bypass=true generated_in_sync=true device=NOT_RUN`);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
