#!/usr/bin/env python3
"""Build and validate a real 82-package, CI-only bootstrap compatibility feed.

This tool never installs packages on the host and never qualifies or publishes them.
"""
import argparse, gzip, hashlib, json, os, pathlib, re, shutil, subprocess, sys, tempfile, zipfile

PINNED_OLD_MANIFEST = 'e5a2e3cdb0d1010436f850da4511b993bac9ddb8d9f9f6b941c29a925386d911'
OLD_KEY_FPR = '90CD2EAF115DA42B87194C5C8BB5824E095857FE'
BOOTSTRAP_ZIP_SHA256 = '08a447f60c06783f33561583553149cf992ac7d9779071c71b8aaeeb452451b4'
OLD_NAMES = {'libbz2': '1.0.8-8', 'bzip2': '1.0.8-8', 'liblzma': '5.8.4', 'xz-utils': '5.8.4'}
ROOTS = ['make','gh','git','curl','wget','pkg-config','python','nodejs','npm','openjdk-17','cmake','ninja','termux-licenses']
def need(ok, code):
    if not ok: raise ValueError(code)
def sha(p):
    h=hashlib.sha256()
    with open(p,'rb') as f:
        for b in iter(lambda:f.read(1<<20),b''): h.update(b)
    return h.hexdigest()
def run(args, **kw):
    kw.setdefault('stdout',subprocess.PIPE)
    p=subprocess.run([str(x) for x in args],stderr=subprocess.PIPE,**kw)
    if p.returncode: raise RuntimeError('COMMAND_FAILED:'+str(args[0])+':'+p.stderr.decode('utf8','replace')[-1500:])
    return p.stdout
def fields(deb):
    text=run(['dpkg-deb','-f',deb]).decode('utf8','strict'); d={}
    for ln in text.splitlines():
        if not ln: continue
        if ln[:1].isspace(): continue
        k,sep,v=ln.partition(':'); need(bool(sep) and k not in d,'CONTROL_INVALID'); d[k]=v.strip()
    return d
def manifest_path(base):
    for p in [base/'aggregate-manifest.json',base/'candidate-feed'/'aggregate-manifest.json']:
        if p.is_file(): return p
    raise ValueError('BASE_MANIFEST_MISSING')
def validate_base(base):
    mp=manifest_path(base); need(sha(mp)==PINNED_OLD_MANIFEST,'BASE_MANIFEST_SHA_MISMATCH')
    m=json.loads(mp.read_text()); rows=m.get('packages',[]); need(len(rows)==80,'BASE_MANIFEST_NOT_80')
    feed=base/'candidate-feed'; keymeta=json.loads((feed/'keys/feed-signing.json').read_text()); key=feed/keymeta['publicKeyring']
    need(keymeta['fingerprint']==OLD_KEY_FPR and sha(key)==keymeta['publicKeyringSha256'],'BASE_SIGNING_KEY_MISMATCH')
    for args in [['gpgv','--status-fd=1','--keyring',key,feed/'dists/stable/Release.gpg',feed/'dists/stable/Release'],['gpgv','--status-fd=1','--keyring',key,feed/'dists/stable/InRelease']]:
        out=run(args); need(('VALIDSIG '+OLD_KEY_FPR+' ').encode() in out,'BASE_SIGNATURE_INVALID')
    pool=feed/'pool/main'; actual={}
    for p in pool.rglob('*.deb'):
        need(p.is_file() and not p.is_symlink(),'BASE_DEB_NOT_REGULAR'); c=fields(p); ident=(c.get('Package'),c.get('Version'),c.get('Architecture')); actual[ident]=p
    expected={(r['name'],r['version'],r['architecture']):r for r in rows}; need(len(expected)==80 and set(actual)==set(expected),'BASE_PACKAGE_SET_MISMATCH')
    for k,p in actual.items(): need(sha(p)==expected[k]['sha256'],'BASE_PACKAGE_HASH_MISMATCH:'+k[0])
    rp=base/'full-reproducibility-coverage.json'; need(rp.is_file(),'BASE_REPRO_REPORT_MISSING'); rr=json.loads(rp.read_text())
    need(rr.get('complete') is True and rr.get('packageCount')==80 and len(rr.get('packages',[]))==80,'BASE_REPRO_REPORT_INCOMPLETE')
    need(sha(rp)==m['reproducibilityCoverageSha256'],'BASE_REPRO_REPORT_HASH_MISMATCH')
    for row in rr['packages']:
        ident=(row['name'],row['version'],row['architecture']);need(ident in expected and row.get('reproducibilityVerified') is True and row['sha256']==expected[ident]['sha256'],'BASE_REPRO_PACKAGE_MISMATCH')
    return mp,m,feed,actual

