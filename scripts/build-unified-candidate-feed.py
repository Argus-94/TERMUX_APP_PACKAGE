#!/usr/bin/env python3
"""Candidate-only aggregate feed; never installs, never uses a production signer."""
import argparse,gzip,hashlib,json,os,pathlib,re,shutil,subprocess,sys,tempfile
ROOTS=['make','gh','git','curl','wget','pkg-config','python','nodejs','npm','openjdk-17','cmake','ninja']
def need(ok,reason):
 if not ok:raise ValueError(reason)
def digest(path):
 with path.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def records(text):
 result=[];row={};last=None
 for line in text.splitlines()+['']:
  if not line:
   if row:result.append(row);row={};last=None
  elif line[:1].isspace():
   need(last is not None,'ORPHAN_CONTINUATION');row[last]+='\n'+line
  else:
   key,sep,value=line.partition(':');need(sep and key not in row,'BAD_OR_DUPLICATE_FIELD');row[key]=value.strip();last=key
 return result
def invoke(args,env=None,cwd=None,log=None,stdin=None,stdout=None):
 p=subprocess.run([str(x) for x in args],env=env if env is not None else {k:v for k,v in os.environ.items() if k in {'PATH','HOME','LANG','LC_ALL','TMPDIR'}},cwd=cwd,stdin=stdin,stdout=stdout if stdout is not None else subprocess.PIPE,stderr=subprocess.PIPE)
 if log:log.write_bytes((p.stdout or b'')+(p.stderr or b''))
 if p.returncode:raise RuntimeError('COMMAND_REJECTED '+str(args[0])+' '+(p.stderr or b'').decode('utf8','replace')[-2000:])
 return p.stdout

