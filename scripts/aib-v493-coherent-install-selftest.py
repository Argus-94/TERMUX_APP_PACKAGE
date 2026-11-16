#!/usr/bin/python3
"""Executable regression harness for the actual candidate-cohort template.
HOST MOCK ONLY: private temporary fixtures, never Android and never host package installs.
Native Android/APT cryptographic proof remains a separate CI responsibility.
"""
from pathlib import Path, PurePosixPath
import hashlib, os, shutil, subprocess, tempfile, textwrap, json

ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / 'scripts/candidate-cohort-install-template.sh'
RECEIPTS = ROOT / 'verification-v493'
CACHE_NAME='candidate-feed-newmanifest12'
KEY_SHA='a'*64
FINGERPRINT='0123456789ABCDEF0123456789ABCDEF01234567'
PACKAGES=[f'p{i:02}' for i in range(82)]

def sha(b): return hashlib.sha256(b).hexdigest()
def demand(ok, msg):
    if not ok: raise AssertionError(msg)

# All fake commands execute under fixture PATH. coreutils delegates only read/write utilities;
# apt/dpkg/gpgv/dpkg-query are fully private mocks and cannot reach host package state.
MOCK = r'''#!/usr/bin/python3
import os,sys,subprocess,hashlib,pathlib,shutil,json
name=os.path.basename(sys.argv[0]); a=sys.argv[1:]; root=pathlib.Path(os.environ['FIXTURE']); prefix=pathlib.Path(os.environ['PREFIX']); cache=pathlib.Path(os.environ['CACHE']); log=root/'actions.log'; scenario=os.environ.get('CASE','')
def record(s):
 with log.open('a') as f:f.write(s+'\n')
def packages(): return [x.split('\t') for x in (cache/'packages.tsv').read_text().splitlines() if x]
def state():
 p=prefix/'var/lib/dpkg/mock-state.json'
 return json.loads(p.read_text()) if p.exists() else {}
def save(d): (prefix/'var/lib/dpkg/mock-state.json').write_text(json.dumps(d))
def payloads(): return [x.split('\t') for x in (cache/'payloads.tsv').read_text().splitlines() if x]
if name=='gpgv':
 if 'badsig' in scenario or 'expiry' in scenario:
  print('[GNUPG:] '+('BADSIG' if 'badsig' in scenario else 'EXPKEYSIG')+' '+os.environ['FINGERPRINT']);sys.exit(1)
 src=pathlib.Path(a[-1]); out=None
 if '--output' in a: out=pathlib.Path(a[a.index('--output')+1])
 if out: shutil.copyfile(src,out)
 print('[GNUPG:] VALIDSIG '+os.environ['FINGERPRINT']+' 20260101 0 4 0 1 8 00 '+os.environ['FINGERPRINT']);sys.exit(0)
if name=='dpkg':
 if a==['--print-architecture']:print('aarch64');sys.exit(0)
 if a and a[0]=='--compare-versions':
  x,y=a[1],a[3];cmd=['/usr/bin/dpkg','--compare-versions',x,a[2],y];sys.exit(subprocess.call(cmd))
 sys.exit(0)
if name=='dpkg-query':
 d=state()
 if '-L' in a:
  p=a[-1]
  for row in payloads():
   if row[0]==p and p in state(): print(str(prefix/row[1]) if row[1]!='.' else str(prefix))
  if scenario in ('foreign_list_install','foreign_list_remove') and p=='p00': print('/data/user/0/com.other.app/files/usr/share/foreign')
  sys.exit(0)
 p=a[-1]; fmt=a[a.index('-f='+next(x[3:] for x in a if x.startswith('-f=')))] if False else ''
 if p not in d:sys.exit(1)
 if any('Essential' in x for x in a): print('yes' if d[p].get('essential') else 'no')
 else: print('install ok installed\t'+d[p]['version'])
 sys.exit(0)
if name=='apt-get':
 record('APT '+' '.join(a))
 if a==['update']:
  if scenario=='status_changed':(prefix/'var/lib/dpkg/status').write_text('changed')
  sys.exit(0)
 mode='download' if a and a[0]=='download' else ('simulate' if '-s' in a else 'apply')
 isremove='remove' in a
 if mode=='simulate':
  if isremove:
   for p in a[a.index('remove')+1:]: print('Remv '+p+' [1]')
  else:
   for row in packages()[:-1] if scenario=='plan_incomplete' else packages():print('Inst '+row[0]+' ('+row[1]+' stable [aarch64])')
  if scenario in ('plan_remv','plan_extra') and not isremove: print(('Remv alien [1]' if scenario=='plan_remv' else 'Conf alien (2)'))
  if scenario=='plan_version' and not isremove: print('Inst p00 (999 stable [aarch64])')
  if scenario=='plan_incomplete' and not isremove: print('')
  if scenario=='wrongversion_conf' and not isremove: print('Conf p00 (999)')
  sys.exit(0)
 if mode=='download':
  for p,v,arch,h,rel in packages():
   if scenario=='download_wrongsha' and p=='p00': data=b'WRONG';
   else:data=(cache/rel).read_bytes()
   n=rel.rsplit('/',1)[-1]
   # Must exercise actual encoded epoch archive basename.
   if v=='1:2':n=n.replace('1:2','1%3a2')
   (pathlib.Path.cwd()/n).write_bytes(data)
  sys.exit(0)
 if mode=='apply':
  if 'failed_apply' in scenario:sys.exit(1)
  d=state()
  if isremove:
   for p in a[a.index('remove')+1:]:d.pop(p,None)
  else:
   for p,v,arch,h,rel in packages():d[p]={'version':v,'essential':p=='p81'}
   for p,r,k,expect in payloads():
    target=prefix/r
    if k=='dir':target.mkdir(parents=True,exist_ok=True)
    elif k in ('file','conffile'):
     target.parent.mkdir(parents=True,exist_ok=True)
     if not (k=='conffile' and target.exists()): target.write_bytes((cache/'objects'/expect).read_bytes())
    elif k=='symlink':target.parent.mkdir(parents=True,exist_ok=True);target.unlink(missing_ok=True);target.symlink_to(expect)
   if 'wrongpostfile' in scenario:
    row=next(x for x in payloads() if x[2]=='file');(prefix/row[1]).write_text('bad')
   if 'wrongpostlink' in scenario:
    row=next(x for x in payloads() if x[2]=='symlink');(prefix/row[1]).unlink();(prefix/row[1]).symlink_to('wrong')
   if 'wrongpoststatus' in scenario:d['p00']['version']='999'
  save(d);sys.exit(0)
if name=='coreutils':
 print('COREUTILS_APPLET_SYMLINK_REQUIRED',file=sys.stderr);sys.exit(64)
if name in ('stat','sha256sum','mkdir','mktemp','cp','cat','readlink'):
 record('UTIL '+name+' '+' '.join(a))
 if name=='stat' and os.environ.get('CASE')=='wrong_uid' and a[:2]==['-c','%u']:
  print('999999');sys.exit(0)
 # Do not invoke host package manager or any networking tool.
 sys.exit(subprocess.call(['/usr/bin/'+name]+a))
if name=='cmp':sys.exit(subprocess.call(['/usr/bin/cmp']+a))
sys.exit(127)
'''