def result_data(d, expected_commit):
    p=d/'build-result.json'; need(p.is_file(),'BUILD_RESULT_MISSING'); x=json.loads(p.read_text())
    lock=json.loads((pathlib.Path(__file__).resolve().parent.parent/'bootstrap-compatible-candidate-inputs.json').read_text())
    need(x.get('sourceCommit')==lock['sourceCommit'],'SOURCE_COMMIT_NOT_PINNED')
    need(bool(expected_commit) and x.get('producerCommit')==expected_commit,'PRODUCER_COMMIT_MISMATCH')
    need(x.get('sourceBuild') is True and x.get('controlRepacked') is False,'SOURCE_BUILD_NOT_PROVEN')
    need(x.get('builderImage')==lock['builderImage'],'BUILDER_IMAGE_MISMATCH')
    prov=x.get('sourceInputs'); need(isinstance(prov,dict),'SOURCE_PROVENANCE_MISSING')
    need(prov.get('recipes')==lock['sourceFiles'],'RECIPE_OR_SPLIT_HASH_MISMATCH')
    upstream={'bzip2-1.0.8.tar.xz':'47fd74b2ff83effad0ddf62074e6fad1f6b4a77a96e121ab421c20a216371a1f','xz-5.8.4.tar.xz':'4ce24038fd4221e0d13bc1a2de7a4db56e90b92b3bf75321f6c14be73f65de4b'}
    need(prov.get('upstreamArchives')==upstream,'UPSTREAM_SOURCE_HASH_MISMATCH')
    for name,expected in upstream.items():
        need((d/name).is_file() and not (d/name).is_symlink() and sha(d/name)==expected,'ACTUAL_UPSTREAM_ARCHIVE_MISMATCH:'+name)
    audit=json.loads((d/'audit.json').read_text()); need(audit.get('result')=='PASS','BUILD_PAYLOAD_AUDIT_NOT_PASSED')
    packages=x.get('packages'); need(isinstance(packages,list) and len(packages)==4,'BUILD_RESULT_PACKAGE_INVENTORY_INVALID')
    x['provenance']=prov
    return x

def scan_build(d, expected_commit):
    x=result_data(d,expected_commit); root=d/'packages'; need(root.is_dir(),'BUILD_PACKAGES_DIR_MISSING'); got={}
    for p in root.iterdir():
        if p.suffix!='.deb': continue
        need(p.is_file() and not p.is_symlink(),'BUILD_DEB_NOT_REGULAR'); c=fields(p); ident=(c.get('Package'),c.get('Version'),c.get('Architecture'))
        need(ident[0] in OLD_NAMES and ident not in got,'UNEXPECTED_OR_DUPLICATE_NEW_PACKAGE')
        want=OLD_NAMES[ident[0]]; need(ident[1]==want and ident[2]=='aarch64','NEW_PACKAGE_IDENTITY_MISMATCH')
        need(c.get('Essential','').lower()=='yes','NEW_PACKAGE_NOT_ESSENTIAL')
        dep=c.get('Depends','')
        parent={'bzip2':'libbz2','xz-utils':'liblzma'}.get(ident[0])
        if parent: need(re.search(r'(^|,\s*)'+re.escape(parent)+r'\s*\(=\s*'+re.escape(want)+r'\)(,|$)',dep) is not None,'SPLIT_EXACT_DEPENDENCY_MISMATCH')
        got[ident]={'path':p,'sha256':sha(p),'control':c}
    need(len(got)==4 and {k[0] for k in got}==set(OLD_NAMES),'NEW_PACKAGE_SET_INCOMPLETE')
    reported={(x.get('name'),x.get('version'),x.get('architecture')):x for x in x['packages']}
    need(set(reported)==set(got),'BUILD_RESULT_PACKAGE_SET_MISMATCH')
    for ident,item in got.items():
        r=reported[ident]; need(r.get('sha256')==item['sha256'],'BUILD_RESULT_DEB_HASH_MISMATCH:'+ident[0])
        need(r.get('file',r.get('filename'))==item['path'].name,'BUILD_RESULT_DEB_FILENAME_MISMATCH:'+ident[0])
    return got,x

