import argparse
import ast
import hashlib
import json
import pathlib
import sys
import unittest

KIT=pathlib.Path(__file__).resolve().parents[1]
ROOT=KIT.parents[1]
sys.path.insert(0,str(KIT))
import audit_cmake_ninja_closure as audit

class BuildContractTests(unittest.TestCase):
    def test_versions_include_every_literal_debian_revision(self):
        c=json.loads((ROOT/'toolchain-candidate-source-closures/cmake-ninja-candidate.json').read_text())
        m=json.loads((ROOT/'cmake-ninja-candidate-package-set.json').read_text())
        specs={x['name']:x for x in m['packages']}
        for x in c['packages']:
            self.assertTrue(x['versionExpressionIsLiteral'])
            self.assertTrue(x['revisionExpressionIsLiteral'])
            revision=x['sourceRevisionExpression']
            expected=x['sourceVersionExpression']+('-'+revision if revision and revision!='0' else '')
            self.assertEqual(specs[x['name']]['version'],expected,x['name'])
            self.assertEqual(audit.EXPECTED_PACKAGES[x['name']][0],expected)
            for key,value in x.items():self.assertEqual(specs[x['name']][key],value,(x['name'],key))
    def test_manifest_hash_is_locked_in_all_consumers(self):
        digest=hashlib.sha256((ROOT/'cmake-ninja-candidate-package-set.json').read_bytes()).hexdigest()
        self.assertEqual(audit.PACKAGE_SET_SHA256,digest)
        for path in [KIT/'build-cmake-ninja-private-aarch64.sh',ROOT/'.github/workflows/cmake-ninja-package-candidate.yml']:
            self.assertIn(digest,path.read_text())
    def providers(self):
        return [{'package':package,'path':path,'soname':None,'needed':[]} for package,path in audit.PACKAGE_FILE_ELF_PROVIDERS.values()]
    def test_unproven_needed_library_rejected_by_real_resolver(self):
        records=self.providers()+[{'package':'cmake','path':'bin/cmake','soname':None,'needed':['libunproven.so']}]
        with self.assertRaisesRegex(audit.AuditError,'ELF_NEEDED_LIBRARY_UNPROVEN'):
            audit.validate_elf_needed_providers(records,[])
    def test_exact_no_soname_provider_and_missing_path(self):
        records=self.providers()+[{'package':'ninja','path':'bin/ninja','soname':None,'needed':['libandroid-spawn.so']}]
        audit.validate_elf_needed_providers(records,[])
        records[0]['path']='lib/unproven.so'
        with self.assertRaisesRegex(audit.AuditError,'ELF_PACKAGE_FILE_PROVIDER_NOT_EXACTLY_ONCE'):
            audit.validate_elf_needed_providers(records,[])
    def test_duplicate_soname_rejected_without_alias_exception(self):
        records=self.providers()+[{'package':p,'path':'lib/libduplicate.so','soname':'libduplicate.so','needed':[]} for p in ('cmake','ninja')]
        with self.assertRaisesRegex(audit.AuditError,'ELF_SONAME_PROVIDER_AMBIGUOUS'):
            audit.validate_elf_needed_providers(records,[])

if __name__=='__main__':unittest.main()