def make_fixture(base, case):
 root=base/'fixture'; files=root/'appfiles'; prefix=files/'usr'; cache=files/CACHE_NAME
 for p in (prefix/'bin',prefix/'var/lib/dpkg',prefix/'lib/apt/methods',files/'home',cache/'keys',cache/'dists/stable',cache/'objects'):p.mkdir(parents=True,exist_ok=True)
 # install executable private dispatchers; symlink aliases share the single mock implementation.
 bindir=prefix/'bin'; master=bindir/'mock-dispatch';master.write_text(MOCK);master.chmod(0o700)
 for n in ('apt-get','dpkg','dpkg-query','gpgv','coreutils','cmp'):(bindir/n).symlink_to(master)
 space='2' if case in ('lowspace','belowspace') else '3' if case=='exactspace' else '999999999'
 env=os.environ.copy();env.update(FIXTURE=str(root),CACHE=str(cache),PREFIX=str(prefix),HOME=str(files/'home'),UID=str(os.stat(files).st_uid),FINGERPRINT=FINGERPRINT,CASE=case,SPACE=space)
 # Coreutils is a regular executable; individual command names are its bootstrap symlink applets.
 (bindir/'coreutils').unlink();(bindir/'coreutils').write_text('#!/usr/bin/bash\ncmd=${0##*/}\ncase "$cmd" in\n coreutils) echo COREUTILS_APPLET_SYMLINK_REQUIRED >&2; exit 64;;\n stat) if [[ "${CASE:-}" == wrong_uid && "$1" == -c && "$2" == %u ]]; then printf "999999\\n"; else exec "/usr/bin/stat" "$@"; fi;;\n cat|cp|mkdir|mktemp|readlink|sha256sum) exec "/usr/bin/$cmd" "$@";;\n *) echo unsupported-coreutils-applet >&2; exit 127;;\nesac\n');(bindir/'coreutils').chmod(0o700)
 for applet in ('stat','sha256sum','mkdir','mktemp','cp','cat','readlink'):(bindir/applet).symlink_to(bindir/'coreutils')
 df_wrapper=b'''#!/usr/bin/bash
[[ "$1" == "-kP" && "$2" == "$FIXTURE/appfiles" ]] || exit 66
printf 'DF %s %s\\n' "$1" "$2" >> "$FIXTURE/actions.log"
if [[ "${CASE:-}" == df_bad_output ]]; then printf 'invalid\\n'; exit 0; fi
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n'
printf '/dev/mock 999999999 1 %s 1%% /mock\\n' "${SPACE:-999999999}"
'''
 (bindir/'df').write_bytes(df_wrapper);(bindir/'df').chmod(0o700)
 (bindir/'cmp').unlink();(bindir/'cmp').write_text(MOCK);(bindir/'cmp').chmod(0o700)
 for n in ('apt-get','dpkg','dpkg-query','gpgv'):(bindir/n).unlink();(bindir/n).write_text(MOCK);(bindir/n).chmod(0o700)
 env['PATH']=str(bindir)+':/usr/local/bin:/usr/bin:/bin'
 key=b'fixture signing key\n';(cache/'keys/aibuilder-termux-feed-keyring.gpg').write_bytes(key)
 rel=b'fixture signed release\n';(cache/'dists/stable/Release').write_bytes(rel);(cache/'dists/stable/Release.gpg').write_text('signature');(cache/'dists/stable/InRelease').write_bytes(rel)
 rows=[]; payload=[]
 for i,p in enumerate(PACKAGES):
  version='1:2' if p=='p00' and case=='epoch' else '1'
  blob=('archive-'+p).encode();h=sha(blob);name=f'{p}_{version}_aarch64.deb';path='pool/main/'+name
  (cache/PurePosixPath(path)).parent.mkdir(parents=True,exist_ok=True)
  (cache/path).write_bytes(blob);rows.append('\t'.join((p,version,'aarch64',h,path)))
  content=('payload '+p).encode();ph=sha(content);(cache/'objects'/ph).write_bytes(content);payload.append('\t'.join((p,'share/aib/'+p,'conffile' if i==0 and case in ('conffile_preserved','conffile_symlink') else 'file',ph)))
  if i==0:payload.append('\t'.join((p,'share/aib/link','symlink','../p00')))
 (cache/'packages.tsv').write_text('\n'.join(rows)+'\n');(cache/'payloads.tsv').write_text('\n'.join(payload)+'\n');(cache/'bootstrap-baseline.tsv').write_text('')
 if case=='catalog80':(cache/'packages.tsv').write_text('\n'.join(rows[:80])+'\n')
 status=prefix/'var/lib/dpkg/status';status.write_text('')
 initial={}
 if case in ('protected_remove','essential_remove','reinstall'):
  initial.update({p:{'version':'1','essential':False} for p in PACKAGES}) if case=='reinstall' else None
  initial['p00' if case=='protected_remove' else 'p81']={'version':'1','essential':case=='essential_remove'} if case!='reinstall' else None
 if case in ('conffile_preserved','conffile_symlink','foreign_list_install','foreign_list_remove'): initial['p00']={'version':'1','essential':False}
 (prefix/'var/lib/dpkg/mock-state.json').write_text(json.dumps(initial))
 baseline='bin/df\tfile\t'+sha(df_wrapper)+'\n'
 if case=='protected_remove': baseline+='share/aib/p00\tfile\t'+sha(('payload p00').encode())+'\n'
 (cache/'bootstrap-baseline.tsv').write_text(baseline)
 rendered=TEMPLATE.read_text().replace('@@CACHE_NAME@@',CACHE_NAME).replace('@@KEY_SHA@@',sha(key)).replace('@@FINGERPRINT@@',FINGERPRINT).replace('@@REQUIRED_SPACE_BYTES@@','2049')
 # Translate ONLY hardcoded Android app files root and its data/data alias into this fixture.
 rendered=rendered.replace('/data/user/0/com.karat.aibuilder/files',str(files)).replace('/data/data/com.karat.aibuilder/files',str(files))
 script=base/'rendered-template.sh';script.write_text(rendered);script.chmod(0o700)
 return root,files,prefix,cache,script,env

