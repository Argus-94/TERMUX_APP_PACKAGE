from __future__ import annotations
import argparse, hashlib, json, pathlib, sys, unittest
KIT=pathlib.Path(__file__).resolve().parents[1]
REPO=KIT.parents[1]
sys.path.insert(0,str(KIT))
import audit_nodejs_npm_closure as audit
CLOSURE=REPO/"toolchain-candidate-source-closures/nodejs-npm-candidate.json"
MANIFEST=REPO/"nodejs-npm-candidate-package-set.json"
PREFIX="/data/user/0/com.karat.aibuilder/files/usr"
class NodeAuditTests(unittest.TestCase):
    def test_locked_inputs_and_one_provider(self):
        self.assertEqual(hashlib.sha256(CLOSURE.read_bytes()).hexdigest(),audit.SOURCE_CLOSURE_SHA256)
        self.assertEqual(hashlib.sha256(MANIFEST.read_bytes()).hexdigest(),audit.PACKAGE_SET_SHA256)
        c=json.loads(CLOSURE.read_text()); self.assertEqual(c["profile"],"nodejs-npm-candidate")
        self.assertEqual(c["selectedDependencyAlternatives"][0]["selected"],"nodejs")
        self.assertEqual({x["name"] for x in c["packages"]},set(audit.EXPECTED_PACKAGES))
        self.assertEqual(len(c["packages"]),11); self.assertEqual(c["dependencyAlternativeCount"],14)
    def test_prefix_and_path_traversal_rejected(self):
        self.assertEqual(audit.normalize_prefix(PREFIX),PREFIX)
        for bad in ("/usr","/data/user/0/com.termux/files/usr",PREFIX+"/../../x"):
            with self.subTest(bad=bad),self.assertRaises(audit.AuditError): audit.normalize_prefix(bad)
        for bad in ("../../etc/passwd","/etc/passwd","data\\usr\\lib"):
            with self.subTest(bad=bad),self.assertRaises(audit.AuditError): audit.normalize_member(bad)
        with self.assertRaises(audit.AuditError): audit.resolve_link(PREFIX+"/bin/x","../../../../etc/passwd",False,PREFIX)
    def test_license_evidence_filename_recognition_and_mandatory(self):
        self.assertTrue(audit.is_license_doc(PREFIX+"/share/doc/npm/LICENSE", "npm", PREFIX))
        self.assertFalse(audit.is_license_doc(PREFIX+"/share/doc/npm/README.md", "npm", PREFIX))
        audit.validate_control_license("Artistic-License-2.0", "Artistic-License-2.0", "npm")
        with self.assertRaisesRegex(audit.AuditError,"CONTROL_LICENSE_NOT_ALLOWLISTED"):
            audit.validate_control_license("wrong", "Artistic-License-2.0", "npm")
        with self.assertRaisesRegex(audit.AuditError,"LICENSE_EVIDENCE_MISSING"):
            audit.require(False,"LICENSE_EVIDENCE_MISSING","npm")
    def test_exact_base_license_provider_includes_pinned_ncsa_hash(self):
        evidence=audit.expected_base_license_evidence(audit.EXPECTED_BASE_LICENSE_EVIDENCE)
        self.assertEqual(evidence["licenseFilesSha256"]["share/LICENSES/NCSA.txt"],
                         "aecb9504bcc76b4ff5e8ff1266344bb607b6bed2bfc3dd8b35233d941401d01e")
        bad=dict(evidence); bad["licenseFilesSha256"]=dict(evidence["licenseFilesSha256"]); bad["licenseFilesSha256"]["share/LICENSES/NCSA.txt"]="0"*64
        with self.assertRaises(audit.AuditError): audit.expected_base_license_evidence(bad)

    def test_license_payload_hash_helper_rejects_absent_or_wrong_hash(self):
        self.assertEqual(audit.verify_license_payload_hash(b"license", hashlib.sha256(b"license").hexdigest(), "npm"), hashlib.sha256(b"license").hexdigest())
        for expected in (None, "0" * 64, "bad"):
            with self.subTest(expected=expected), self.assertRaises(audit.AuditError):
                audit.verify_license_payload_hash(b"license", expected, "npm")

    def test_elf_dependency_provider_must_be_unique(self):
        one=[{"package":"nodejs","path":"bin/node","soname":None,"needed":["libcrypto.so.3"]},
             {"package":"openssl","path":"lib/libcrypto.so.3","soname":"libcrypto.so.3","needed":[]}]
        old=audit.PACKAGE_FILE_ELF_SYMLINK_PROVIDERS
        audit.PACKAGE_FILE_ELF_SYMLINK_PROVIDERS={}
        result=audit.validate_elf_needed_providers(one,[])
        self.assertIn("libcrypto.so.3",result["providers"])
        with self.assertRaises(audit.AuditError): audit.validate_elf_needed_providers(one+[one[1]],[])
        with self.assertRaises(audit.AuditError): audit.validate_elf_needed_providers([one[0]],[])
        audit.PACKAGE_FILE_ELF_SYMLINK_PROVIDERS=old
    def test_libsqlite_package_symlink_provider_is_exact(self):
        elf=[{"package":"libsqlite","path":"lib/libsqlite3.so.3.54.0","soname":None,"needed":[]}]
        good=[{"package":"libsqlite","path":"lib/libsqlite3.so","target":"lib/libsqlite3.so.3.54.0"}]
        self.assertIn("libsqlite3.so", audit.validate_elf_needed_providers(elf,good)["providers"])
        with self.assertRaises(audit.AuditError): audit.validate_elf_needed_providers(elf,[])

    def test_source_provider_drift_fails_closed(self):
        closure=json.loads(CLOSURE.read_text())
        npm=next(p for p in closure["packages"] if p["name"]=="npm")
        self.assertEqual(npm["dependencyGroups"][0][0]["sourceRelation"],"nodejs")
        self.assertEqual(npm["dependencyGroups"][0][1]["sourceRelation"],"nodejs-lts")
        self.assertEqual(closure["selectedDependencyAlternatives"][0]["selected"],"nodejs")
        bad=json.loads(json.dumps(closure)); bad["selectedDependencyAlternatives"][0]["selected"]="nodejs-lts"
        self.assertNotEqual(bad["selectedDependencyAlternatives"],closure["selectedDependencyAlternatives"])
    def test_manifest_validates_source_manifest_hash_and_closure(self):
        args=argparse.Namespace(package_set=MANIFEST,source_closure=CLOSURE,prefix=PREFIX)
        manifest,prefix,specs=audit.validate_manifest(args)
        self.assertEqual(prefix,PREFIX); self.assertEqual(len(specs),11)
        self.assertEqual(manifest["sourceClosure"]["profile"],"nodejs-npm-candidate")
        self.assertFalse(manifest["releaseGate"]["publicationAllowed"])
if __name__=="__main__": unittest.main()
