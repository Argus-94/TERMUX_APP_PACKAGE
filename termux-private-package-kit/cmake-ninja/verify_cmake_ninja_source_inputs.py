#!/usr/bin/env python3
"""Verify the pinned source recipe inventory and archive-backed license evidence without extraction."""
import argparse, hashlib, json, pathlib, subprocess, sys, tarfile

def digest(path):
 h=hashlib.sha256()
 with path.open('rb') as f:
  for b in iter(lambda:f.read(1024*1024),b''): h.update(b)
 return h.hexdigest()
def fail(msg): raise ValueError(msg)
def main():
 p=argparse.ArgumentParser(); p.add_argument('--source-root',required=True,type=pathlib.Path); p.add_argument('--download-root',required=True,type=pathlib.Path); p.add_argument('--package-set',type=pathlib.Path,default=pathlib.Path(__file__).resolve().parents[2]/'cmake-ninja-candidate-package-set.json'); p.add_argument('--recipe-inputs',type=pathlib.Path,default=pathlib.Path(__file__).with_name('upstream-recipe-inputs.json')); a=p.parse_args()
 try:
  m=json.loads(a.package_set.read_text()); lock=json.loads(a.recipe_inputs.read_text()); root=a.source_root.resolve(); closure=json.loads((pathlib.Path(__file__).resolve().parents[2]/'toolchain-candidate-source-closures/cmake-ninja-candidate.json').read_text())
  if lock.get('sourceCommit')!=m['source']['commit'] or len(lock.get('files',{}))!=69: fail('RECIPE_LOCK_IDENTITY_OR_COUNT_INVALID')
  if m.get('sourceClosureSha256')!=digest(pathlib.Path(__file__).resolve().parents[2]/'toolchain-candidate-source-closures/cmake-ninja-candidate.json'): fail('SOURCE_CLOSURE_HASH_MISMATCH')
  for rel,h in lock['files'].items():
   f=root/rel
   if not f.is_file() or f.is_symlink() or digest(f)!=h: fail('PINNED_SOURCE_FILE_MISMATCH:'+rel)
  for spec in m['packages']:
   parent=pathlib.PurePosixPath(spec['recipePath']).parent; actual={}
   for f in (root/parent).rglob('*'):
    if f.is_file() and not f.is_symlink(): actual[f.relative_to(root).as_posix()]=digest(f)
   if actual!=spec['recipeDirectoryFiles']: fail('RECIPE_DIRECTORY_INVENTORY_MISMATCH:'+spec['name'])
  installer=root/'scripts/build/termux_step_install_license.sh'
  if not installer.is_file() or digest(installer)!='794cd0a55536d9a1bdab92a281a09fc4c44ad1c43f90458213f6e00010ad0780': fail('LICENSE_INSTALLER_SCRIPT_NOT_PINNED')
  script=installer.read_text()
  if 'TERMUX_PKG_LICENSE_FILE' not in script or 'COMMON_LICENSE_FILES' not in script or 'TERMUX_PREFIX}/share/doc/${TERMUX_PKG_NAME}' not in script: fail('LICENSE_INSTALLER_BEHAVIOR_UNRECOGNIZED')
  cmake_recipe=(root/'packages/cmake/build.sh').read_text(); ninja_recipe=(root/'packages/ninja/build.sh').read_text()
  if 'TERMUX_PKG_LICENSE="BSD 3-Clause"' not in cmake_recipe or 'TERMUX_PKG_LICENSE="Apache-2.0"' not in ninja_recipe: fail('ROOT_LICENSE_EXPRESSION_MISMATCH')
  evidence=m['sourceLicenseEvidence']
  for name in ('cmake','ninja'):
   src=m['sourceArchives'][name]; arc=a.download_root/(name+'.tar.gz')
   if not arc.is_file() or arc.is_symlink() or digest(arc)!=src['sha256']: fail('UPSTREAM_ARCHIVE_HASH_MISMATCH:'+name)
   found={}; prefixes={'cmake':'cmake-4.4.4/','ninja':'ninja-1.13.2/'}
   with tarfile.open(arc,'r|gz') as tf:
    for member in tf:
     if member.isfile() and not member.name.startswith('/') and '..' not in pathlib.PurePosixPath(member.name).parts:
      leaf=member.name.removeprefix(prefixes[name])
      if leaf in evidence[name]['licenseFiles']:
       stream=tf.extractfile(member); data=stream.read(member.size+1)
       if len(data)!=member.size: fail('LICENSE_MEMBER_TRUNCATED:'+name+':'+leaf)
       found[leaf]=hashlib.sha256(data).hexdigest()
   if found!=evidence[name]['licenseFiles']: fail('UPSTREAM_LICENSE_PAYLOAD_HASH_MISMATCH:'+name)
  print('CMAKE_NINJA_SOURCE_INPUTS_VERIFIED files=69 archives=2 license-payloads=2 extraction=none'); return 0
 except (OSError,ValueError,KeyError,TypeError,tarfile.TarError) as e: print('CMAKE_NINJA_SOURCE_INPUTS_REJECTED:'+str(e),file=sys.stderr); return 2
if __name__=='__main__': raise SystemExit(main())
