#!/usr/bin/env python3
import importlib.util, unittest, tempfile, os, subprocess
from pathlib import Path
spec=importlib.util.spec_from_file_location('audit',str(Path(__file__).resolve().parents[1]/'audit-unified-elf-symbols.py')); a=importlib.util.module_from_spec(spec); spec.loader.exec_module(a)
def obj(path,source='candidate',soname=None,needed=(),exports=(),imports=(),digest='x'):
    return {'path':path,'source':source,'soname':soname,'needed':list(needed),'exports':list(exports),'imports':list(imports),'sha256':digest}
def exp(name,version=None,default=True,typ='FUNC',bind='GLOBAL'): return {'name':name,'version':version,'default':default,'type':typ,'bind':bind}
def imp(name,version=None,weak=False,typ='FUNC'): return {'name':name,'version':version,'weak':weak,'type':typ}
class Tests(unittest.TestCase):
    def test_versioned_default_matches_versioned_and_unversioned(self): self.assertTrue(a.export_matches(exp('f','V2'),imp('f','V2'))); self.assertTrue(a.export_matches(exp('f','V2'),imp('f')))
    def test_nondefault_only_versioned(self): self.assertTrue(a.export_matches(exp('f','V1',False),imp('f','V1'))); self.assertFalse(a.export_matches(exp('f','V1',False),imp('f')))
    def test_weak_unresolved_allowed(self):
        errors,ctx,weak,unres=a.resolve_inventory([obj('consumer',imports=[imp('optional',weak=True)])]); self.assertFalse(errors or ctx or unres); self.assertEqual(len(weak),1)
    def test_missing_import_fails(self): self.assertEqual(len(a.resolve_inventory([obj('consumer',imports=[imp('missing')])])[3]),1)
    def test_conflicting_candidate_soname(self): self.assertTrue(any('conflicting' in e for e in a.resolve_inventory([obj('a',soname='libx.so',digest='a'),obj('b',soname='libx.so',digest='b')])[0]))
    def test_tls_consistency(self): self.assertFalse(a.export_matches(exp('x',typ='OBJECT'),imp('x',typ='TLS'))); self.assertTrue(a.export_matches(exp('x',typ='TLS'),imp('x',typ='TLS')))
    def test_candidate_preferred_platform_and_masked_fallback_is_unresolved(self):
        cand=obj('candidate-lib',soname='libx.so',exports=[exp('present')]); plat=obj('platform-lib',source='platform',soname='libx.so',exports=[exp('present'),exp('platform_extra')]); c=obj('consumer',needed=['libx.so'],imports=[imp('platform_extra')]); self.assertEqual(len(a.resolve_inventory([cand,plat,c])[3]),1)
    def test_platform_stub_is_not_provider_or_context(self):
        stub=obj('stub',source='platform',soname='libstub.so',exports=[exp('known')]); c=obj('consumer',imports=[imp('known')]); errors,ctx,_,unres=a.resolve_inventory([stub,c]); self.assertFalse(errors or ctx); self.assertEqual(unres[0]['symbol'],'known')
    def test_tls_type_checked_during_inventory_resolution(self):
        provider=obj('provider',soname='p.so',exports=[exp('x',typ='OBJECT')]); c=obj('consumer',needed=['p.so'],imports=[imp('x',typ='TLS')]); self.assertEqual(a.resolve_inventory([provider,c])[3][0]['symbol'],'x')
    def test_context_only_candidate_provider(self):
        dep=obj('libdep',soname='libdep.so',exports=[exp('external')]); c=obj('consumer',imports=[imp('external')]); errors,ctx,_,unres=a.resolve_inventory([dep,c]); self.assertFalse(errors or unres); self.assertEqual(ctx[0]['symbol'],'external')
    def test_transitive_needed_resolution(self):
        leaf=obj('leaf',soname='l.so',exports=[exp('ok')]); middle=obj('middle',soname='m.so',needed=['l.so']); c=obj('c',needed=['m.so'],imports=[imp('ok')]); self.assertFalse(any(a.resolve_inventory([leaf,middle,c])))
    def test_dynamic_fields(self): self.assertEqual(a.parse_dynamic(' 0x1 (NEEDED) Shared library: [liba.so]\n 0xe (SONAME) Library soname: [libb.so]\n 0x1d (RUNPATH) Library runpath: [$ORIGIN/lib]'),('libb.so',['liba.so'],['$ORIGIN/lib']))
    def test_symbol_parser_versions_bindings_sizes_and_local_ignore(self):
        text=''' 1: 00000000 10 FUNC GLOBAL DEFAULT 1 d@@V2\n 2: 00000000 10 FUNC GLOBAL DEFAULT 1 n@V1\n 3: 00000000 10 FUNC GLOBAL DEFAULT 1 z\n 4: 00000000 10 FUNC GLOBAL DEFAULT UND u@V1\n 5: 00000000 10 FUNC WEAK DEFAULT UND w\n 6: 00000000 10 FUNC LOCAL DEFAULT UND local\n 7: 00000000 a FUNC GNU_UNIQUE DEFAULT 1 unique\n'''
        imports,exports=a.parse_symbols(text); self.assertEqual([(x['name'],x['version'],x['weak']) for x in imports],[('u','V1',False),('w',None,True)]); self.assertEqual({(x['name'],x['version'],x['default'],x['bind']) for x in exports},{('d','V2',True,'GLOBAL'),('n','V1',False,'GLOBAL'),('z',None,True,'GLOBAL'),('unique',None,True,'GNU_UNIQUE')})
    def test_readelf_command_uses_dynsym_and_c_locale(self):
        seen={}; old=a.subprocess.run
        def fake(cmd,**kw): seen.update(cmd=cmd,env=kw['env']); return type('P',(),{'returncode':0,'stdout':'','stderr':''})()
        a.subprocess.run=fake
        try: a.run_readelf('/tmp/input','s')
        finally: a.subprocess.run=old
        self.assertIn('--dyn-syms',seen['cmd']); self.assertNotIn('-Ws',seen['cmd']); self.assertEqual(seen['env']['LC_ALL'],'C')
    def test_empty_dirs_fail(self):
        with tempfile.TemporaryDirectory() as t:
            self.assertRaises(ValueError,a.candidate_debs,t,t)
    def test_nonloadable_rejected(self):
        old=a.run_readelf
        a.run_readelf=lambda p,m: {'h':'  Type: REL (Relocatable file)\n  Class: ELF64\n  Data: 2\'s complement, little endian\n  Machine: AArch64','l':'','d':'','s':''}[m]
        try: self.assertRaises(ValueError,a.process_elf,'/bin/true','candidate','true')
        finally: a.run_readelf=old
    def test_actual_wrong_arch_negative_no_execution(self):
        if not os.path.exists('/bin/true'): self.skipTest('/bin/true unavailable')
        with self.assertRaises(ValueError): a.process_elf('/bin/true','candidate','/bin/true')
    def test_reachable_api_stub_exports_are_interfaces(self):
        platform=obj('libc-api24',source='platform',soname='libc.so',exports=[exp('puts','LIBC')])
        c=obj('consumer',needed=['libc.so'],imports=[imp('puts','LIBC')])
        self.assertFalse(any(a.resolve_inventory([platform,c])))
    def test_unneeded_api_stub_is_not_global_runtime_context(self):
        platform=obj('libc-api24',source='platform',soname='libc.so',exports=[exp('puts','LIBC')])
        c=obj('consumer',imports=[imp('puts','LIBC')])
        errors,context,weak,missing=a.resolve_inventory([platform,c])
        self.assertFalse(errors or context or weak);self.assertEqual(len(missing),1)
    def test_readelf_unique_export(self):
        imports,exports=a.parse_symbols(' 1: 0000000000000100 0x10000 OBJECT UNIQUE DEFAULT 12 shared_var')
        self.assertFalse(imports);self.assertEqual(exports[0]['name'],'shared_var')

if __name__=='__main__': unittest.main(verbosity=2)
