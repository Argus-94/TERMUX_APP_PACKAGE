#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
KIT="$ROOT/termux-private-package-kit/bootstrap-compat"
PIN=505e06ef0c8dbd7611abfb90e9eb60826dcd01d7
IMAGE=ghcr.io/termux/package-builder@sha256:44999857244619e25bc8e3427904a16d36cc0c0e087704af039e5bdf94814ac9
SRC=${1:-/workspace/termux-source-505e06e}
OUT=${2:-$ROOT/bootstrap-compat-output}
OUT=$(realpath -m "$OUT")
[[ $(git -C "$SRC" rev-parse HEAD) == "$PIN" ]] || { echo SOURCE_PIN_MISMATCH >&2; exit 2; }
[[ -z $(git -C "$SRC" status --porcelain) ]] || { echo SOURCE_DIR_NOT_CLEAN >&2; exit 2; }
mkdir -p "$OUT"
[[ -z $(find "$OUT" -mindepth 1 -print -quit) ]] || { echo OUTPUT_NOT_EMPTY >&2; exit 2; }
curl -fL --retry 3 https://fossies.org/linux/misc/bzip2-1.0.8.tar.xz -o "$OUT/bzip2-1.0.8.tar.xz"
curl -fL --retry 3 https://github.com/tukaani-project/xz/releases/download/v5.8.4/xz-5.8.4.tar.xz -o "$OUT/xz-5.8.4.tar.xz"
printf '%s  %s\n' 47fd74b2ff83effad0ddf62074e6fad1f6b4a77a96e121ab421c20a216371a1f "$OUT/bzip2-1.0.8.tar.xz" 4ce24038fd4221e0d13bc1a2de7a4db56e90b92b3bf75321f6c14be73f65de4b "$OUT/xz-5.8.4.tar.xz" | sha256sum --check
cd "$OUT"
git clone --no-hardlinks "$SRC" termux-packages
cd termux-packages
git checkout --detach "$PIN"
python3 "$ROOT/scripts/apply-candidate-packaging-policy.py" --source-root "$PWD"
python3 "$KIT/patch_properties.py" "$PWD/scripts/properties.sh" --data-dir /data/user/0/com.karat.aibuilder --prefix /data/user/0/com.karat.aibuilder/files/usr
python3 "$ROOT/scripts/apply-candidate-packaging-policy.py" --source-root "$PWD" --verify-only
export TERMUX_BUILDER_IMAGE_NAME="$IMAGE"
docker pull "$IMAGE"
./scripts/run-docker.sh bash -c 'set -Eeuo pipefail; cd /home/builder/termux-packages; export TERMUX_INSTALL_DEPS=false; ./build-package.sh -a aarch64 --format debian -o /home/builder/termux-packages/output/.aib-bootstrap-compat libbz2 && ./build-package.sh -a aarch64 --format debian -o /home/builder/termux-packages/output/.aib-bootstrap-compat liblzma' 2>&1 | tee "$OUT/build.log"
mkdir -p "$OUT/packages"
python3 - "$OUT/packages" <<'PYCOPY'
import pathlib,subprocess,shutil,sys
for p in pathlib.Path('output/.aib-bootstrap-compat').glob('*.deb'):
 name=subprocess.check_output(['dpkg-deb','-f',str(p),'Package'],text=True).strip()
 if name in {'libbz2','bzip2','liblzma','xz-utils'}:shutil.copy2(p,pathlib.Path(sys.argv[1])/p.name)
PYCOPY
python3 "$KIT/audit_packages.py" "$OUT/packages" "$OUT/audit.json"
for recipe in packages/libbz2/build.sh packages/libbz2/bzip2.subpackage.sh packages/liblzma/build.sh packages/liblzma/xz-utils.subpackage.sh; do mkdir -p "$OUT/source-recipes/$(dirname "$recipe")"; cp "$recipe" "$OUT/source-recipes/$recipe"; done
cp LICENSE.md "$OUT/"
git -C "$SRC" show "$PIN:scripts/properties.sh" > "$OUT/original-properties.sh"
python3 - "$OUT/build-result.json" "$PIN" "$IMAGE" "$SRC" "$OUT" <<'PY'
import hashlib,json,pathlib,subprocess,sys,os
p=pathlib.Path(sys.argv[1]);pin,image,src,out=sys.argv[2:];out=pathlib.Path(out)
recipes=['packages/libbz2/build.sh','packages/libbz2/bzip2.subpackage.sh','packages/liblzma/build.sh','packages/liblzma/xz-utils.subpackage.sh']
recipe_hashes={x:hashlib.sha256(subprocess.check_output(['git','-C',src,'show',pin+':'+x])).hexdigest() for x in recipes}
audit=json.loads((out/'audit.json').read_text())
archive_hashes={x.name:hashlib.sha256(x.read_bytes()).hexdigest() for x in [out/'bzip2-1.0.8.tar.xz',out/'xz-5.8.4.tar.xz']}
packages=[]
for name,item in sorted(audit['packages'].items()): packages.append({'name':name,'version':item['version'],'architecture':item['architecture'],'file':item['file'],'sha256':item['sha256']})
record={'schemaVersion':1,'sourceCommit':pin,'producerCommit':os.environ.get('GITHUB_SHA','local-uncommitted'),'builderImage':image,'sourceBuild':True,'controlRepacked':False,'deviceRuntimeTest':'NOT RUN','packages':packages,'sourceInputs':{'recipes':recipe_hashes,'upstreamArchives':archive_hashes}}
record['sourceDateEpoch']=int(subprocess.check_output(['git','-C',src,'show','-s','--format=%ct',pin]))
p.write_text(json.dumps(record,indent=2)+'\n')
PY
(cd "$OUT" && find packages -type f -name '*.deb' -print0 | sort -z | xargs -0 sha256sum > package-SHA256SUMS)
(cd "$OUT" && sha256sum bzip2-1.0.8.tar.xz xz-5.8.4.tar.xz > source-archives-SHA256SUMS)

cd "$OUT"
rm -rf -- "$OUT/termux-packages"