def build(repo,manifest,packages,out,test_roots=None,support_bundle_dir=None,support_fingerprint=None,support_producer=None):
 repo=repo.resolve(strict=True);packages=packages.resolve(strict=True);out=out.absolute();m=json.loads(manifest.read_text());gate=m['releaseGate'];roots=test_roots or ROOTS
 need(not out.exists(),'OUTPUT_MUST_BE_NEW');need(m.get('channel')=='candidate-only' and m.get('productionAllowed') is False and m.get('qualified') is False and gate.get('publicationAllowed') is False,'GATES_MUST_REMAIN_CLOSED')
 synthetic=m.get('testOnlySynthetic') is True
 need(not test_roots or synthetic,'TEST_ONLY_ROOTS_REQUIRES_SYNTHETIC_MANIFEST');need(len(roots)==len(set(roots)) and roots,'ROOTS_INVALID')
 specs={(r['name'],r['version'],r['architecture']):r for r in m['packages']};need(len(specs)==len(m['packages']),'MANIFEST_DUPLICATE');arch=m['target']['architecture'];need(arch in ('aarch64','amd64'),'ARCH_INVALID')
 if not synthetic:
  lock=json.loads((repo/'unified-candidate-input-lock.json').read_text());need(arch=='aarch64' and m['target']==lock['target'],'PRIVATE_TARGET_MISMATCH')
  native={(p['name'],p['version'],p['architecture']) for p in lock['packages']}
  if support_bundle_dir:
   need(not test_roots and len(specs)==80 and set(specs)-native=={('termux-licenses','2.2','all')} and native<=set(specs),'EXACT_79_PLUS_VERIFIED_SUPPORT_REQUIRED')
  else: need(len(specs)==79 and set(specs)==native,'EXACT_79_SOURCE_SET_REQUIRED')
  need(sorted(roots)==sorted({x for p in lock['profiles'].values() for x in p['rootPackages']}),'EXACT_12_ROOTS_REQUIRED')
 byname={k[0]:k for k in specs};need(len(byname)==len(specs) and set(roots)<=set(byname),'ROOT_ABSENT_OR_AMBIGUOUS')
 need(all(re.fullmatch(r'[a-z0-9][a-z0-9+.-]*',k[0]) and re.fullmatch(r'[A-Za-z0-9.+:~_-]+',k[1]) and k[2] in (arch,'all') for k in specs),'IDENTITY_INVALID')
 actual={}
 for deb in sorted(packages.glob('*.deb')):
  need(deb.is_file() and not deb.is_symlink(),'INPUT_NOT_REGULAR');row=records(invoke(['dpkg-deb','-f',deb]).decode('utf8'))[0];identity=tuple(row[k] for k in ['Package','Version','Architecture']);need(identity in specs and identity not in actual,'DEB_SET_MISMATCH');need(digest(deb)==specs[identity]['sha256'],'EXPECTED_DEB_SHA256_MISMATCH');actual[identity]=deb
 expected_input=set(specs)
 if support_bundle_dir:expected_input.discard(('termux-licenses','2.2','all'))
 need(set(actual)==expected_input,'DEB_SET_INCOMPLETE')
 support_report=None
 if support_bundle_dir:
  need(support_fingerprint and support_producer,'SUPPORT_EXTERNAL_PINS_REQUIRED')
  verifier=pathlib.Path(__file__).with_name('verify-candidate-license-support.py')
  with tempfile.TemporaryDirectory(prefix='license-support-verified-') as td:
   report_path=pathlib.Path(td)/'report.json'
   invoke([sys.executable,verifier,'--bundle-dir',support_bundle_dir,'--expected-fingerprint',support_fingerprint,'--expected-producer',support_producer,'--report',report_path])
   support_report=json.loads(report_path.read_text());need(support_report.get('valid') is True,'SUPPORT_VERIFIER_DID_NOT_PASS')
   ident=('termux-licenses','2.2','all');need(specs[ident]['sha256']==support_report['package']['sha256'],'SUPPORT_MANIFEST_HASH_MISMATCH')
   source=pathlib.Path(support_bundle_dir)/'packages/termux-licenses_2.2_all.deb';need(digest(source)==specs[ident]['sha256'],'SUPPORT_DEB_HASH_MISMATCH')
   actual[ident]=source
 need(set(actual)==set(specs),'DEB_SET_INCOMPLETE')
 out.mkdir(parents=True);(out/'aggregate-manifest.json').write_bytes(manifest.read_bytes())
 env={k:v for k,v in os.environ.items() if k in {'PATH','HOME','LANG','LC_ALL','USER','LOGNAME','TMPDIR','TMP','TEMP'}}
 with tempfile.TemporaryDirectory(prefix='aib-aggregate-private-key-') as tmp:
  private=pathlib.Path(tmp);env.update(GNUPGHOME=str(private/'gnupg'),AIB_TERMUX_FEED_SIGNING_CONFIG_ROOT=str(private))
  try:
   invoke(['bash',repo/'scripts/create-ephemeral-feed-signing-key.sh',private],env=env,log=out/'key-generation.log')
   for identity,deb in actual.items():
    dest=out/'pool/main'/identity[0]/deb.name;dest.parent.mkdir(parents=True);os.link(deb,dest);need(digest(dest)==specs[identity]['sha256'],'STAGE_SHA256_MISMATCH')
   index=out/f'dists/stable/main/binary-{arch}';index.mkdir(parents=True)
   with (index/'Packages').open('wb') as f:invoke(['dpkg-scanpackages','-m','pool','/dev/null'],cwd=out,stdout=f)
   with (index/'Packages').open('rb') as src,(index/'Packages.gz').open('wb') as dst:invoke(['gzip','-n','-9c'],stdin=src,stdout=dst)
   rows=records((index/'Packages').read_text());seen=set()
   for row in rows:
    identity=tuple(row[k] for k in ['Package','Version','Architecture']);need(identity in actual and identity not in seen,'INDEX_IDENTITY_MISMATCH');seen.add(identity);rel=pathlib.PurePosixPath(row['Filename']);need(not rel.is_absolute() and '..' not in rel.parts and rel.parts[:2]==('pool','main'),'INDEX_TRAVERSAL');deb=out.joinpath(*rel.parts);need(deb.is_file() and not deb.is_symlink() and digest(deb)==row['SHA256']==specs[identity]['sha256'] and str(deb.stat().st_size)==row['Size'],'INDEX_HASH_SIZE_MISMATCH')
   need(seen==set(actual) and gzip.decompress((index/'Packages.gz').read_bytes())==(index/'Packages').read_bytes(),'INDEX_SET_OR_GZIP_MISMATCH')
   invoke(['bash',repo/'scripts/create-signed-feed-release.sh',out,arch],env=env,log=out/'signing.log')
   (out/'keys').mkdir()
   for name in ['feed-signing.json','aibuilder-termux-feed-keyring.gpg']:shutil.copyfile(private/'keys'/name,out/'keys'/name)
   cfg=json.loads((out/'keys/feed-signing.json').read_text());fpr=cfg['fingerprint'];need(re.fullmatch(r'[A-F0-9]{40}',fpr) and digest(out/cfg['publicKeyring'])==cfg['publicKeyringSha256'],'PUBLIC_KEY_BINDING_MISMATCH');(out/'public-fingerprint.txt').write_text(fpr+'\n')
   dist=out/'dists/stable';key=out/cfg['publicKeyring']
   for arguments,label in [([dist/'Release.gpg',dist/'Release'],'detached'),([dist/'InRelease'],'inline')]:
    p=subprocess.run(['gpgv','--status-fd=1','--keyring',str(key),*map(str,arguments)],capture_output=True,env=env);(out/(label+'-signature-verification.log')).write_bytes(p.stdout+p.stderr);need(p.returncode==0 and ('[GNUPG:] VALIDSIG '+fpr+' ').encode() in p.stdout,'SIGNATURE_OR_FINGERPRINT_MISMATCH')
   plain=invoke(['gpgv','--keyring',key,'--output','-',dist/'InRelease'],env=env);need(plain==(dist/'Release').read_bytes(),'INRELEASE_RELEASE_MISMATCH')
   native_specs_apt=[name+'='+byname[name][1] for name in roots]
   support_specs_apt=['termux-licenses='+byname['termux-licenses'][1]] if support_report else []
   specs_apt=native_specs_apt+support_specs_apt;primary=byname[roots[0]];env['AIB_APT_EXPECT_EXACT_SOURCE_CLOSURE']='1'
   invoke(['bash',repo/'scripts/test-apt-candidate.sh',out,arch,primary[0],primary[1],str(len(actual)),primary[2],*specs_apt[1:]],env=env,log=out/'apt-validation.log')
   text=(out/'apt-validation.log').read_text();need('APT_SIMULATED_EXACT_SOURCE_CLOSURE_OK packages='+str(len(actual)) in text and 'roots='+str(len(specs_apt)) in text,'APT_EXACT_TRANSACTION_NOT_EVIDENCED')
   report={'valid':True,'qualified':False,'productionAllowed':False,'packageCount':len(actual),'rootSpecs':specs_apt,'nativeToolRootSpecs':native_specs_apt,'supportRootSpecs':support_specs_apt,'fingerprint':fpr,'publicKeyringSha256':cfg['publicKeyringSha256'],'manifestSha256':digest(manifest),'helperSha256':digest(pathlib.Path(__file__)),'repositoryCommit':invoke(['git','-C',repo,'rev-parse','HEAD']).decode().strip(),'testOnlySynthetic':synthetic,'aptSimulation':'PASS','installPerformed':False,'android':'NOT_RUN','aggregateABI':'NOT_PROVEN','elf':'PER_PROFILE_REAUDIT_REQUIRED','privateKeyRetained':False,'packages':[{'identity':list(k),'sha256':specs[k]['sha256']} for k in sorted(specs)],'supplementalSupport':support_report,'nativePackageCount':len(actual)-len(support_specs_apt),'supplementalPackageCount':len(support_specs_apt)}
   (out/'validation-report.json').write_text(json.dumps(report,indent=2,sort_keys=True)+'\n');print('AGGREGATE_SIGNED_APT_SIMULATION_PASS packages='+str(len(actual))+' roots='+str(len(specs_apt))+' fingerprint='+fpr+' production=BLOCKED')
   return report
  finally:
   subprocess.run(['gpgconf','--homedir',env['GNUPGHOME'],'--kill','all'],capture_output=True,env=env)
def main():
 p=argparse.ArgumentParser();p.add_argument('--repo-root',type=pathlib.Path,required=True);p.add_argument('--package-set',type=pathlib.Path,required=True);p.add_argument('--packages-dir',type=pathlib.Path,required=True);p.add_argument('--output',type=pathlib.Path,required=True);p.add_argument('--test-only-roots',nargs='+');p.add_argument('--support-bundle-dir',type=pathlib.Path);p.add_argument('--support-fingerprint');p.add_argument('--support-producer');a=p.parse_args();need(bool(a.support_bundle_dir)==bool(a.support_fingerprint)==bool(a.support_producer),'SUPPORT_ARGUMENTS_MUST_BE_ALL_OR_NONE');build(a.repo_root,a.package_set,a.packages_dir,a.output,a.test_only_roots,a.support_bundle_dir,a.support_fingerprint,a.support_producer)
if __name__=='__main__':main()
