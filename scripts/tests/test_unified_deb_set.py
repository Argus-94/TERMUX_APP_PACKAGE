import importlib.util, json, pathlib, shutil, subprocess, tempfile, unittest
SCRIPT=pathlib.Path(__file__).parents[1]/'audit-unified-deb-set.py'
s=importlib.util.spec_from_file_location('unified',SCRIPT); U=importlib.util.module_from_spec(s); s.loader.exec_module(U)
PREFIX='/tmp/approved-private-prefix'
class UnifiedTests(unittest.TestCase):
 def setUp(self): self.t=tempfile.TemporaryDirectory(); self.root=pathlib.Path(self.t.name); self.debs=[]
 def tearDown(self): self.t.cleanup()
 def pkg(self,name,version='1',fields='',files=None,modes=None):
  d=self.root/(name+'-'+str(len(list(self.root.glob('*/DEBIAN/control'))))); (d/'DEBIAN').mkdir(parents=True); (d/'DEBIAN/control').write_text(f'Package: {name}\nVersion: {version}\nArchitecture: all\n{fields}\n')
  for path,val in (files or {}).items():
   q=d/path; q.parent.mkdir(parents=True,exist_ok=True)
   if isinstance(val,tuple) and val[0]=='symlink': q.symlink_to(val[1])
   elif isinstance(val,tuple) and val[0]=='hardlink':
    target=d/val[1]; target.parent.mkdir(parents=True,exist_ok=True); target.write_text('contents'); q.parent.mkdir(parents=True,exist_ok=True); q.hardlink_to(target)
   else: q.write_text(val)
  for path,mode in (modes or {}).items(): (d/path).chmod(mode)
  out=self.root/(name+'-'+str(len(self.debs))+'.deb'); subprocess.run(['dpkg-deb','--root-owner-group','--build',str(d),str(out)],check=True,capture_output=True); self.debs.append(out); return out
 def manifest(self,*items):
  p=self.root/'manifest.json'; p.write_text(json.dumps({'packages':[{'name':n,'version':v,'architecture':'all'} for n,v in items]})); return p
 def runaudit(self,manifest=None,debs=None):
  paths=debs or self.debs
  pairs=[(U.inspect(x,PREFIX)[0]['package'],U.inspect(x,PREFIX)[0]['version']) for x in paths]
  return U.audit(manifest or self.manifest(*pairs),PREFIX,paths)
 def test_valid_virtual_dependency_and_links(self):
  self.pkg('provider',fields='Provides: virt (= 2)\n',files={PREFIX.lstrip('/')+'/data':'contents',PREFIX.lstrip('/')+'/relative':('symlink','data'),PREFIX.lstrip('/')+'/hard':('hardlink',PREFIX.lstrip('/')+'/data')})
  self.pkg('consumer',fields='Depends: virt (>= 2)\n',files={PREFIX.lstrip('/')+'/consumer':'ok'})
  self.assertEqual(self.runaudit()['packageCount'],2)
 def test_missing_dependency_conflict_breaks(self):
  self.pkg('a',fields='Depends: absent\n');
  with self.assertRaisesRegex(U.Reject,'DEPENDENCY_UNSATISFIED'): self.runaudit()
 def test_virtual_conflicts_and_version_breaks(self):
  self.pkg('provider',fields='Provides: virt (= 2)\n')
  self.pkg('bad',fields='Conflicts: virt\n')
  with self.assertRaisesRegex(U.Reject,'CONFLICT_OR_BREAKS'): self.runaudit()
 def test_breaks_version(self):
  self.pkg('a',fields='Breaks: b (<< 2)\n'); self.pkg('b','1')
  with self.assertRaisesRegex(U.Reject,'CONFLICT_OR_BREAKS'): self.runaudit()
 def test_duplicate_identity_hash_differs(self):
  a=self.pkg('a',files={PREFIX.lstrip('/')+'/a':'a'}); b=self.pkg('a',files={PREFIX.lstrip('/')+'/a':'b'})
  with self.assertRaisesRegex(U.Reject,'DUPLICATE_PACKAGE_DIFFERENT_HASH'): self.runaudit(self.manifest(('a','1')),[a,b])
 def test_cross_package_collision(self):
  self.pkg('a',files={PREFIX.lstrip('/')+'/same':'a'}); self.pkg('b',files={PREFIX.lstrip('/')+'/same':'a'})
  with self.assertRaisesRegex(U.Reject,'CROSS_PACKAGE_COLLISION'): self.runaudit()
 def test_symlink_escape_and_cycle_and_file_ancestor(self):
  for spec,code in [({'escape':('symlink','../../../../etc/passwd')},'LINK_ESCAPE'),({'one':('symlink','two'),'two':('symlink','one')},'SYMLINK_CYCLE')]:
   self.debs=[]; self.pkg('bad',files={PREFIX.lstrip('/')+'/'+k:v for k,v in spec.items()})
   with self.assertRaises(U.Reject): self.runaudit()
 def test_componentwise_directory_alias_and_file_link_chain(self):
  base=PREFIX.lstrip('/')+'/lib/icu/'
  self.pkg('icu',files={base+'78.3/Makefile.inc':'icu',base+'current':('symlink','78.3'),base+'Makefile.inc':('symlink','current/Makefile.inc')})
  self.assertEqual(self.runaudit()['packageCount'],1)
 def test_private_prefix_does_not_require_android_ancestor_members(self):
  from unittest.mock import patch
  base=PREFIX.lstrip('/')+'/'
  self.pkg('prefix-only',files={base+'file':'ok',base+'alias':('symlink','file')})
  original=U.inspect
  def confined_inspect(path,prefix):
   ctl,ident,digest,entries=original(path,prefix)
   root=prefix.lstrip('/')
   return ctl,ident,digest,{n:e for n,e in entries.items() if n==root or n.startswith(root+'/')}
  with patch.object(U,'inspect',side_effect=confined_inspect): self.assertEqual(self.runaudit()['packageCount'],1)
 def test_multiple_leaf_aliases_and_absolute_private_target(self):
  base=PREFIX.lstrip('/')+'/'
  self.pkg('aliases',files={base+'file':'ok',base+'second':('symlink','file'),base+'first':('symlink','second'),base+'absolute':('symlink',PREFIX+'/first')})
  self.assertEqual(self.runaudit()['packageCount'],1)
 def test_symlink_component_escape_and_alias_parent_semantics(self):
  base=PREFIX.lstrip('/')+'/tree/'
  self.pkg('bad',files={base+'real/file':'file',base+'alias':('symlink','real'),base+'escape':('symlink','alias/../../../../outside'),base+'walk':('symlink','alias/..')})
  with self.assertRaisesRegex(U.Reject,'LINK_ESCAPE'): self.runaudit()
  self.debs=[]
  self.pkg('good',files={base+'dir/file':'ok',base+'alias':('symlink','dir'),base+'walk':('symlink','alias/..')})
  self.assertEqual(self.runaudit()['packageCount'],1)
 def test_parent_component_uses_resolved_directory_alias(self):
  base=PREFIX.lstrip('/')+'/tree/'
  self.pkg('physical-parent',files={base+'deep/real/file':'ok',base+'deep/target':'target',base+'alias':('symlink','deep/real'),base+'walk':('symlink','alias/../target')})
  self.assertEqual(self.runaudit()['packageCount'],1)
 def test_directory_alias_cycles_and_finite_dot_alias(self):
  base=PREFIX.lstrip('/')+'/tree/'
  self.pkg('loop',files={base+'a':('symlink','b'),base+'b':('symlink','a')})
  with self.assertRaisesRegex(U.Reject,'SYMLINK_CYCLE'): self.runaudit()
  self.debs=[]
  self.pkg('finite',files={base+'alias':('symlink','.'),base+'file':'ok',base+'walk':('symlink','alias/alias/file')})
  self.assertEqual(self.runaudit()['packageCount'],1)
 def test_symlink_to_regular_file_with_suffix_rejected(self):
  base=PREFIX.lstrip('/')+'/tree/'
  self.pkg('bad',files={base+'file':'x',base+'alias':('symlink','file/child')})
  with self.assertRaises(U.Reject): self.runaudit()
 def test_cross_package_hardlink_rejected(self):
  self.pkg('a',files={PREFIX.lstrip('/')+'/real':'x'}); self.pkg('b',files={PREFIX.lstrip('/')+'/link':('hardlink',PREFIX.lstrip('/')+'/real')})
  with self.assertRaisesRegex(U.Reject,'CROSS_PACKAGE_COLLISION|HARDLINK_CROSS_PACKAGE'): self.runaudit()
 def test_self_conflicting_virtual_does_not_conflict_with_unrelated_package(self):
  self.pkg('provider',fields='Provides: virt\nConflicts: virt\n'); self.pkg('unrelated')
  self.assertEqual(self.runaudit()['packageCount'],2)
 def test_shared_directory_mode_divergence_rejected(self):
  self.pkg('a',files={PREFIX.lstrip('/')+'/a':'a'},modes={PREFIX.lstrip('/'):0o700})
  self.pkg('b',files={PREFIX.lstrip('/')+'/b':'b'},modes={PREFIX.lstrip('/'):0o755})
  with self.assertRaisesRegex(U.Reject,'CROSS_PACKAGE_COLLISION'): self.runaudit()
 def test_missing_manifest_identity(self):
  self.pkg('a')
  with self.assertRaisesRegex(U.Reject,'MANIFEST_PACKAGE_MISMATCH'): self.runaudit(self.manifest(('b','1')))
if __name__=='__main__': unittest.main()
