#!/usr/bin/env python3
"""Run real pinned wrapper setup, stopping before any actual container or compilation."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SOURCE = Path(os.environ['AIB_PINNED_SOURCE_ROOT']) if os.environ.get('AIB_PINNED_SOURCE_ROOT') else None
IMAGE = 'ghcr.io/termux/package-builder@sha256:44999857244619e25bc8e3427904a16d36cc0c0e087704af039e5bdf94814ac9'
MANIFESTS = {
    'cmake-ninja': 'cmake-ninja-candidate-package-set.json',
    'curl-v8.23.0': 'curl-candidate-package-set.json',
    'gh-v2.102.0': 'gh-candidate-package-set.json',
    'git-v2.56.0': 'git-candidate-package-set.json',
    'make-v476': 'candidate-package-set.json',
    'nodejs-npm': 'nodejs-npm-candidate-package-set.json',
    'openjdk17': 'openjdk17-candidate-package-set.json',
    'pkg-config-v0.29.2': 'pkg-config-candidate-package-set.json',
    'python-v3.14.6': 'python-candidate-package-set.json',
    'wget-v1.25.0': 'wget-candidate-package-set.json',
}

@unittest.skipUnless(SOURCE and SOURCE.is_dir(), 'requires exact pinned source checkout')
class WrapperPreflightTests(unittest.TestCase):
    def test_all_real_wrappers_reach_blocked_docker_boundary_without_packages(self):
        for kit, manifest in MANIFESTS.items():
            with self.subTest(profile=kit), tempfile.TemporaryDirectory(prefix='aib-wrapper-fixture-') as temp:
                temp = Path(temp)
                tools = temp / 'tools'; tools.mkdir()
                marker = temp / 'docker-boundary'
                docker = tools / 'docker'
                docker.write_text('''#!/usr/bin/env bash
set -eu
case "${1:-}:${2:-}" in
 info:*|image:inspect) exit 0 ;;
 container:inspect) exit 1 ;;
 *) printf 'AIB_TEST_CONTAINER_BLOCKED\n' > "$AIB_TEST_BOUNDARY"; exit 77 ;;
esac
''')
                docker.chmod(0o755)
                df = tools / 'df'
                df.write_text('''#!/usr/bin/env bash
printf 'Filesystem 1B-blocks Used Available Use%% Mounted\n'
printf 'synthetic-fixture 999999999999 0 %s 0%% /\n' "$AIB_TEST_FREE_BYTES"
''')
                df.chmod(0o755)
                env = os.environ.copy()
                env.update(PATH=str(tools) + os.pathsep + env['PATH'],
                           AIB_TERMUX_APP_DATA_DIR='/data/user/0/com.karat.aibuilder',
                           AIB_TERMUX_PREFIX='/data/user/0/com.karat.aibuilder/files/usr',
                           AIB_TERMUX_BUILDER_IMAGE_REF=IMAGE,
                           AIB_TEST_BOUNDARY=str(marker),
                           AIB_TEST_FREE_BYTES=str(12 * 1024**3))
                wrapper = next((ROOT/'termux-private-package-kit'/kit).glob('build-*.sh'))
                output = temp / 'output'
                args = [str(SOURCE), str(output)] if kit == 'make-v476' else [str(SOURCE), str(ROOT/manifest), str(output)]
                result = subprocess.run(['bash', str(wrapper), *args], env=env, capture_output=True, text=True, timeout=120)
                self.assertNotEqual(result.returncode, 0, 'fake Docker must block before actual build')
                self.assertTrue(marker.exists(), (result.stdout + result.stderr)[-5000:])
                self.assertFalse(list(output.glob('packages/*.deb')))
                # Verify-only must have been reached on each real private worktree.
                self.assertGreaterEqual(result.stdout.count('"ancestorPayloadOmitted": true'), 2)
                self.assertNotIn('PATCH_SCOPE_MISMATCH', result.stdout + result.stderr)
                self.assertNotIn('unbound variable', result.stdout + result.stderr)

if __name__ == '__main__':
    unittest.main()
