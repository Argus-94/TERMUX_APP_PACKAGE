import hashlib, importlib.util, json, pathlib, shutil, subprocess, tempfile, unittest
ROOT=pathlib.Path(__file__).resolve().parents[2]
def load(name,path):
 spec=importlib.util.spec_from_file_location(name,path); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m
M=load('supportverifier',ROOT/'scripts/verify-candidate-license-support.py')
BUILDER=load('supportbuilder',ROOT/'scripts/build-candidate-license-support.py')
@unittest.skipUnless(shutil.which('gpg') and shutil.which('gpgv') and shutil.which('dpkg-deb'), 'GPG and dpkg-deb required')
class SignedBundle(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(); self.root=pathlib.Path(self.tmp.name); self.original_lock=M.LOCK; self.original_source=M.EXPECTED_SOURCE
  self.source=self.root/'source'; self.pkg=self.source/'packages/termux-licenses'; (self.pkg/'LICENSES').mkdir(parents=True)
  canonical=json.loads(self.original_lock.read_text()); self.files={}
  for rel,spec in canonical['packageTree'].items():
   path=pathlib.PurePosixPath(rel)
   if path.parent.as_posix()=='LICENSES' and path.suffix=='.txt':
    dest=self.pkg/rel; dest.parent.mkdir(parents=True,exist_ok=True)
    if spec['type']=='symlink':
     dest.symlink_to(spec['target'])
    else:
     dest.write_text('fixture '+path.name+'\n'); self.files[rel]=hashlib.sha256(dest.read_bytes()).hexdigest()
  for rel,spec in canonical['packageTree'].items():
   if spec['type']=='symlink': self.files[rel]=hashlib.sha256((self.pkg/'LICENSES'/spec['target']).read_bytes()).hexdigest()
  recipe='TERMUX_PKG_VERSION=2.2\ntermux_step_make_install() { mkdir -p "$TERMUX_PREFIX/share/LICENSES"; for LICENSE in "$TERMUX_PKG_BUILDER_DIR/LICENSES/"*.txt; do cp -df "$LICENSE" "$TERMUX_PREFIX/share/LICENSES/"; done; }\n'
  (self.pkg/'build.sh').write_text(recipe)
  canonical['files']={**self.files,'build.sh':hashlib.sha256((self.pkg/'build.sh').read_bytes()).hexdigest()}; canonical['packageTree']=BUILDER.tree(self.pkg); canonical['recipeText']=recipe
  canonical['sourceCommit']=M.EXPECTED_SOURCE; self.lockfile=self.root/'test-lock.json'; self.lockfile.write_text(json.dumps(canonical,indent=2)+'\n'); M.LOCK=self.lockfile
  self.bundle=self.root/'bundle'; (self.bundle/'keys').mkdir(parents=True); (self.bundle/'packages').mkdir()
  self.deb=self.bundle/'packages/termux-licenses_2.2_all.deb'; BUILDER.make_deb(self.pkg,1700000000,self.deb,source_tree=BUILDER.tree(self.pkg)); debsha=hashlib.sha256(self.deb.read_bytes()).hexdigest()
  home=self.root/'gnupg'; home.mkdir(mode=0o700); subprocess.run(['gpg','--homedir',str(home),'--batch','--passphrase','','--quick-generate-key','Support fixture <fixture@example.invalid>','ed25519','sign','0'],check=True,capture_output=True)
  listing=subprocess.check_output(['gpg','--homedir',str(home),'--batch','--with-colons','--list-keys'],text=True); self.fpr=next(line.split(':')[9] for line in listing.splitlines() if line.startswith('fpr:'))
  key=self.bundle/'keys/aibuilder-termux-feed-keyring.gpg'
  with key.open('wb') as f: subprocess.run(['gpg','--homedir',str(home),'--batch','--export',self.fpr],stdout=f,check=True)
  keysha=hashlib.sha256(key.read_bytes()).hexdigest()
  (self.bundle/'keys/feed-signing.json').write_text(json.dumps({'schemaVersion':1,'fingerprint':self.fpr,'publicKeyring':'keys/aibuilder-termux-feed-keyring.gpg','publicKeyringSha256':keysha,'algorithm':'fixture','status':'ephemeral-only'}))
  (self.bundle/'candidate-license-support-lock.json').write_bytes(self.lockfile.read_bytes())
  (self.bundle/'candidate-package-set.json').write_text(json.dumps({'packages':[{'name':'termux-licenses','version':'2.2','architecture':'all','sha256':debsha,'filename':'packages/termux-licenses_2.2_all.deb'}],'qualified':False,'productionAllowed':False}))
  (self.bundle/'provenance.json').write_text(json.dumps({'repositoryCommit':self.producer,'sourceCommit':M.EXPECTED_SOURCE,'builderImageDigest':canonical['builderImageDigest'],'sourceLockSha256':hashlib.sha256(self.lockfile.read_bytes()).hexdigest(),'packageSha256':debsha,'repeatBuildSha256':debsha,'repeatBuildMatch':True,'qualified':False,'productionAllowed':False,'noAndroidInstallation':True}))
  self.home=home; self.resign()
 def tearDown(self): M.LOCK=self.original_lock; M.EXPECTED_SOURCE=self.original_source; self.tmp.cleanup()
 @property
 def producer(self): return '568401d000000000000000000000000000000000'
 def resign(self):
  names=['candidate-license-support-lock.json','candidate-package-set.json','provenance.json','keys/aibuilder-termux-feed-keyring.gpg','keys/feed-signing.json','packages/termux-licenses_2.2_all.deb']
  (self.bundle/'signed-inventory.json').write_text(json.dumps({'files':{n:hashlib.sha256((self.bundle/n).read_bytes()).hexdigest() for n in names}}))
  subprocess.run(['gpg','--homedir',str(self.home),'--batch','--yes','--detach-sign','--output',str(self.bundle/'signed-inventory.json.asc'),str(self.bundle/'signed-inventory.json')],check=True,capture_output=True)
 def test_valid_real_builder_package_and_signature(self):
  result=M.verify(self.bundle,self.fpr,self.producer); self.assertTrue(result['valid']); self.assertFalse(result['qualified']); self.assertFalse(result['productionAllowed']); self.assertEqual(result['android'],'NOT_RUN'); self.assertFalse(result['installPerformed'])
 def test_wrong_external_fingerprint_rejected(self):
  with self.assertRaisesRegex(ValueError,'EXTERNAL_SIGNATURE_FINGERPRINT_MISMATCH'): M.verify(self.bundle,'A'*40,self.producer)
 def test_wrong_producer_rejected(self):
  with self.assertRaisesRegex(ValueError,'PRODUCER_COMMIT_MISMATCH'): M.verify(self.bundle,self.fpr,'0'*40)
 def test_tampered_signature_rejected(self):
  sig=self.bundle/'signed-inventory.json.asc'; sig.write_bytes(sig.read_bytes()+b'bad')
  with self.assertRaisesRegex(ValueError,'EXTERNAL_SIGNATURE_FINGERPRINT_MISMATCH'): M.verify(self.bundle,self.fpr,self.producer)
 def test_noncanonical_source_lock_rejected(self):
  (self.bundle/'candidate-license-support-lock.json').write_text('{}'); self.resign()
  with self.assertRaisesRegex(ValueError,'NONCANONICAL_SUPPORT_LOCK'): M.verify(self.bundle,self.fpr,self.producer)
 def test_inventory_protected_source_edit_rejected(self):
  (self.bundle/'provenance.json').write_text('{"changed":true}')
  with self.assertRaisesRegex(ValueError,'INVENTORY_HASH_MISMATCH'): M.verify(self.bundle,self.fpr,self.producer)
 def test_edited_license_or_extra_payload_rejected(self):
  (self.pkg/'LICENSES/GPL-3.0.txt').write_text('edited\n'); changed=self.root/'changed.deb'; BUILDER.make_deb(self.pkg,1700000000,changed,source_tree=BUILDER.tree(self.pkg)); (self.bundle/'packages/termux-licenses_2.2_all.deb').write_bytes(changed.read_bytes()); self.resign()
  digest=hashlib.sha256(changed.read_bytes()).hexdigest()
  pset=json.loads((self.bundle/'candidate-package-set.json').read_text()); pset['packages'][0]['sha256']=digest; (self.bundle/'candidate-package-set.json').write_text(json.dumps(pset))
  prov=json.loads((self.bundle/'provenance.json').read_text()); prov.update(packageSha256=digest,repeatBuildSha256=digest); (self.bundle/'provenance.json').write_text(json.dumps(prov)); self.resign()
  with self.assertRaisesRegex(ValueError,'LICENSE_CONTENT_HASH_MISMATCH'): M.verify(self.bundle,self.fpr,self.producer)
 def test_extra_bundle_file_rejected(self):
  (self.bundle/'secret.env').write_text('secret')
  with self.assertRaisesRegex(ValueError,'BUNDLE_ALLOWLIST_MISMATCH'): M.verify(self.bundle,self.fpr,self.producer)
 def update_package_digest(self):
  debpath=self.bundle/'packages/termux-licenses_2.2_all.deb'; digest=hashlib.sha256(debpath.read_bytes()).hexdigest()
  pset=json.loads((self.bundle/'candidate-package-set.json').read_text()); pset['packages'][0]['sha256']=digest; (self.bundle/'candidate-package-set.json').write_text(json.dumps(pset))
  prov=json.loads((self.bundle/'provenance.json').read_text()); prov.update(packageSha256=digest,repeatBuildSha256=digest); (self.bundle/'provenance.json').write_text(json.dumps(prov)); self.resign()
 def repack(self, transformData=None, transformControl=None):
  import io, tarfile
  debpath=self.bundle/'packages/termux-licenses_2.2_all.deb'
  members={n:subprocess.check_output(['ar','p',str(debpath),n]) for n in ('debian-binary','control.tar.gz','data.tar.gz')}
  for member, callback in (('data.tar.gz',transformData),('control.tar.gz',transformControl)):
   if callback:
    raw=io.BytesIO(members[member]); out=io.BytesIO()
    with tarfile.open(fileobj=raw,mode='r:gz') as src, tarfile.open(fileobj=out,mode='w:gz') as dst:
     entries=[]
     for info in src.getmembers():
      body=src.extractfile(info).read() if info.isfile() else None
      info,body=callback(info,body)
      entries.append((info,body))
     for info,body in entries: dst.addfile(info,io.BytesIO(body) if info.isfile() else None)
    members[member]=out.getvalue()
  altered=self.root/'altered.deb'
  (self.root/'debian-binary').write_bytes(members['debian-binary']); (self.root/'control.tar.gz').write_bytes(members['control.tar.gz']); (self.root/'data.tar.gz').write_bytes(members['data.tar.gz'])
  subprocess.run(['ar','rcD',str(altered),str(self.root/'debian-binary'),str(self.root/'control.tar.gz'),str(self.root/'data.tar.gz')],cwd=self.root,check=True)
  debpath.write_bytes(altered.read_bytes()); self.update_package_digest()
 def test_retargeted_alias_symlink_rejected(self):
  import copy
  target='data/user/0/com.karat.aibuilder/files/usr/share/LICENSES/GPL-3.0-only.txt'
  for destination in ('Other.txt', 'missing.txt', '/etc/passwd', '../GPL-3.0.txt', '../../../../../../etc/passwd'):
   with self.subTest(destination=destination):
    def transform(info, body):
     info=copy.copy(info)
     if info.name==target: info.linkname=destination
     return info,body
    self.repack(transformData=transform)
    with self.assertRaisesRegex(ValueError,'PAYLOAD_SYMLINK_MISMATCH'): M.verify(self.bundle,self.fpr,self.producer)
 def test_alias_cannot_be_replaced_with_regular_file(self):
  import copy,tarfile
  target='data/user/0/com.karat.aibuilder/files/usr/share/LICENSES/GPL-3.0-only.txt'
  def transform(info, body):
   info=copy.copy(info)
   if info.name==target:
    body=(self.pkg/'LICENSES/GPL-3.0.txt').read_bytes()
    info.type=tarfile.REGTYPE; info.linkname=''; info.mode=0o644; info.size=len(body)
   return info,body
  self.repack(transformData=transform)
  with self.assertRaisesRegex(ValueError,'PAYLOAD_SYMLINK_MISMATCH'): M.verify(self.bundle,self.fpr,self.producer)
 def test_forged_installed_size_rejected(self):
  import copy,re
  def transform(info, body):
   info=copy.copy(info)
   if info.name=='control':
    body=re.sub(rb'Installed-Size: [0-9]+',b'Installed-Size: 999999',body); info.size=len(body)
   return info,body
  self.repack(transformControl=transform)
  with self.assertRaisesRegex(ValueError,'INSTALLED_SIZE_MISMATCH'): M.verify(self.bundle,self.fpr,self.producer)
 def test_extra_control_script_rejected(self):
  import io,tarfile
  debpath=self.bundle/'packages/termux-licenses_2.2_all.deb'; original=subprocess.check_output(['ar','p',str(debpath),'control.tar.gz']); out=io.BytesIO()
  with tarfile.open(fileobj=io.BytesIO(original),mode='r:gz') as src, tarfile.open(fileobj=out,mode='w:gz') as dst:
   for info in src.getmembers(): dst.addfile(info,io.BytesIO(src.extractfile(info).read()) if info.isfile() else None)
   info=tarfile.TarInfo('postinst'); info.mode=0o755; info.uid=0; info.gid=0; info.size=2; dst.addfile(info,io.BytesIO(b'#!'))
  control=self.root/'control.tar.gz'; control.write_bytes(out.getvalue()); binary=self.root/'debian-binary'; binary.write_bytes(b'2.0\n'); data=self.root/'data.tar.gz'; data.write_bytes(subprocess.check_output(['ar','p',str(debpath),'data.tar.gz'])); altered=self.root/'altered.deb'
  subprocess.run(['ar','rcD',str(altered),str(binary),str(control),str(data)],cwd=self.root,check=True); debpath.write_bytes(altered.read_bytes()); self.update_package_digest()
  with self.assertRaisesRegex(ValueError,'CONTROL_ARCHIVE_NOT_EXACT'): M.verify(self.bundle,self.fpr,self.producer)
 def test_extra_package_payload_rejected(self):
  import tarfile
  def add_extra(info, body):
   extra=tarfile.TarInfo('data/user/0/com.karat.aibuilder/files/usr/share/LICENSES/unlisted.txt'); extra.mode=0o644; extra.uid=0; extra.gid=0; extra.size=8
   self._extra_info=extra
   return info,body
  # Add while preserving every original TarInfo field.
  import io
  debpath=self.bundle/'packages/termux-licenses_2.2_all.deb'; original=subprocess.check_output(['ar','p',str(debpath),'data.tar.gz'])
  out=io.BytesIO()
  with tarfile.open(fileobj=io.BytesIO(original),mode='r:gz') as src, tarfile.open(fileobj=out,mode='w:gz') as dst:
   for info in src.getmembers(): dst.addfile(info,io.BytesIO(src.extractfile(info).read()) if info.isfile() else None)
   info=tarfile.TarInfo('data/user/0/com.karat.aibuilder/files/usr/share/LICENSES/unlisted.txt'); info.mode=0o644; info.uid=0; info.gid=0; info.size=8; dst.addfile(info,io.BytesIO(b'unlisted!'))
  control=self.root/'control.tar.gz'; control.write_bytes(subprocess.check_output(['ar','p',str(debpath),'control.tar.gz'])); binary=self.root/'debian-binary'; binary.write_bytes(b'2.0\n'); data=self.root/'data.tar.gz'; data.write_bytes(out.getvalue()); altered=self.root/'altered.deb'
  subprocess.run(['ar','rcD',str(altered),str(binary),str(control),str(data)],cwd=self.root,check=True); debpath.write_bytes(altered.read_bytes()); self.update_package_digest()
  with self.assertRaisesRegex(ValueError,'PAYLOAD_PATH_SET_MISMATCH'): M.verify(self.bundle,self.fpr,self.producer)
if __name__=='__main__': unittest.main()
