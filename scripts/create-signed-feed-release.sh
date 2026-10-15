#!/usr/bin/env bash
set -Eeuo pipefail
umask 022

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(realpath "${SCRIPT_DIR}/..")"
MANIFEST="${PROJECT_ROOT}/keys/feed-signing.json"

fail() { printf 'ERROR:%s\n' "$*" >&2; exit 2; }

[[ $# -eq 2 ]] || fail 'USAGE: create-signed-feed-release.sh <apt-repo-root> <aarch64|amd64>'
REPO_ROOT="$(realpath -e -- "$1")"
ARCH="$2"
case "$ARCH" in aarch64|amd64) ;; *) fail 'ARCHITECTURE_NOT_ALLOWLISTED';; esac
[[ -f "$MANIFEST" ]] || fail 'SIGNING_MANIFEST_MISSING'
[[ -n "${GNUPGHOME:-}" && -d "$GNUPGHOME" ]] || fail 'GNUPGHOME_REQUIRED'
command -v gpg >/dev/null 2>&1 || fail 'GPG_REQUIRED'
command -v gpgv >/dev/null 2>&1 || fail 'GPGV_REQUIRED'
command -v python3 >/dev/null 2>&1 || fail 'PYTHON3_REQUIRED'
command -v sha256sum >/dev/null 2>&1 || fail 'SHA256SUM_REQUIRED'

readarray -t KEY_INFO < <(python3 - "$MANIFEST" <<'PY'
import json, pathlib, re, sys
m=json.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))
fpr=m.get('fingerprint','')
asset=m.get('publicKeyring','')
digest=m.get('publicKeyringSha256','')
if not re.fullmatch(r'[A-F0-9]{40}', fpr): raise SystemExit('BAD_FINGERPRINT')
if not re.fullmatch(r'[a-f0-9]{64}', digest): raise SystemExit('BAD_KEYRING_SHA256')
if not asset or pathlib.PurePosixPath(asset).is_absolute() or '..' in pathlib.PurePosixPath(asset).parts:
    raise SystemExit('BAD_KEYRING_PATH')
print(fpr)
print(asset)
print(digest)
PY
) || fail 'SIGNING_MANIFEST_INVALID'
EXPECTED_FPR="${KEY_INFO[0]}"
PUBLIC_KEYRING="${PROJECT_ROOT}/${KEY_INFO[1]}"
EXPECTED_KEYRING_SHA256="${KEY_INFO[2]}"
[[ -f "$PUBLIC_KEYRING" ]] || fail 'PUBLIC_KEYRING_MISSING'
ACTUAL_KEYRING_SHA256="$(sha256sum "$PUBLIC_KEYRING" | awk '{print $1}')"
[[ "$ACTUAL_KEYRING_SHA256" == "$EXPECTED_KEYRING_SHA256" ]] || fail 'PUBLIC_KEYRING_HASH_MISMATCH'

SECRET_FPRS="$(gpg --batch --with-colons --list-secret-keys 2>/dev/null | awk -F: '$1 == "fpr" {print $10}')"
grep -Fxq "$EXPECTED_FPR" <<<"$SECRET_FPRS" || fail 'SIGNING_SECRET_FINGERPRINT_MISMATCH'

INDEX_DIR="${REPO_ROOT}/dists/stable/main/binary-${ARCH}"
PACKAGES="${INDEX_DIR}/Packages"
PACKAGES_GZ="${INDEX_DIR}/Packages.gz"
[[ -s "$PACKAGES" && -s "$PACKAGES_GZ" ]] || fail 'PACKAGES_INDEX_MISSING'
gzip -t "$PACKAGES_GZ" >/dev/null 2>&1 || fail 'PACKAGES_GZ_INVALID'
gzip -cd "$PACKAGES_GZ" | cmp -s - "$PACKAGES" || fail 'PACKAGES_GZ_CONTENT_MISMATCH'

python3 - "$REPO_ROOT" "$PACKAGES" "$ARCH" <<'PY'
import hashlib, pathlib, sys
root=pathlib.Path(sys.argv[1]).resolve()
index=pathlib.Path(sys.argv[2])
arch=sys.argv[3]
text=index.read_text(encoding='utf-8', errors='strict')
records=[]
for raw in text.strip().split('\n\n') if text.strip() else []:
    fields={}
    previous=None
    for line in raw.splitlines():
        if line[:1] in (' ', '\t'):
            if previous is None: raise SystemExit('INDEX_ORPHAN_CONTINUATION')
            fields[previous] += '\n' + line
            continue
        key, sep, value=line.partition(':')
        if not sep or key in fields: raise SystemExit('INDEX_BAD_OR_DUPLICATE_FIELD')
        fields[key]=value.strip()
        previous=key
    for required in ('Package','Version','Architecture','Filename','Size','SHA256'):
        if required not in fields: raise SystemExit('INDEX_FIELD_MISSING:'+required)
    if fields['Architecture'] not in (arch,'all'):
        raise SystemExit('INDEX_ARCHITECTURE_MISMATCH:'+fields['Package'])
    rel=pathlib.PurePosixPath(fields['Filename'])
    if rel.is_absolute() or rel.parts[:2] != ('pool','main') or '..' in rel.parts:
        raise SystemExit('INDEX_FILENAME_OUTSIDE_POOL:'+fields['Filename'])
    path=root.joinpath(*rel.parts)
    resolved=path.resolve(strict=True)
    if root not in resolved.parents or path.is_symlink() or not path.is_file():
        raise SystemExit('INDEX_FILE_NOT_REGULAR_INSIDE_REPO:'+fields['Filename'])
    if path.stat().st_size != int(fields['Size']):
        raise SystemExit('INDEX_FILE_SIZE_MISMATCH:'+fields['Filename'])
    digest=hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != fields['SHA256']:
        raise SystemExit('INDEX_FILE_SHA256_MISMATCH:'+fields['Filename'])
    records.append((fields['Package'],fields['Version'],fields['Architecture'],rel.as_posix()))
