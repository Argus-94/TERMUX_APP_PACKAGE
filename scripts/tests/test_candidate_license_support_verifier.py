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
  for rel in canonical['files']:
   path=pathlib.PurePosixPath(rel)
   if path.parent.as_posix()=='LICENSES' and path.suffix=='.txt':
    dest=self.pkg/rel; dest.parent.mkdir(parents=True,exist_ok=True); dest.write_text('fixture '+path.name+'\n'); self.files[rel]=hashlib.sha256(dest.read_bytes()).hexdigest()
  recipe='TERMUX_PKG_VERSION=2.2\ntermux_step_make_install() { mkdir -p "$TERMUX_PREFIX/share/LICENSES"; for LICENSE in "$TERMUX_PKG_BUILDER_DIR/LICENSES/"*.txt; do cp -df "$LICENSE" "$TERMUX_PREFIX/share/LICENSES/"; done; }\n'
  (self.pkg/'build.sh').write_text(recipe)
  canonical['files']={**self.files,'build.sh':hashlib.sha256((self.pkg/'build.sh').read_bytes()).hexdigest()}; canonical['packageTree']=BUILDER.tree(self.pkg); canonical['recipeText']=recipe
  canonical['sourceCommit']=M.EXPECTED_SOURCE; self.lockfile=self.root/'test-lock.json'; self.lockfile.write_text(json.dumps(canonical,indent=2)+'\n'); M.LOCK=self.lockfile
  self.bundle=self.root/'bundle'; (self.bundle/'keys').mkdir(parents=True); (self.bundle/'packages').mkdir()
  self.deb=self.bundle/'packages/termux-licenses_2.2_all.deb'; BUILDER.make_deb(self.pkg,1700000000,self.deb); debsha=hashlib.sha256(self.deb.read_bytes()).hexdigest()
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
  (self.pkg/'LICENSES/GPL-3.0.txt').write_text('edited\n'); changed=self.root/'changed.deb'; BUILDER.make_deb(self.pkg,1700000000,changed); (self.bundle/'packages/termux-licenses_2.2_all.deb').write_bytes(changed.read_bytes()); self.resign()
  digest=hashlib.sha256(changed.read_bytes()).hexdigest()
  pset=json.loads((self.bundle/'candidate-package-set.json').read_text()); pset['packages'][0]['sha256']=digest; (self.bundle/'candidate-package-set.json').write_text(json.dumps(pset))
  prov=json.loads((self.bundle/'provenance.json').read_text()); prov.update(packageSha256=digest,repeatBuildSha256=digest); (self.bundle/'provenance.json').write_text(json.dumps(prov)); self.resign()
  with self.assertRaisesRegex(ValueError,'LICENSE_CONTENT_HASH_MISMATCH'): M.verify(self.bundle,self.fpr,self.producer)
 def test_extra_bundle_file_rejected(self):
  (self.bundle/'secret.env').write_text('secret')
  with self.assertRaisesRegex(ValueError,'BUNDLE_ALLOWLIST_MISMATCH'): M.verify(self.bundle,self.fpr,self.producer)
 def test_extra_package_payload_rejected(self):
  import tarfile
  debpath=self.bundle/'packages/termux-licenses_2.2_all.deb'; extracted=self.root/'extracted'; extracted.mkdir(); subprocess.run(['dpkg-deb','-x',str(debpath),str(extracted)],check=True)
  data=self.root/'unlisted.txt'; data.write_text('unexpected'); extra=self.root/'data.tar.gz'
  with tarfile.open(extra,'w:gz') as tar:
   tar.add(extracted,arcname='.')
   tar.add(data,arcname='data/user/0/com.karat.aibuilder/files/usr/share/LICENSES/unlisted.txt')
  control=self.root/'control.tar.gz'; control.write_bytes(subprocess.check_output(['ar','p',str(debpath),'control.tar.gz']))
  binary=self.root/'debian-binary'; binary.write_bytes(b'2.0\n'); altered=self.root/'altered.deb'
  subprocess.run(['ar','rcD',str(altered),str(binary),str(control),str(extra)],cwd=self.root,check=True)
  debpath.write_bytes(altered.read_bytes()); digest=hashlib.sha256(debpath.read_bytes()).hexdigest()
  pset=json.loads((self.bundle/'candidate-package-set.json').read_text()); pset['packages'][0]['sha256']=digest; (self.bundle/'candidate-package-set.json').write_text(json.dumps(pset))
  prov=json.loads((self.bundle/'provenance.json').read_text()); prov.update(packageSha256=digest,repeatBuildSha256=digest); (self.bundle/'provenance.json').write_text(json.dumps(prov)); self.resign()
  with self.assertRaisesRegex(ValueError,'PAYLOAD_PATH_SET_MISMATCH'): M.verify(self.bundle,self.fpr,self.producer)
if __name__=='__main__': unittest.main()
