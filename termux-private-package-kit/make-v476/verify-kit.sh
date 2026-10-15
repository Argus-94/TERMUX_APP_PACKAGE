#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
export PYTHONDONTWRITEBYTECODE=1
python3 -m unittest discover -s tests -v
bash -n build-make-private-aarch64.sh
grep -Fq -- '-o /home/builder/termux-packages/output/.aib-private-make-debs' build-make-private-aarch64.sh
! grep -Fq 'export TERMUX_TOPDIR=' build-make-private-aarch64.sh
grep -Fq 'docker rm --force "$CONTAINER_NAME"' build-make-private-aarch64.sh
printf 'APPARMOR_BUILD_PATHS_OK\n'
python3 - <<'PY'
import ast, hashlib, json, pathlib
root = pathlib.Path('.')
manifest = json.loads((root / 'manifest.json').read_text(encoding='utf-8'))
assert manifest['status']['binaryPackageProduced'] is False
assert manifest['target']['applicationId'] == 'com.karat.aibuilder'
assert manifest['package']['name'] == 'make'
assert manifest['package']['version'] == '4.4.1-1'
for source in ('audit_deb.py', 'patch_properties.py', 'tests/test_audit_deb.py'):
    ast.parse((root / source).read_text(encoding='utf-8'), filename=source)
for rel, key in (
    ('upstream/termux-packages/packages/make/build.sh', 'packageRecipeSha256'),
    ('upstream/termux-packages/packages/make/src-job.c.patch', 'recipePatchSha256'),
):
    digest = hashlib.sha256((root / rel).read_bytes()).hexdigest()
    expected = manifest['upstreamSource'][key]
    if digest != expected:
        raise SystemExit(f'SOURCE_LOCK_MISMATCH {rel}: {digest} != {expected}')
print('STATIC_LOCKS_AND_MANIFEST_OK')
PY
(cd upstream/termux-packages && sha256sum -c SHA256SUMS)
printf 'VERIFY_KIT_OK\n'
