from __future__ import annotations
import argparse
import copy
import hashlib
import json
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

KIT = pathlib.Path(__file__).resolve().parents[1]
REPO = KIT.parents[1]
sys.path.insert(0, str(KIT))
import audit_openjdk17_closure as audit

MANIFEST = REPO / 'openjdk17-candidate-package-set.json'
CLOSURE = REPO / 'toolchain-candidate-source-closures/openjdk17-candidate.json'
PREFIX = '/data/user/0/com.karat.aibuilder/files/usr'

class OpenJDKAuditTests(unittest.TestCase):
    def args(self, manifest=MANIFEST):
        return argparse.Namespace(package_set=manifest, source_closure=CLOSURE, prefix=PREFIX)

    def test_exact_manifest_and_closure(self):
        self.assertEqual(hashlib.sha256(MANIFEST.read_bytes()).hexdigest(), audit.PACKAGE_SET_SHA256)
        m, p, specs = audit.validate_manifest(self.args())
        self.assertEqual(p, PREFIX)
        self.assertEqual(len(specs), 36)
        self.assertEqual(m['sourceClosure']['expectedDependencyAlternativeCount'], 46)
        self.assertEqual(next(x for x in specs if x['name']=='libltdl')['parentPackage'], 'libtool')
        self.assertEqual(next(x for x in specs if x['name']=='libandroid-support')['version'], '29-1')

    def semantic_mutation(self, change):
        m = json.loads(MANIFEST.read_text()); change(m)
        with tempfile.TemporaryDirectory() as td:
            p=pathlib.Path(td)/'manifest.json'; p.write_text(json.dumps(m))
            # Bypass only the outer file checksum to exercise inner semantic gates.
            with mock.patch.object(audit, 'PACKAGE_SET_SHA256', hashlib.sha256(p.read_bytes()).hexdigest()):
                with self.assertRaises(audit.AuditError): audit.validate_manifest(self.args(p))

    def test_gate_mutations_rejected(self):
        for field, value in [('publicationAllowed',True),('deviceInstall','PASS'),('rollback','PASS'),('deviceEvidenceSha256','f'*64)]:
            with self.subTest(field=field): self.semantic_mutation(lambda m:m['releaseGate'].__setitem__(field,value))

    def test_source_builder_and_prefix_mutations_rejected(self):
        for section, key, value in [('source','commit','0'*40),('source','builderImage','latest'),('source','restrictedAppArmorProfileSha256','0'*64),('target','applicationId','com.termux'),('target','modeledPrefix','/usr'),('target','architecture','amd64')]:
            with self.subTest(key=key): self.semantic_mutation(lambda m:m[section].__setitem__(key,value))

    def test_package_identity_mutations_rejected(self):
        for key, value in [('version','0'),('architecture','amd64'),('licenseExpression','MIT'),('recipeSha256','0'*64),('dependencyGroups',[]),('packageType','subpackage')]:
            with self.subTest(key=key): self.semantic_mutation(lambda m:m['packages'][0].__setitem__(key,value))

    def test_runtime_and_license_evidence_mutations_rejected(self):
        for key in ['runtimeDependencies','sourceLicenseEvidence','baseLicenseProviderEvidence','buildModifications','sourceClosure']:
            with self.subTest(key=key): self.semantic_mutation(lambda m:m.__setitem__(key,{}))

    def test_notice_paths_are_explicit_regular_document_targets(self):
        e=audit.EXPECTED_SOURCE_LICENSE_EVIDENCE['openjdk-17']
        self.assertEqual(e['sourceArchives'][0]['sha256'],'ba3ac4b9d7f2c050f46ddcec39b4258660a3f09836f5a71617fd3f7311d06c0b')
        self.assertEqual(set(e['licenseFiles']),{'LICENSE','ADDITIONAL_LICENSE_INFO','ASSEMBLY_EXCEPTION'})
        for path in e['packagePaths'].values(): self.assertTrue(audit.is_license_doc(PREFIX+'/'+path,'openjdk-17',PREFIX))
        self.assertFalse(audit.is_license_doc(PREFIX+'/share/doc/openjdk-17/random.txt','openjdk-17',PREFIX))

    def test_only_canonical_prefixes(self):
        for p in audit.PREFIXES: self.assertEqual(audit.normalize_prefix(p),p)
        for p in ['/usr','/data/data/com.termux/files/usr',PREFIX+'/../x']:
            with self.subTest(p=p), self.assertRaises(audit.AuditError): audit.normalize_prefix(p)

    def test_payload_traversal_and_absolute_members_rejected(self):
        for p in ['../../etc/passwd','/etc/passwd','data/user/0/x/../etc/passwd','data\\user\\x']:
            with self.subTest(p=p), self.assertRaises(audit.AuditError): audit.normalize_member(p)

    def test_private_links(self):
        self.assertEqual(audit.resolve_link(PREFIX+'/lib/x.so','y.so',False,PREFIX),PREFIX+'/lib/y.so')
        for target in ['/system/lib64/libc.so','../../../../../../etc/passwd']:
            with self.subTest(target=target), self.assertRaises(audit.AuditError): audit.resolve_link(PREFIX+'/lib/x.so',target,False,PREFIX)

    def test_embedded_foreign_android_path_rejected(self):
        audit.scan_paths((PREFIX+'/lib/jvm').encode(),PREFIX,'fixture')
        with self.assertRaises(audit.AuditError): audit.scan_paths(b'/data/data/com.termux/files/usr',PREFIX,'fixture')

    def provider_records(self):
        return [{'package':package,'path':path,'soname':None,'needed':[]} for package,path in audit.PACKAGE_FILE_ELF_PROVIDERS.values()]

    def test_exact_no_soname_providers(self):
        rows=self.provider_records(); rows.append({'package':'openjdk-17','path':'lib/jvm/java-17-openjdk/bin/java','soname':None,'needed':['libjli.so','libjvm.so']})
        result=audit.validate_elf_needed_providers(rows,[])
        self.assertIn('libjvm.so',result['providers'])
        self.assertNotIn('libsqlite3.so',result['providers'])

    def test_missing_or_wrong_provider_rejected(self):
        rows=self.provider_records()
        with self.assertRaises(audit.AuditError): audit.validate_elf_needed_providers(rows[1:],[])
        rows[0]['package']='foreign-package'
        with self.assertRaises(audit.AuditError): audit.validate_elf_needed_providers(rows,[])

    def test_unknown_needed_library_rejected(self):
        rows=self.provider_records(); rows[0]['needed']=['libunknown.so']
        with self.assertRaises(audit.AuditError): audit.validate_elf_needed_providers(rows,[])

    def test_ambiguous_soname_rejected(self):
        rows=self.provider_records(); rows += [{'package':'a','path':'lib/a','soname':'same.so','needed':[]},{'package':'b','path':'lib/b','soname':'same.so','needed':[]}]
        with self.assertRaises(audit.AuditError): audit.validate_elf_needed_providers(rows,[])

    def jsig_records(self):
        return self.provider_records()+[{'package':'openjdk-17','path':path,'soname':'libjsig.so','needed':['libdl.so','libc.so'],'interpreter':None,'rpaths':['$ORIGIN'],'sha256':'a'*64} for path in audit.EXPECTED_DUPLICATE_ELF_ALIASES['libjsig.so']['paths']]

    def test_exact_byte_identical_jsig_alias_is_recorded(self):
        result=audit.validate_elf_needed_providers(self.jsig_records(),[])
        self.assertEqual(result['duplicateAliases'][0]['sha256'],'a'*64)
        self.assertEqual(len(result['duplicateAliases'][0]['paths']),2)

    def test_jsig_alias_altered_or_missing_hash_rejected(self):
        for digest in ['b'*64,None,'not-a-hash']:
            rows=self.jsig_records();rows[-1]['sha256']=digest
            with self.subTest(digest=digest),self.assertRaises(audit.AuditError):audit.validate_elf_needed_providers(rows,[])

    def test_jsig_alias_wrong_package_or_path_rejected(self):
        for key,value in [('package','foreign-package'),('path','lib/elsewhere/libjsig.so')]:
            rows=self.jsig_records();rows[-1][key]=value
            with self.subTest(key=key),self.assertRaises(audit.AuditError):audit.validate_elf_needed_providers(rows,[])

    def test_jsig_third_copy_rejected(self):
        rows=self.jsig_records();rows.append({**rows[-1],'path':'lib/third/libjsig.so'})
        with self.assertRaises(audit.AuditError):audit.validate_elf_needed_providers(rows,[])

    def test_jsig_metadata_mismatch_rejected(self):
        for key,value in [('needed',[]),('rpaths',[]),('interpreter','/wrong')]:
            rows=self.jsig_records();rows[-1][key]=value
            with self.subTest(key=key),self.assertRaises(audit.AuditError):audit.validate_elf_needed_providers(rows,[])

    def test_other_identical_soname_duplicate_still_rejected(self):
        rows=self.provider_records()+[{'package':'openjdk-17','path':'lib/'+str(i)+'/other.so','soname':'other.so','needed':[],'sha256':'a'*64} for i in range(2)]
        with self.assertRaises(audit.AuditError):audit.validate_elf_needed_providers(rows,[])

    def test_alias_manifest_policy_mutation_rejected(self):
        self.semantic_mutation(lambda m:m.__setitem__('elfDuplicateAliases',{}))

    def test_bootstrap_license_evidence_is_archive_only(self):
        e=json.loads(MANIFEST.read_text())['baseLicenseProviderEvidence']
        self.assertFalse(e['deviceObserved'])
        self.assertEqual(len(e['licenseFilesSha256']),8)
        self.assertEqual(e['licenseFilesSha256']['share/LICENSES/LGPL-2.0.txt'],'b7993225104d90ddd8024fd838faf300bea5e83d91203eab98e29512acebd69c')

if __name__=='__main__': unittest.main()