def make_feed(base, a, b, zipfile_path, out, repo, commit):
    need(not out.exists(),'OUTPUT_MUST_BE_NEW'); mp,old,oldfeed,oldpkgs=validate_base(base)
    aa,ar=scan_build(a,commit); bb,br=scan_build(b,commit)
    need(set(aa)==set(bb),'REPRO_PACKAGE_SET_MISMATCH')
    for k in aa: need(aa[k]['sha256']==bb[k]['sha256'],'NONREPRODUCIBLE_DEB:'+k[0])
    need(ar.get('producerCommit')==br.get('producerCommit'),'REPRO_PRODUCER_MISMATCH')
    need(ar.get('replica')=='a' and br.get('replica')=='b','INDEPENDENT_REPLICA_IDENTITIES_REQUIRED')
    base_by_name={k[0]:(k,v) for k,v in oldpkgs.items()}
    for name in ('libbz2','liblzma'):
        ident=(name,OLD_NAMES[name],'aarch64'); need(ident in aa and ident in oldpkgs,'EXPECTED_OLD_PARENT_MISSING:'+name)
        need(aa[ident]['sha256']==sha(oldpkgs[ident]),'OLD_PARENT_BINARY_CHANGED:'+name)
    additions={k for k in aa if k not in oldpkgs}
    need(additions=={('bzip2','1.0.8-8','aarch64'),('xz-utils','5.8.4','aarch64')},'EXACT_TWO_NEW_IDENTITIES_REQUIRED')
    # The supplied pinned-source archive is read-only evidence, never used to rewrite metadata.
    need(zipfile_path.is_file(),'BOOTSTRAP_ZIP_MISSING')
    need(sha(zipfile_path)==BOOTSTRAP_ZIP_SHA256,'BOOTSTRAP_ZIP_SHA256_MISMATCH')
    with zipfile.ZipFile(zipfile_path) as z:
        names=z.namelist(); need(names and all(not pathlib.PurePosixPath(n).is_absolute() and '..' not in pathlib.PurePosixPath(n).parts for n in names),'BOOTSTRAP_ZIP_PATH_INVALID')
        status=[n for n in names if n.endswith('var/lib/dpkg/status') or n.endswith('/dpkg/status')]
        need(status,'BOOTSTRAP_STATUS_MISSING')
        status_text=z.read(status[0]).decode('utf8','strict')
    oldrows=old['packages']; newrows=[{'name':k[0],'version':k[1],'architecture':k[2],'filename':v['path'].name,'sha256':v['sha256'],'origin':'bootstrap-compat pinned-source reproducible builds','sourceCommit':ar['sourceCommit']} for k,v in sorted(aa.items()) if k in additions]
    manifest=dict(old); manifest['aggregateProducerCommit']=os.environ.get('GITHUB_SHA'); manifest['bootstrapCompatibility']={'retainedBasePackageCount':80,'sourceCompanionPackageCount':2,'sourceBuildProducer':commit,'sourceInputs':ar['sourceInputs'],'bootstrapSha256':BOOTSTRAP_ZIP_SHA256}; manifest['packages']=oldrows+newrows; manifest['channel']='candidate-only'; manifest['productionAllowed']=False; manifest['qualified']=False
    need(len(manifest['packages'])==82,'INTERNAL_PACKAGE_COUNT')
    # Four distinct artifacts extend the retained 80; original metadata and hashes remain unchanged.
    out.mkdir(parents=True)
    coverage=json.loads((base/'full-reproducibility-coverage.json').read_text())
    for ident in sorted(additions):
        coverage['packages'].append({'name':ident[0],'version':ident[1],'architecture':ident[2],'sha256':aa[ident]['sha256'],'reproducibilityVerified':True,'effectiveSourceVariants':[ar['sourceInputs']],'witnesses':[{'producerCommit':x['producerCommit'],'sourceCommit':x['sourceCommit'],'replica':x.get('replica'),'sha256':aa[ident]['sha256']} for x in (ar,br)],'evidenceKind':'independent-pinned-source-builds'})
    coverage.update(packageCount=len(coverage['packages']),complete=True,bootstrapCompanionSourceBuilds=True)
    (out/'full-reproducibility-coverage.json').write_text(json.dumps(coverage,indent=2,sort_keys=True)+'\n')
    manifest['baseReproducibilityCoverageSha256']=old['reproducibilityCoverageSha256']
    manifest['reproducibilityCoverageSha256']=sha(out/'full-reproducibility-coverage.json')
    (out/'aggregate-manifest.json').write_text(json.dumps(manifest,indent=2,sort_keys=True)+'\n')
    for src in oldpkgs.values():
        dest=out/'pool/main'/src.parent.name/src.name; dest.parent.mkdir(parents=True,exist_ok=True); shutil.copyfile(src,dest)
    for k,v in aa.items():
        if k in oldpkgs: continue
        src=v['path']; dest=out/'pool/main'/src.stem.split('_')[0]/src.name; dest.parent.mkdir(parents=True,exist_ok=True); shutil.copyfile(src,dest)
    idx=out/'dists/stable/main/binary-aarch64'; idx.mkdir(parents=True)
    with (idx/'Packages').open('wb') as f: run(['dpkg-scanpackages','-m','pool','/dev/null'],cwd=out,stdout=f)
    with (idx/'Packages').open('rb') as i,(idx/'Packages.gz').open('wb') as o: o.write(gzip.compress(i.read(),compresslevel=9,mtime=0))
    env={k:v for k,v in os.environ.items() if k in ('PATH','HOME','LANG','LC_ALL','TMPDIR')}
    with tempfile.TemporaryDirectory(prefix='bootstrap-compat-sign-') as td:
        t=pathlib.Path(td); env.update(GNUPGHOME=str(t/'gnupg'),AIB_TERMUX_FEED_SIGNING_CONFIG_ROOT=str(t))
        run(['bash',repo/'scripts/create-ephemeral-feed-signing-key.sh',t],env=env)
        signing_path=t/'keys/feed-signing.json'; fresh=json.loads(signing_path.read_text())
        # The private key exists only in this CI context. A self-signed public
        # validity window covers the signed 30-day Release; expiry checks stay ON.
        run(['gpg','--batch','--yes','--quick-set-expire',fresh['fingerprint'],'31d'],env=env)
        public=t/fresh['publicKeyring']; public.write_bytes(run(['gpg','--batch','--export',fresh['fingerprint']],env=env))
        fresh.update(publicKeyringSha256=sha(public),testPublicKeyValidityDays=31,privateKeyLifecycle='ephemeral CI only')
        signing_path.write_text(json.dumps(fresh,indent=2)+'\n')
        run(['bash',repo/'scripts/create-signed-feed-release.sh',out,'aarch64'],env=env)
        # Public verification material only; private GNUPGHOME is deleted on context exit.
        (out/'keys').mkdir()
        for name in ('feed-signing.json','aibuilder-termux-feed-keyring.gpg'): shutil.copyfile(t/'keys'/name,out/'keys'/name)
        cfg=json.loads((out/'keys/feed-signing.json').read_text()); key=out/cfg['publicKeyring']
        need(sha(key)==cfg['publicKeyringSha256'],'SIGNING_KEY_HASH_MISMATCH')
        for sig in [out/'dists/stable/Release.gpg',out/'dists/stable/InRelease']:
            v=subprocess.run(['gpgv','--status-fd=1','--keyring',key,sig] if sig.name=='InRelease' else ['gpgv','--status-fd=1','--keyring',key,sig,out/'dists/stable/Release'],capture_output=True)
            need(v.returncode==0 and ('VALIDSIG '+cfg['fingerprint']+' ').encode() in v.stdout,'NEW_FEED_SIGNATURE_INVALID')
        run(['gpg','--batch','--yes','--armor','--local-user',cfg['fingerprint'],'--detach-sign','--output',out/'aggregate-manifest.json.asc',out/'aggregate-manifest.json'],env=env)
        signed=run(['gpgv','--status-fd=1','--keyring',key,out/'aggregate-manifest.json.asc',out/'aggregate-manifest.json'])
        need(('VALIDSIG '+cfg['fingerprint']+' ').encode() in signed,'MANIFEST_SIGNATURE_INVALID')
        subprocess.run(['gpgconf','--homedir',str(t/'gnupg'),'--kill','all'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    (out/'bootstrap-status.txt').write_text(status_text)
    report={'valid':True,'packageCount':82,'retainedBaseCount':80,'newPackageCount':2,'newPackagesReproducible':True,'reproducibility':{k[0]:aa[k]['sha256'] for k in sorted(aa)},'sourceCommit':ar['sourceCommit'],'producerCommit':ar.get('producerCommit'),'sourceProvenanceA':ar['provenance'],'sourceProvenanceB':br['provenance'],'fingerprint':cfg['fingerprint'],'publicKeyringSha256':cfg['publicKeyringSha256'],'manifestSha256':sha(out/'aggregate-manifest.json'),'installPerformed':False,'android':'NOT_RUN','qualified':False,'productionAllowed':False,'aptSimulation':'NOT_RUN','aptDownloadVerification':'NOT_RUN','bootstrapStatusExtracted':True,'baseManifestSha256':sha(mp),'oldSignatureFingerprint':OLD_KEY_FPR,'privateKeyRetained':False}
    (out/'compat-report.json').write_text(json.dumps(report,indent=2,sort_keys=True)+'\n')
    return report

def main():
    p=argparse.ArgumentParser();
    for n in ('base-root','repro-a','repro-b','bootstrap-zip','output','repo-root'): p.add_argument('--'+n,type=pathlib.Path,required=True)
    p.add_argument('--producer-commit',required=True); a=p.parse_args()
    r=make_feed(a.base_root.resolve(),a.repro_a.resolve(),a.repro_b.resolve(),a.bootstrap_zip.resolve(),a.output,a.repo_root.resolve(),a.producer_commit)
    print('BOOTSTRAP_COMPAT_CANDIDATE_SIGNED packages=82 new=2 install=NOT_RUN qualified=false productionAllowed=false manifest='+r['manifestSha256'])
if __name__=='__main__':
    try: main()
    except Exception as e: print('ERROR:'+str(e),file=sys.stderr); sys.exit(2)