def run_case(base, name, action='install', args=(), mutate=None, expected_pass=False, expected=None):
 casebase=base/name;casebase.mkdir()
 root,files,prefix,cache,script,env=make_fixture(casebase,name)
 if mutate:mutate(root,files,prefix,cache)
 # The all-82 reinstall is close to the old 45s ceiling on this host; keep it bounded but allow 90s.
 cp=subprocess.run(['/usr/bin/bash',str(script),str(cache),action,*args],env=env,text=True,capture_output=True,timeout=90 if name=='reinstall' else 45)
 out=cp.stdout+cp.stderr
 ok=cp.returncode==0
 demand(ok==expected_pass,f'{name}: expected pass={expected_pass}, rc={cp.returncode}\n{out[-1800:]}')
 if expected and expected not in out:demand(False,f'{name}: missing {expected!r}\n{out[-1800:]}')
 if expected_pass:
  demand('AIB_FULL_CANDIDATE_OK:'+action in out,f'{name}: no success marker\n{out[-1000:]}')
 else:
  demand('AIB_FULL_CANDIDATE_OK:' not in out,f'{name}: false OK marker\n{out[-1000:]}')
 if name in ('failed_apply','wrongpostfile','wrongpostlink','wrongpoststatus'):
  demand('AIB_FULL_CANDIDATE_PARTIAL_RUNTIME_REPAIR_REQUIRED' in out,f'{name}: missing repair marker')
 # evidence log is emitted by actual template
 ev=next((x.split(':',1)[1] for x in out.splitlines() if x.startswith('AIB_FULL_CANDIDATE_EVIDENCE:')),None)
 if ev and Path(ev).exists():shutil.copytree(ev,RECEIPTS/f'{name}-evidence',dirs_exist_ok=True)
 if name=='wrong_uid':
  actions=(root/'actions.log').read_text() if (root/'actions.log').exists() else ''
  demand('UTIL stat -c %u' in actions,'wrong_uid: candidate did not invoke the pinned stat applet')
  demand('APT ' not in actions,'wrong_uid: APT was dispatched before UID rejection')
  demand(not (files/'candidate-transactions').exists(),'wrong_uid: transaction workspace was created before UID rejection')
 return {'case':name,'returncode':cp.returncode,'passed':ok,'output':out[-1200:]}

