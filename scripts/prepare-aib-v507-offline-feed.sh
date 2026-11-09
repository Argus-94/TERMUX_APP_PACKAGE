#!/usr/bin/env bash
set -Eeuo pipefail
umask 022
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
KIT="$ROOT/termux-private-package-kit/v507"
LOCK="$KIT/package-lock.json"
AUDIT="$ROOT/scripts/validate-aib-v507-offline-bundle.py"
PIN='505e06ef0c8dbd7611abfb90e9eb60826dcd01d7'
IMAGE='ghcr.io/termux/package-builder@sha256:44999857244619e25bc8e3427904a16d36cc0c0e087704af039e5bdf94814ac9'
fail(){ printf 'AIB_V507_BUILD_REJECTED:%s\n' "$1" >&2; exit 2; }
[[ $# -eq 2 ]] || fail 'USAGE: prepare-aib-v507-offline-feed.sh PINNED_SOURCE_ROOT EMPTY_OUTPUT_ROOT'
SRC="$(realpath -e -- "$1")"; OUT="$(realpath -m -- "$2")"; STATUS="$KIT/bootstrap.status"
[[ -d "$SRC/.git" && "$(git -C "$SRC" rev-parse HEAD)" == "$PIN" ]] || fail 'SOURCE_COMMIT_MISMATCH'
[[ -z "$(git -C "$SRC" status --porcelain=v1)" ]] || fail 'SOURCE_CHECKOUT_NOT_CLEAN'
[[ "${AIB_TERMUX_BUILDER_IMAGE_REF:-$IMAGE}" == "$IMAGE" ]] || fail 'BUILDER_IMAGE_PIN_MISMATCH'
for t in docker dpkg-scanpackages dpkg-deb sha256sum python3 patch gzip; do command -v "$t" >/dev/null || fail "TOOL_MISSING_$t"; done
[[ -f "$STATUS" && ! -L "$STATUS" ]] || fail 'PINNED_BOOTSTRAP_STATUS_REQUIRED'
if [[ -e "$OUT" ]]; then [[ -d "$OUT" && -z "$(find "$OUT" -mindepth 1 -maxdepth 1 -print -quit)" ]] || fail 'OUTPUT_MUST_BE_NEW_OR_EMPTY'; else mkdir -p "$OUT"; fi
free="$(df -PB1 "$OUT" | awk 'END{print $4}')"; [[ "$free" =~ ^[0-9]+$ ]] && ((free>=3221225472)) || fail 'LESS_THAN_3_GIB_FREE'
docker info >/dev/null 2>&1 || fail 'DOCKER_DAEMON_UNAVAILABLE'
docker image inspect "$IMAGE" >/dev/null 2>&1 || fail 'PINNED_BUILDER_IMAGE_NOT_PREPULLED'
python3 - "$LOCK" "$SRC" "$ROOT" "$STATUS" <<'PY'
import hashlib,json,pathlib,subprocess,sys
lock=json.loads(pathlib.Path(sys.argv[1]).read_text()); src=pathlib.Path(sys.argv[2]); root=pathlib.Path(sys.argv[3]); status=pathlib.Path(sys.argv[4]); pin=lock['sourceCommit']
assert lock['applicationId']=='com.karat.aibuilder' and lock['prefix']=='/data/data/com.karat.aibuilder/files/usr'
assert lock['bootstrap']['statusFile']=='termux-private-package-kit/v507/bootstrap.status', 'BOOTSTRAP_STATUS_PATH_MISMATCH'
assert status.resolve()==(root/lock['bootstrap']['statusFile']).resolve(), 'BOOTSTRAP_STATUS_PATH_MISMATCH'
assert hashlib.sha256(status.read_bytes()).hexdigest()==lock['bootstrap']['statusSha256'], 'BOOTSTRAP_STATUS_PIN_MISMATCH'
for rel,digest in lock['sourceInfrastructure'].items():
 b=subprocess.run(['git','-C',str(src),'show',pin+':'+rel],check=True,capture_output=True).stdout
 assert hashlib.sha256(b).hexdigest()==digest, 'SOURCE_INFRA_HASH_MISMATCH:'+rel
for pkg in lock['packages']:
 b=subprocess.run(['git','-C',str(src),'show',pin+':'+pkg['recipePath']],check=True,capture_output=True).stdout
 assert hashlib.sha256(b).hexdigest()==pkg['recipeSha256'], 'PINNED_RECIPE_HASH_MISMATCH:'+pkg['name']
 for item in pkg['upstreamPatches']:
  b=subprocess.run(['git','-C',str(src),'show',pin+':'+item['path']],check=True,capture_output=True).stdout
  assert hashlib.sha256(b).hexdigest()==item['sha256'], 'PINNED_UPSTREAM_PATCH_HASH_MISMATCH:'+item['path']
 for item in pkg['localPatches']:
  f=root/item['path']; assert hashlib.sha256(f.read_bytes()).hexdigest()==item['sha256'], 'LOCAL_PATCH_HASH_MISMATCH:'+item['path']
print('PINNED_SOURCE_RECIPE_PATCH_BOOTSTRAP_STATUS_HASHES_OK packages='+str(len(lock['packages'])))
PY
cp -- "$STATUS" "$OUT/bootstrap-status"
WORK="$OUT/work/termux-packages"
git clone --shared --dissociate --no-checkout "$SRC" "$WORK" >/dev/null
git -C "$WORK" checkout --quiet --detach "$PIN"
for pkg in termux-auth openssh perl; do mkdir -p "$WORK/packages/$pkg"; done
cp "$KIT/patches/termux-auth-app-private.patch" "$WORK/packages/termux-auth/0001-karat-private-prefix.patch"
cp "$KIT/patches/perl-karat-doc-path.patch" "$WORK/packages/perl/0001-karat-android-doc-path.patch"
patch --dry-run --batch --forward --silent --fuzz=0 -p1 -d "$WORK" < "$KIT/patches/openssh-karat-service-path.patch"
patch --batch --forward --silent --fuzz=0 -p1 -d "$WORK" < "$KIT/patches/openssh-karat-service-path.patch"
python3 "$ROOT/termux-private-package-kit/make-v476/patch_properties.py" "$WORK/scripts/properties.sh" --data-dir /data/data/com.karat.aibuilder --prefix /data/data/com.karat.aibuilder/files/usr
mkdir -p "$OUT/feed" "$OUT/packages"
python3 "$AUDIT" verify-base --source "$ROOT/apt/termux-main" --index "$ROOT/apt/termux-main/dists/stable/main/binary-aarch64/Packages" --out "$OUT/feed"
printf 'AIB_V507_PINNED_BUILD_BEGIN source=%s image=%s app=com.karat.aibuilder prefix=/data/data/com.karat.aibuilder/files/usr\n' "$PIN" "$IMAGE" | tee "$OUT/build.log"
for pkg in ttf-dejavu xorg-util-macros xorgproto termux-auth openssh perl; do
  pkgout="$WORK/output-$pkg"; mkdir -p "$pkgout"
  printf '\n=== pinned recipe build: %s ===\n' "$pkg" | tee -a "$OUT/build.log"
  (cd "$WORK" && TERMUX_BUILDER_IMAGE_NAME="$IMAGE" CONTAINER_NAME="aib-v507-${pkg}-$$" ./scripts/run-docker.sh bash -c "set -Eeuo pipefail; cd /home/builder/termux-packages; ./build-package.sh -a aarch64 -o /home/builder/termux-packages/output-$pkg $pkg") 2>&1 | tee -a "$OUT/build.log"
  mapfile -t built < <(find "$pkgout" -maxdepth 1 -type f -name '*.deb' -print | sort)
  ((${#built[@]} > 0)) || fail "NO_BUILT_DEBS_$pkg"
  cp -- "${built[@]}" "$OUT/packages/"
done
python3 "$AUDIT" audit-debs --directory "$OUT/packages"
python3 - "$LOCK" "$OUT/packages" "$OUT/feed" <<'PY'
import json,pathlib,shutil,subprocess,sys
lock=json.loads(pathlib.Path(sys.argv[1]).read_text()); debdir=pathlib.Path(sys.argv[2]); feed=pathlib.Path(sys.argv[3]); expected={}
for p in lock['packages']:
 for name,version in p['outputs'].items():
  assert name not in expected, 'LOCK_DUPLICATE_OUTPUT:'+name
  expected[name]=version
got={}
for d in sorted(debdir.glob('*.deb')):
 name=subprocess.check_output(['dpkg-deb','-f',str(d),'Package'],text=True).strip(); ver=subprocess.check_output(['dpkg-deb','-f',str(d),'Version'],text=True).strip(); arch=subprocess.check_output(['dpkg-deb','-f',str(d),'Architecture'],text=True).strip()
 assert name not in got, 'DUPLICATE_FRESH_PACKAGE:'+name
 assert name in expected and ver==expected[name] and arch in ('aarch64','all'), 'FRESH_PACKAGE_IDENTITY_MISMATCH:'+name+':'+ver+':'+arch
 got[name]=ver; dest=feed/'pool/main'/name/d.name; dest.parent.mkdir(parents=True,exist_ok=True); shutil.copy2(d,dest)
assert got==expected, 'FRESH_PACKAGE_SET_MISMATCH:'+str({'expected':expected,'got':got})
print('FRESH_PINNED_PACKAGE_SET_STAGED_OK count='+str(len(got)))
PY
mkdir -p "$OUT/feed/dists/stable/main/binary-aarch64"
(cd "$OUT/feed" && dpkg-scanpackages -m pool /dev/null > dists/stable/main/binary-aarch64/Packages)
gzip -n -9c "$OUT/feed/dists/stable/main/binary-aarch64/Packages" > "$OUT/feed/dists/stable/main/binary-aarch64/Packages.gz"
python3 "$AUDIT" audit-debs --directory "$OUT/feed/pool"
python3 "$AUDIT" closure --index "$OUT/feed/dists/stable/main/binary-aarch64/Packages" --status "$OUT/bootstrap-status"
python3 - "$OUT/feed" <<'PY'
import pathlib,sys
feed=pathlib.Path(sys.argv[1]); p=feed/'dists/stable/main/binary-aarch64/Packages'; idx=p.read_text(); rows=[b for b in idx.strip().split('\n\n') if b.strip()]; pool=list((feed/'pool').rglob('*.deb'))
assert len(rows)==len(pool), 'INDEX_POOL_COUNT_MISMATCH'
assert {r.split('Filename: ',1)[1].splitlines()[0] for r in rows}=={x.relative_to(feed).as_posix() for x in pool}, 'INDEX_POOL_PATH_SET_MISMATCH'
print('MULTIVERSION_PACKAGES_INDEX_AND_POOL_SET_OK records='+str(len(rows)))
PY
python3 "$AUDIT" write-release --feed "$OUT/feed"
python3 "$AUDIT" write-manifest --root "$OUT" --catalog-commit "$PIN" --dependency-closure-complete
python3 "$AUDIT" verify-manifest --root "$OUT"
printf 'AIB_V507_DRAFT_HANDOFF_READY packages_built=6 closure_gate=passed apt_metadata=unsigned catalogState=build-gated-awaiting-karat-signature production_qualified=no device_runtime_test=NOT_RUN\n' | tee -a "$OUT/build.log"
