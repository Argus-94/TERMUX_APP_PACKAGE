#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const script = path.join(root, 'scripts/aib-build-custom-termux-bootstrap.sh');
const sourceBuildPatch = fs.readFileSync(path.join(root, 'docs/termux-integration/termux-packages-host-build.patch'), 'utf8');
assert.match(sourceBuildPatch, /^\+\s*export TERMUX_APP_PACKAGE="\$TERMUX_APP__PACKAGE_NAME"$/m);
assert.match(sourceBuildPatch, /^\+\s*export TERMUX_PREFIX$/m);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aib-bootstrap-integration-'));
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.error) throw r.error;
  return r;
};
const write = (file, body, mode = 0o644) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  fs.chmodSync(file, mode);
};
try {
  const checkout = path.join(temp, 'termux-packages');
  fs.mkdirSync(path.join(checkout, 'scripts'), { recursive: true });
  write(path.join(checkout, 'scripts/properties.sh'), "TERMUX_APP__PACKAGE_NAME=\"com.karat.aibuilder\"\nTERMUX_APP_PACKAGE=\"$TERMUX_APP__PACKAGE_NAME\"\n");
  write(path.join(checkout, 'scripts/build-bootstraps.sh'), '#!/usr/bin/env bash\nexit 0\n', 0o755);
  write(path.join(checkout, 'clean.sh'), '#!/usr/bin/env bash\nexit 0\n', 0o755);
  write(path.join(checkout, 'scripts/run-docker.sh'), `#!/usr/bin/env bash\nset -euo pipefail\nif [[ "$1" == "./scripts/build-bootstraps.sh" ]]; then\n  mkdir -p bootstrap-output/bin\n  printf '#!/bin/sh\\necho fixture\\n' > bootstrap-output/bin/bash\n  chmod +x bootstrap-output/bin/bash\n  (cd bootstrap-output && zip -qr ../fixture-bootstrap.zip .)\nfi\n`, 0o755);
  assert.equal(run('git', ['init', '-q', checkout]).status, 0);
  run('git', ['-C', checkout, 'config', 'user.email', 'test@example.invalid']);
  run('git', ['-C', checkout, 'config', 'user.name', 'Integration Test']);
  run('git', ['-C', checkout, 'add', '.']);
  assert.equal(run('git', ['-C', checkout, 'commit', '-qm', 'fixture']).status, 0);
  const output = path.join(temp, 'out dir');
  const good = run('bash', [script, checkout], { env: { ...process.env, AIB_BOOTSTRAP_OUTPUT_DIR: output, AIB_TERMUX_ARCH: 'aarch64' } });
  assert.equal(good.status, 0, `fixture build failed:\n${good.stdout}\n${good.stderr}`);
  const archive = path.join(output, 'termux-bootstrap-aarch64.zip');
  assert.ok(fs.existsSync(archive), 'validated archive was not promoted');
  assert.ok(fs.existsSync(`${archive}.sha256`), 'SHA-256 sidecar missing');
  const manifest = JSON.parse(fs.readFileSync(`${archive}.provenance.json`, 'utf8'));
  assert.equal(manifest.applicationId, 'com.karat.aibuilder');
  assert.equal(manifest.architecture, 'aarch64');
  assert.equal(manifest.archiveStructureVerified, true);
  assert.equal(manifest.runtimeVerified, false);
  assert.equal(manifest.apkIntegrated, false);
  assert.match(manifest.archiveSha256, /^[a-f0-9]{64}$/);

  // Namespace mismatch must fail before either mocked Docker stage is executed.
  fs.writeFileSync(path.join(checkout, 'scripts/properties.sh'), 'TERMUX_APP__PACKAGE_NAME="com.termux"\nTERMUX_APP_PACKAGE="com.termux"\n');
  const bad = run('bash', [script, checkout], { env: { ...process.env, AIB_BOOTSTRAP_OUTPUT_DIR: path.join(temp, 'bad-out'), AIB_TERMUX_ARCH: 'aarch64' } });
  assert.notEqual(bad.status, 0, 'wrong application namespace was unexpectedly accepted');
  assert.match(bad.stderr, /TERMUX_APP__PACKAGE_NAME must be explicitly configured as com\.karat\.aibuilder/);
  console.log('PASS: custom bootstrap pipeline fixture builds, verifies and records provenance; namespace mismatch is rejected');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