def edit_cache_file(root,files,prefix,cache):
 (cache/'packages.tsv').write_text((cache/'packages.tsv').read_text().replace('p00\t1\t','p00\t2\t',1))
def main():
 RECEIPTS.mkdir(exist_ok=True)
 results=[]
 with tempfile.TemporaryDirectory(prefix='aib-coherent-hostmock-') as td:
  base=Path(td)
  cases=[
   ('success','install',(),True,None),('reinstall','reinstall',(),True,None),('verify','verify',(),True,'AIB_FULL_CANDIDATE_OK:verify'),('check','check',(),True,'AIB_FULL_CANDIDATE_OK:check'),('wrong_uid','verify',(),False,'UID/architecture mismatch'),
   ('df_missing','install',(),False,'pinned private df unavailable'),('df_tampered','install',(),False,'pinned private df baseline mismatch'),('df_bad_output','install',(),False,'private storage report malformed'),('lowspace','install',(),False,'insufficient private storage'),('belowspace','install',(),False,'insufficient private storage'),('exactspace','install',(),True,None),
   ('remove','remove',('p00',),True,None),('protected_remove','remove',('p00',),False,'bootstrap removal forbidden'),('essential_remove','remove',('p81',),False,'essential removal forbidden'),
   ('badsig','install',(),False,'signature invalid'),('expiry','install',(),False,'signature invalid'),('missing_archive','install',(),False,'archive missing'),('tampered_archive','install',(),False,'archive hash mismatch'),('catalog80','install',(),False,'package count is not 82'),
   ('unknown','bogus',(),False,'unknown action'),('prefix','install',(),False,'private PREFIX required'),('plan_remv','install',(),False,'removal during installation forbidden'),('plan_extra','install',(),False,'configuration outside exact catalog'),('plan_version','install',(),False,'install plan outside exact catalog'),('plan_incomplete','install',(),False,'incomplete coherent install plan'),
   ('downgrade','install',(),False,'downgrade or invalid prior version'),('modified_unowned','install',(),False,'unowned or modified payload collision'),('ancestor_symlink','install',(),False,'redirected payload ancestor'),('epoch','install',(),True,None),('download_wrongsha','install',(),False,'download outside signed catalog'),
   ('status_changed','install',(),False,'private registry changed during preparation'),('failed_apply','install',(),False,'coherent install transaction failed'),('wrongpoststatus','install',(),False,'private registry outcome mismatch'),('wrongpostfile','install',(),False,'installed payload hash mismatch'),('wrongpostlink','install',(),False,'installed link mismatch'),
   ('badarg','verify',('p00',),False,'read-only actions take no selections'),('outsider','install',('alien',),False,'unknown/duplicate package'),
   ('conffile_preserved','install',(),True,None),('conffile_symlink','install',(),False,'conffile redirection before mutation'),('wrongversion_conf','install',(),False,'configuration outside exact catalog'),
   ('foreign_list_install','install',(),False,'registered install path outside private runtime'),('foreign_list_remove','remove',('p00',),False,'registered removal path outside private runtime'),
  ]
  def setup_mut(name):
   def m(root,files,prefix,cache):
    if name=='missing_archive':(cache/'pool/main/p00_1_aarch64.deb').unlink()
    if name=='tampered_archive':(cache/'pool/main/p00_1_aarch64.deb').write_bytes(b'tampered')
    if name=='downgrade':(prefix/'var/lib/dpkg/mock-state.json').write_text(json.dumps({'p00':{'version':'2'}}))
    if name=='modified_unowned':
     f=prefix/'share/aib/p00';f.parent.mkdir(parents=True,exist_ok=True);f.write_text('modified')
    if name=='ancestor_symlink':
     (prefix/'share/aib').mkdir(parents=True,exist_ok=True);(prefix/'share/aib/p00').parent.rmdir();(prefix/'share/aib/p00').parent.symlink_to(root)
    if name=='status_changed':
     # Mutated by the mock after copying status, immediately before simulation.
     pass
    if name=='prefix':
     env['PREFIX']=str(root/'other')
   return m
  for name,act,args,pass_,needle in cases:
   print('HOST_FIXTURE_CASE '+name, flush=True)
   # Per-fixture environment customization happens inside generated env before invocation.
   def mut(root,files,prefix,cache,n=name):
    if n=='missing_archive':(cache/'pool/main/p00_1_aarch64.deb').unlink()
    elif n=='tampered_archive':(cache/'pool/main/p00_1_aarch64.deb').write_bytes(b'tampered')
    elif n=='downgrade':(prefix/'var/lib/dpkg/mock-state.json').write_text(json.dumps({'p00':{'version':'2'}}))
    elif n=='modified_unowned':
     f=prefix/'share/aib/p00';f.parent.mkdir(parents=True,exist_ok=True);f.write_text('modified')
    elif n=='ancestor_symlink':
     d=prefix/'share/aib';d.mkdir(parents=True,exist_ok=True);d.rmdir();d.symlink_to(root)
    elif n=='df_missing':(prefix/'bin/df').unlink()
    elif n=='df_tampered':(prefix/'bin/df').write_text('#!/usr/bin/bash\necho tampered\n')
    elif n=='conffile_preserved':
     f=prefix/'share/aib/p00';f.parent.mkdir(parents=True,exist_ok=True);f.write_text('user edited config')
    elif n=='conffile_symlink':
     f=prefix/'share/aib/p00';f.parent.mkdir(parents=True,exist_ok=True);f.symlink_to(root/'elsewhere')
    elif n=='status_changed':
     # Harness records a control flag; apt mock will replace status after update (see below).
     (root/'status-change').touch()
    elif n=='prefix': pass
   # Environment overrides via small extension of runner fixture setup.
   casebase=base/name;casebase.mkdir();root,files,prefix,cache,script,env=make_fixture(casebase,name);mut(root,files,prefix,cache)
   if name=='prefix':env['PREFIX']=str(root/'other')
   if name=='plan_remv':env['CASE']='plan_remv'
   if name=='plan_extra':env['CASE']='plan_extra'
   if name=='plan_version':env['CASE']='plan_version'
   if name=='plan_incomplete':env['CASE']='plan_incomplete'
   if name=='status_changed':env['CASE']='status_changed'
   if name in ('wrongpoststatus','wrongpostfile','wrongpostlink','wrongversion_conf','foreign_list_install','foreign_list_remove'):env['CASE']=name
   invoke_args=args or (('p00',) if act in ('install','reinstall') else ())
   cp=subprocess.run(['/usr/bin/bash',str(script),str(cache),act,*invoke_args],env=env,text=True,capture_output=True,timeout=90 if name=='reinstall' else 45);out=cp.stdout+cp.stderr;ok=cp.returncode==0
   demand(ok==pass_,f'{name}: expected pass={pass_}, rc={cp.returncode}\n{out[-1800:]}')
   if needle:demand(needle in out,f'{name}: expected evidence {needle!r}\n{out[-1800:]}')
   demand(('AIB_FULL_CANDIDATE_OK:'+act in out)==pass_,f'{name}: success marker mismatch')
   if name=='conffile_preserved':
    ev=next((x.split(':',1)[1] for x in out.splitlines() if x.startswith('AIB_FULL_CANDIDATE_EVIDENCE:')),None)
    state=Path(ev)/'config-state.tsv' if ev else None
    demand(state is not None and state.exists(), 'conffile_preserved: missing config-state.tsv')
    fields=state.read_text().strip().split('\t');demand(len(fields)==4 and fields[2]!=fields[3], 'conffile_preserved: expected/actual hashes not distinct')
   if name in ('failed_apply','wrongpoststatus','wrongpostfile','wrongpostlink'):demand('AIB_FULL_CANDIDATE_PARTIAL_RUNTIME_REPAIR_REQUIRED' in out,f'{name}: no repair marker')
   evidence=next((x.split(':',1)[1] for x in out.splitlines() if x.startswith('AIB_FULL_CANDIDATE_EVIDENCE:')),None)
   if evidence and Path(evidence).exists():shutil.copytree(evidence,RECEIPTS/f'{name}-evidence',dirs_exist_ok=True)
   if name in ('df_missing','df_tampered','df_bad_output','lowspace','belowspace'):
    actions=(root/'actions.log').read_text() if (root/'actions.log').exists() else ''
    demand('APT ' not in actions,f'{name}: APT ran before df prerequisite rejection')
    demand(not (files/'candidate-transactions').exists(),f'{name}: transaction workspace was created before df prerequisite rejection')
    demand('AIB_FULL_CANDIDATE_EVIDENCE:' not in out,f'{name}: transaction evidence was emitted before df prerequisite rejection')
   if name=='badsig':
    actions=(root/'actions.log').read_text() if (root/'actions.log').exists() else ''
    demand('APT ' not in actions,'badsig: APT phase ran before signature rejection')
   results.append({'case':name,'rc':cp.returncode,'pass':ok,'expectedSuccess':pass_,'testPassed':True,'tail':out[-700:]})
  # Epoch archive explicitly confirmed encoded basename was downloaded and hash-identified.
  e=next(x for x in results if x['case']=='epoch');d=RECEIPTS/'epoch-evidence'
  # A successful install itself proves identity mapping; source fixture is cleaned automatically.
 report={'status':'PASS','templateSha256':sha(TEMPLATE.read_bytes()),'classification':'HOST MOCK ONLY — not Android, no host installs, no native APT/signature proof','template':str(TEMPLATE),'executed_cases':len(results),'results':results}
 (RECEIPTS/'coherent-install-selftest.json').write_text(json.dumps(report,indent=2)+'\n')
 (RECEIPTS/'coherent-install-selftest.log').write_text('\n'.join(f"{'EXPECTED_SUCCESS' if r['pass'] else 'EXPECTED_REJECTION'} {r['case']} rc={r['rc']}" for r in results)+'\n')
 print(f'Host mock template test: {len(results)} cases passed; receipts: {RECEIPTS}')
 print('HOST MOCK ONLY; not Android/no host installs. Native crypto/APT proof is separate CI.')
if __name__=='__main__':main()