keys=[record[:3] for record in records]
if len(keys) != len(set(keys)): raise SystemExit('DUPLICATE_PACKAGE_VERSION_ARCHITECTURE')
indexed={record[3] for record in records}
pool=root/'pool'
all_debs={p.relative_to(root).as_posix() for p in pool.rglob('*.deb') if p.is_file() and not p.is_symlink()}
if indexed != all_debs:
    missing=sorted(all_debs-indexed)[:3]
    absent=sorted(indexed-all_debs)[:3]
    raise SystemExit(f'INDEX_POOL_SET_MISMATCH:unindexed={missing}:missing={absent}')
if not records: raise SystemExit('EMPTY_PACKAGE_INDEX')
print(f'INDEX_PACKAGE_RECORDS_OK count={len(records)} architecture={arch}')
PY

TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/aib-feed-release.XXXXXX")"
trap 'rm -rf -- "$TEMP_DIR"' EXIT
INDEX_SHA256="$(sha256sum "$PACKAGES" | awk '{print $1}')"
INDEX_SIZE="$(stat -c '%s' "$PACKAGES")"
GZIP_SHA256="$(sha256sum "$PACKAGES_GZ" | awk '{print $1}')"
GZIP_SIZE="$(stat -c '%s' "$PACKAGES_GZ")"
DATE_UTC="$(date -Ru)"
VALID_UNTIL="$(date -Ru -d '+30 days')"
DIST_DIR="${REPO_ROOT}/dists/stable"
RELEASE_TMP="${TEMP_DIR}/Release"
{
  printf 'Origin: AI Builder Termux\n'
  printf 'Label: termux-main\n'
  printf 'Suite: stable\n'
  printf 'Codename: stable\n'
  printf 'Date: %s\n' "$DATE_UTC"
  printf 'Valid-Until: %s\n' "$VALID_UNTIL"
  printf 'Architectures: %s\n' "$ARCH"
  printf 'Components: main\n'
  printf 'Description: App-compatible Termux packages for com.karat.aibuilder\n'
  printf 'SHA256:\n'
  printf ' %s %s main/binary-%s/Packages\n' "$INDEX_SHA256" "$INDEX_SIZE" "$ARCH"
  printf ' %s %s main/binary-%s/Packages.gz\n' "$GZIP_SHA256" "$GZIP_SIZE" "$ARCH"
} > "$RELEASE_TMP"

mkdir -p "$DIST_DIR"
cp -- "$RELEASE_TMP" "${DIST_DIR}/Release.tmp"
gpg --batch --yes --pinentry-mode loopback --passphrase '' --local-user "$EXPECTED_FPR" \
  --clearsign --output "${DIST_DIR}/InRelease.tmp" "${DIST_DIR}/Release.tmp"
gpg --batch --yes --pinentry-mode loopback --passphrase '' --local-user "$EXPECTED_FPR" \
  --detach-sign --output "${DIST_DIR}/Release.gpg.tmp" "${DIST_DIR}/Release.tmp"

mv -- "${DIST_DIR}/Release.tmp" "${DIST_DIR}/Release"
mv -- "${DIST_DIR}/InRelease.tmp" "${DIST_DIR}/InRelease"
mv -- "${DIST_DIR}/Release.gpg.tmp" "${DIST_DIR}/Release.gpg"
cp -- "${DIST_DIR}/Release" "${REPO_ROOT}/Release"
chmod 644 "${DIST_DIR}/Release" "${DIST_DIR}/InRelease" "${DIST_DIR}/Release.gpg" "${REPO_ROOT}/Release"
gpgv --keyring "$PUBLIC_KEYRING" "${DIST_DIR}/Release.gpg" "${DIST_DIR}/Release" >/dev/null
gpgv --keyring "$PUBLIC_KEYRING" "${DIST_DIR}/InRelease" >/dev/null
printf 'SIGNED_FEED_RELEASE_OK packages=%s arch=%s fingerprint=%s index_sha256=%s\n' \
  "$(grep -c '^Package:' "$PACKAGES")" "$ARCH" "$EXPECTED_FPR" "$INDEX_SHA256"
