#!/usr/bin/env python3
import importlib.util, unittest, tempfile, os, subprocess
from pathlib import Path
spec=importlib.util.spec_from_file_location('audit',str(Path(__file__).resolve().parents[1]/'audit-unified-elf-symbols.py')); a=importlib.util.module_from_spec(spec); spec.loader.exec_module(a)
def obj(path,source='candidate',soname=None,needed=(),exports=(),imports=(),digest='x'):
    return {'path':path,'source':source,'soname':soname,'needed':list(needed),'exports':list(exports),'imports':list(imports),'sha256':digest,'elfType':'DYN'}
def exp(name,version=None,default=True,typ='FUNC',bind='GLOBAL'): return {'name':name,'version':version,'default':default,'type':typ,'bind':bind}
def imp(name,version=None,weak=False,typ='FUNC'): return {'name':name,'version':version,'weak':weak,'type':typ}
class Tests(unittest.TestCase):
    def test_versioned_default_matches_versioned_and_unversioned(self): self.assertTrue(a.export_matches(exp('f','V2'),imp('f','V2'))); self.assertTrue(a.export_matches(exp('f','V2'),imp('f')))
    def test_nondefault_only_versioned(self): self.assertTrue(a.export_matches(exp('f','V1',False),imp('f','V1'))); self.assertFalse(a.export_matches(exp('f','V1',False),imp('f')))
    def test_weak_unresolved_allowed(self):
        errors,ctx,weak,unres=a.resolve_inventory([obj('consumer',imports=[imp('optional',weak=True)])]); self.assertFalse(errors or ctx or unres); self.assertEqual(len(weak),1)
    def test_missing_import_fails(self): self.assertEqual(len(a.resolve_inventory([obj('consumer',imports=[imp('missing')])])[3]),1)
    def test_conflicting_candidate_soname(self): self.assertTrue(any('conflicting' in e for e in a.resolve_inventory([obj('a',soname='libx.so',digest='a'),obj('b',soname='libx.so',digest='b')])[0]))
    def test_filename_only_provider_resolves_needed(self):
        provider=obj('usr/lib/libx.so',exports=[exp('ok')]); c=obj('consumer',needed=['libx.so'],imports=[imp('ok')])
        self.assertFalse(any(a.resolve_inventory([provider,c])))
    def test_absolute_needed_requires_exact_path(self):
        provider=obj('libx.so',exports=[exp('ok')]); c=obj('consumer',needed=['/system/lib64/libx.so'],imports=[imp('ok')])
        self.assertTrue(any('unknown DT_NEEDED /system/lib64/libx.so' in e for e in a.resolve_inventory([provider,c])[0]))
    def test_nonloadable_filename_cannot_provide(self):
        for typ in ('EXEC','REL'):
            provider=obj('libx.so',exports=[exp('ok')]); provider['elfType']=typ
            c=obj('consumer',needed=['libx.so'],imports=[imp('ok')])
            self.assertTrue(any('unknown DT_NEEDED libx.so' in e for e in a.resolve_inventory([provider,c])[0]))
    def test_filename_candidate_shadows_platform_export(self):
        candidate=obj('usr/lib/libx.so',exports=[exp('present')]); platform=obj('stub',source='platform',soname='libx.so',exports=[exp('platform_extra')]); c=obj('consumer',needed=['libx.so'],imports=[imp('platform_extra')])
        self.assertEqual(len(a.resolve_inventory([candidate,platform,c])[3]),1)
    def test_conflicting_candidate_filename_fails_closed(self):
        a1=obj('usr/lib/libx.so',digest='a'); a2=obj('opt/libx.so',digest='b'); c=obj('consumer',needed=['libx.so'])
        self.assertTrue(any('conflicting candidate providers for filename libx.so'==e for e in a.resolve_inventory([a1,a2,c])[0]))
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
    def test_rel_is_separate_inventory_not_runtime_provider(self):
        header="  Type: REL (Relocatable file)\n  Class: ELF64\n  Data: 2\'s complement, little endian\n  Machine: AArch64"
        with tempfile.NamedTemporaryFile() as f:
            f.write(b'relocatable fixture'); f.flush()
            old=a.run_readelf
            a.run_readelf=lambda p,m: header if m=='h' else (_ for _ in ()).throw(AssertionError('REL must not reach runtime readelf modes'))
            try: record=a.process_elf(f.name,'candidate','usr/lib/python3.14/config-3.14-aarch64-linux-android/python.o: REL','python-dev.deb')
            finally: a.run_readelf=old
        self.assertEqual((record['elfType'],record['staticLinkAbi'],record['package']),('REL','NOT_PROVEN','python-dev.deb'))
        self.assertEqual(record['sha256'],__import__('hashlib').sha256(b'relocatable fixture').hexdigest())
        self.assertNotIn('soname',record); self.assertEqual(a.resolve_inventory([obj('consumer',needed=['python.o'])])[0],['consumer: unknown DT_NEEDED python.o'])
    def test_loadable_elf_still_processed_and_nonrel_types_rejected(self):
        base="  Class: ELF64\n  Data: 2\'s complement, little endian\n  Machine: AArch64\n"
        with tempfile.NamedTemporaryFile() as f:
            f.write(b'loadable fixture'); f.flush()
            old=a.run_readelf
            def fake(p,m):
                if m=='h': return base+'  Type: DYN (Shared object file)\n'
                return {'l':'','d':' 0x1 (SONAME) Library soname: [libok.so]','s':''}[m]
            a.run_readelf=fake
            try: load=a.process_elf(f.name,'candidate','libok.so')
            finally: a.run_readelf=old
            self.assertEqual(load['soname'],'libok.so')
            for typ in ('CORE','MALFORMED'):
                a.run_readelf=lambda p,m,t=typ: base+(f'  Type: {t} (Core file)\n' if t=='CORE' else '')
                try:
                    with self.assertRaises(ValueError): a.process_elf(f.name,'candidate','bad')
                finally: a.run_readelf=old
            a.run_readelf=lambda p,m: "  Class: ELF64\n  Data: 2's complement, little endian\n  Machine: Intel 80386\n  Type: REL (Relocatable file)\n"
            try:
                with self.assertRaisesRegex(ValueError,'foreign ELF rejected'): a.process_elf(f.name,'candidate','foreign-rel')
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
    def test_alias_name_resolves_actual_nosoname_dyn_provider(self):
        provider=obj('usr/lib/libsqlite3.so.3.50.0',exports=[exp('sqlite3_open')]); provider['elfType']='DYN'; provider['providerNames']=['libsqlite3.so']
        c=obj('consumer',needed=['libsqlite3.so'],imports=[imp('sqlite3_open')])
        self.assertFalse(any(a.resolve_inventory([provider,c])))
    def test_alias_chain_is_lexically_confined(self):
        target='usr/lib/libsqlite3.so.3'
        self.assertEqual(a._link_target('usr/lib/libsqlite3.so','libsqlite3.so.3'),target)
        self.assertEqual(a._link_target('usr/lib/libsqlite3.so','/data/user/0/com.karat.aibuilder/files/usr/usr/lib/libsqlite3.so.3'),target)
        self.assertIsNone(a._link_target('usr/lib/libsqlite3.so','/system/lib64/libsqlite3.so'))
        self.assertIsNone(a._link_target('usr/lib/libx.so','../../../../escape'))
    def test_duplicate_alias_providers_fail_closed(self):
        x=obj('usr/lib/real-a.so',digest='a'); x['providerNames']=['libalias.so']
        y=obj('usr/lib/real-b.so',digest='b'); y['providerNames']=['libalias.so']
        errs=a.resolve_inventory([x,y,obj('consumer',needed=['libalias.so'])])[0]
        self.assertTrue(any('ambiguous candidate alias libalias.so' in e for e in errs))
    def test_absolute_needed_is_never_reduced_to_basename(self):
        provider=obj('usr/lib/libx.so',exports=[exp('ok')]); c=obj('consumer',needed=['/other/path/libx.so'],imports=[imp('ok')])
        self.assertTrue(any('unknown DT_NEEDED /other/path/libx.so' in e for e in a.resolve_inventory([provider,c])[0]))
    def test_readelf_unique_export(self):
        imports,exports=a.parse_symbols(' 1: 0000000000000100 0x10000 OBJECT UNIQUE DEFAULT 12 shared_var')
        self.assertFalse(imports);self.assertEqual(exports[0]['name'],'shared_var')

if __name__=='__main__': unittest.main(verbosity=2)
