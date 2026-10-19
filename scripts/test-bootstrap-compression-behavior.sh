#!/usr/bin/env bash
set -euo pipefail
usage(){ echo 'usage: test-bootstrap-compression-behavior.sh --source-bzip2 FILE --source-xz FILE --work-dir EMPTY_DIR --report FILE' >&2; exit 2; }
BZ= XZ= WORK= REPORT=
while (($#)); do case "$1" in
 --source-bzip2) (($#>=2)) || usage; BZ=$2; shift 2;;
 --source-xz) (($#>=2)) || usage; XZ=$2; shift 2;;
 --work-dir) (($#>=2)) || usage; WORK=$2; shift 2;;
 --report) (($#>=2)) || usage; REPORT=$2; shift 2;; *) usage;; esac; done
[[ -n $BZ && -n $XZ && -n $WORK && -n $REPORT ]] || usage
for c in sha256sum tar gcc make python3; do command -v "$c" >/dev/null || { echo "MISSING_REQUIRED_COMMAND:$c" >&2; exit 2; }; done
[[ -d $WORK ]] || { echo 'WORK_DIR_MISSING' >&2; exit 2; }
[[ -z $(find "$WORK" -mindepth 1 -maxdepth 1 -print -quit) ]] || { echo 'WORK_DIR_NOT_EMPTY' >&2; exit 2; }
sha(){ sha256sum "$1" | awk '{print $1}'; }
# The canonical digest records are pinned by upstream release metadata; verify full digests and required release-specific fingerprint ends.
BZH=$(sha "$BZ"); XZH=$(sha "$XZ")
[[ $BZH == 47fd74b2ff83effad0ddf62074e6fad1f6b4a77a96e121ab421c20a216371a1f ]] || { echo "BZIP2_SOURCE_SHA256_MISMATCH:$BZH" >&2; exit 1; }
[[ $XZH == 4ce24038fd4221e0d13bc1a2de7a4db56e90b92b3bf75321f6c14be73f65de4b ]] || { echo "XZ_SOURCE_SHA256_MISMATCH:$XZH" >&2; exit 1; }
mkdir -p "$WORK/src-bz" "$WORK/src-xz" "$WORK/out"
tar -xf "$BZ" -C "$WORK/src-bz" --no-same-owner
tar -xf "$XZ" -C "$WORK/src-xz" --no-same-owner
find_top(){ find "$1" -mindepth 1 -maxdepth 1 -type d -print -quit; }
BS=$(find_top "$WORK/src-bz"); XS=$(find_top "$WORK/src-xz")
[[ -n $BS && -f $BS/Makefile-libbz2_so ]] || { echo 'BAD_BZIP2_SOURCE_ARCHIVE' >&2; exit 1; }
[[ -n $XS && -x $XS/configure ]] || { echo 'BAD_XZ_SOURCE_ARCHIVE' >&2; exit 1; }
# Native host only. Android sysroot/stubs are deliberately not involved.
make -C "$BS" -j2 bzip2 bzip2recover test
"$BS/bzip2" -1c "$BS/Makefile" > "$WORK/out/bz.generated"
"$BS/bzip2" -dc "$WORK/out/bz.generated" > "$WORK/out/bz.roundtrip"
cmp "$BS/Makefile" "$WORK/out/bz.roundtrip"
mkdir "$WORK/xz-build"
(cd "$WORK/xz-build" && "$XS/configure" --enable-sandbox=no --disable-shared && make -j2 && make check)
XZBIN="$WORK/xz-build/src/xz/xz"
[[ -x $XZBIN ]] || XZBIN="$WORK/xz-build/src/xz/xz"
[[ -x $XZBIN ]] || { echo 'XZ_BINARY_NOT_FOUND' >&2; exit 1; }
"$XZBIN" -z -c "$BS/Makefile" > "$WORK/out/xz.generated"
"$XZBIN" -dc "$WORK/out/xz.generated" > "$WORK/out/xz.roundtrip"
cmp "$BS/Makefile" "$WORK/out/xz.roundtrip"
# Legacy .lzma format fixture roundtrip and cross-read with independent host utilities when available.
printf 'legacy LZMA fixture: compression behavior validation\n' > "$WORK/out/legacy.input"
"$XZBIN" --format=lzma -z -c "$WORK/out/legacy.input" > "$WORK/out/legacy.lzma"
"$XZBIN" --format=lzma -dc "$WORK/out/legacy.lzma" > "$WORK/out/legacy.out"
cmp "$WORK/out/legacy.input" "$WORK/out/legacy.out"
if command -v bzip2 >/dev/null; then bzip2 -dc "$WORK/out/bz.generated" > "$WORK/out/system-bz.out"; cmp "$BS/Makefile" "$WORK/out/system-bz.out"; fi
if command -v xz >/dev/null; then xz -dc "$WORK/out/xz.generated" > "$WORK/out/system-xz.out"; cmp "$BS/Makefile" "$WORK/out/system-xz.out"; fi
python3 - "$REPORT" "$BZH" "$XZH" <<'PY'
import json,sys,pathlib
p=pathlib.Path(sys.argv[1]); p.parent.mkdir(parents=True,exist_ok=True)
p.write_text(json.dumps({'status':'PASS','behavior':'native-host source-built bzip2/xz tests and roundtrips passed','bzip2_source_sha256':sys.argv[2],'xz_source_sha256':sys.argv[3],'host_behavior_tested':True,'android_target_behavior_tested':False,'scope':'host behavior only; does not establish Android runtime/device qualification; no NDK shared-library stubs used'},indent=2)+'\n')
PY
