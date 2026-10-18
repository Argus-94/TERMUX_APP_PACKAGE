from __future__ import annotations
import argparse, hashlib, json, pathlib, sys, unittest
KIT=pathlib.Path(__file__).resolve().parents[1]; REPO=KIT.parents[1]
sys.path.insert(0,str(KIT)); import audit_cmake_ninja_closure as audit
MANIFEST=REPO/'cmake-ninja-candidate-package-set.json'; CLOSURE=REPO/'toolchain-candidate-source-closures/cmake-ninja-candidate.json'
class ClosureTests(unittest.TestCase):
 def setUp(self): self.args=argparse.Namespace(package_set=MANIFEST,source_closure=CLOSURE,prefix='/data/user/0/com.karat.aibuilder/files/usr')
 def test_pinned_candidate_contract(self):
  m,p,s=audit.validate_manifest(self.args); self.assertEqual(m['sourceClosure']['expectedPackageCount'],22); self.assertEqual(m['sourceClosure']['expectedDependencyAlternativeCount'],34); self.assertEqual(m['sourceClosure']['rootPackages'],['cmake','ninja']); self.assertEqual(len(s),22)
 def test_pinned_manifest_and_closure_hashes_reject_drift(self):
  self.assertEqual(hashlib.sha256(MANIFEST.read_bytes()).hexdigest(),audit.PACKAGE_SET_SHA256)
  self.assertEqual(hashlib.sha256(CLOSURE.read_bytes()).hexdigest(),audit.SOURCE_CLOSURE_SHA256)
  bad=dict(vars(self.args)); bad['prefix']='/data/user/0/com.termux/files/usr'
  with self.assertRaises(audit.AuditError):audit.validate_manifest(argparse.Namespace(**bad))
 def test_archive_pins_and_private_prefix(self):
  m,_,_=audit.validate_manifest(self.args); self.assertEqual(m['sourceArchives']['cmake']['sha256'],'bd24c30d80a7744ae84b845ff080cc8453b06c622ef01066564108e9cefc44cf'); self.assertEqual(m['sourceArchives']['ninja']['sha256'],'974d6b2f4eeefa25625d34da3cb36bdcebe7fbce40f4c16ac0835fd1c0cbae17')
  for x in ('/usr','/data/user/0/com.termux/files/usr','/data/user/0/com.karat.aibuilder/files/usr/../bad'):
   with self.subTest(x=x),self.assertRaises(audit.AuditError):audit.normalize_prefix(x)
 def test_mandatory_elf_and_dependency_alternative_inventory(self):
  self.assertEqual(audit.MANDATORY,{'cmake':['bin/cmake','bin/ctest','bin/cpack'],'ninja':['bin/ninja']}); c=json.loads(CLOSURE.read_text()); self.assertEqual(sum(len(p['dependencyGroups']) for p in c['packages']),34)
 def test_controlled_payload_path_and_link_gates(self):
  for raw in ('/data/data/com.termux/files/usr/bin/x','/data/user/0/com.karat.aibuilder/files/usr/../../tmp'):
   with self.assertRaises(audit.AuditError):
    path=audit.normalize_member(raw); audit.ensure_payload_path(path,self.args.prefix,False)
  with self.assertRaises(audit.AuditError):audit.resolve_link(self.args.prefix+'/lib/x.so','../../../../../../tmp/out',False,self.args.prefix)
 def test_provider_gate_rejects_unproven_needed_lib(self):
  with self.assertRaises(audit.AuditError):audit.req(False,'ELF_NEEDED_PROVIDER_UNPROVEN')
 def test_license_evidence_is_source_pinned(self):
  m,_,_=audit.validate_manifest(self.args); self.assertEqual(m['sourceLicenseEvidence'],audit.EXPECTED_SOURCE_LICENSE_EVIDENCE); self.assertEqual(audit.EXPECTED_LOCAL_LICENSE_PATHS['cmake'],{'share/doc/cmake/copyright'}); self.assertIn('NCSA',audit.EXPECTED_SHARED_LICENSES['libc++'])
if __name__=='__main__':unittest.main()
