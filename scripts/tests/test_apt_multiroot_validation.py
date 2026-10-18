#!/usr/bin/env python3
"""Validate multi-root request parsing without APT, signing or fabricated debs."""
import pathlib
import subprocess
import unittest
ROOT=pathlib.Path(__file__).resolve().parents[2]
HELPER=ROOT/'scripts/test-apt-candidate.sh'

class MultiRootValidationTests(unittest.TestCase):
    def parse(self, spec=None):
        text=HELPER.read_text()
        chunk=text.split('INSTALL_SPECS=("$PACKAGE=$VERSION")',1)[1].split('[[ -f "$MANIFEST" ]]',1)[0]
        script='set -Eeuo pipefail\nPACKAGE=cmake\nVERSION=4.4.4\nfail(){ echo "ERROR:$*" >&2; exit 2; }\nINSTALL_SPECS=("$PACKAGE=$VERSION")'+chunk+'printf "%s\\n" "${INSTALL_SPECS[@]}"\n'
        args=['bash','-c',script,'parser']+['unused']*6
        if spec is not None:args.append(spec)
        return subprocess.run(args,text=True,capture_output=True)
    def test_single_root_unchanged(self):
        p=self.parse();self.assertEqual(p.returncode,0,p.stderr);self.assertEqual(p.stdout.splitlines(),['cmake=4.4.4'])
    def test_two_exact_roots(self):
        p=self.parse('ninja=1.13.2');self.assertEqual(p.returncode,0,p.stderr);self.assertEqual(p.stdout.splitlines(),['cmake=4.4.4','ninja=1.13.2'])
    def test_invalid_or_option_like_spec_rejected(self):
        for spec in ['--allow-unauthenticated','ninja','ninja>=1.13.2','ninja=1.13.2 other','ninja=1.13.2;echo bad','ninja=','../ninja=1','ninja=1=2']:
            with self.subTest(spec=spec):
                p=self.parse(spec);self.assertEqual(p.returncode,2);self.assertIn('ADDITIONAL_ROOT_SPEC_INVALID',p.stderr)
    def test_duplicate_primary_rejected(self):
        p=self.parse('cmake=4.4.4');self.assertEqual(p.returncode,2);self.assertIn('ADDITIONAL_ROOT_DUPLICATES_PRIMARY',p.stderr)
    def test_simulation_and_download_use_same_quoted_array(self):
        s=HELPER.read_text();self.assertIn('install "${INSTALL_SPECS[@]}"',s);self.assertIn('download "${INSTALL_SPECS[@]}"',s)
        self.assertIn('((downloaded_matches == 1))',s)

if __name__=='__main__':unittest.main()
