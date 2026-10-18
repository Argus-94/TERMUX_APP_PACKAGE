#!/usr/bin/env python3
"""Fail-closed static ELF symbol/provider inventory for fresh Termux debs."""
import argparse, hashlib, json, os, re, subprocess, sys, tarfile, tempfile
from pathlib import Path
ALLOWED_INTERP='/system/bin/linker64'; MAX_ELF=512*1024*1024; MAX_TAR=2*1024*1024*1024; MAX_MEMBERS=100000
def clean_env(): return {**{k:os.environ[k] for k in ('PATH','HOME','TMPDIR') if k in os.environ},'LC_ALL':'C'}
def run_readelf(path,mode):
    cmd=['readelf','-W','--dyn-syms' if mode=='s' else '-W'+mode,str(path)]
    p=subprocess.run(cmd,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=clean_env(),timeout=60)
    if p.returncode: raise ValueError('readelf failed: '+p.stderr.strip())
    return p.stdout
def parse_header(text):
    get=lambda pat: re.search(pat,text,re.M)
    typ=get(r'^\s*Type:\s*(\S+)'); machine=get(r'^\s*Machine:\s*(.+)$'); cls=get(r'^\s*Class:\s*(.+)$'); data=get(r'^\s*Data:\s*(.+)$')
    return {'elfType':typ.group(1) if typ else None,'class':cls.group(1).strip() if cls else None,'data':data.group(1).strip() if data else None,'machine':machine.group(1).strip() if machine else None}
def parse_program_headers(text):
    m=re.search(r"Requesting program interpreter:\s*([^\]]+)",text); return m.group(1).strip() if m else None
def parse_dynamic(text):
    soname=None; needed=[]; runpath=[]
    for line in text.splitlines():
        for pat,key in ((r'\(SONAME\).*\[([^]]+)\]','s'),(r'\(NEEDED\).*\[([^]]+)\]','n'),(r'\((?:RUNPATH|RPATH)\).*\[([^]]*)\]','r')):
            m=re.search(pat,line)
            if m:
                if key=='s': soname=m.group(1)
                elif key=='n': needed.append(m.group(1))
                else: runpath.append(m.group(1))
    return soname,needed,runpath
def parse_symbols(text):
    imports=[]; exports=[]
    for line in text.splitlines():
        m=re.match(r'\s*\d+:\s+[0-9a-fA-F]+\s+(?:0x)?[0-9a-fA-F]+\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+?)\s*$',line)
        if not m: continue
        typ,bind,vis,ndx,raw=m.groups(); raw=raw.split(' ',1)[0]; base=raw; version=None; default=True
        if '@@' in raw: base,version=raw.split('@@',1)
        elif '@' in raw: base,version=raw.split('@',1); default=False
        if not base or base.startswith('('): continue
        if ndx=='UND':
            if bind in ('GLOBAL','WEAK'): imports.append({'name':base,'version':version,'weak':bind=='WEAK','type':typ})
        elif bind in ('GLOBAL','WEAK','GNU_UNIQUE','UNIQUE') and vis in ('DEFAULT','PROTECTED'):
            exports.append({'name':base,'version':version,'default':default,'type':typ,'bind':bind})
    return imports,exports
def export_matches(exp,imp):
    if exp['name']!=imp['name']: return False
    if imp['version'] is None:
        if exp['version'] is not None and not exp['default']: return False
    elif exp['version']!=imp['version']: return False
    return (exp['type']=='TLS')==(imp['type']=='TLS')
def resolve_inventory(items):
    errors=[]; context=[]; weak=[]; unresolved=[]; soname_groups={}; byname={}
    for x in items:
        if x.get('elfType') in ('EXEC','REL'): continue
        names=set(x.get('providerNames',[]))
        if x.get('soname'): names.add(x['soname']); soname_groups.setdefault(x['soname'],[]).append(x)
        path=x.get('path','')
        if path and not path.startswith('/'):
            names.add(path.rsplit('/',1)[-1])
            if '/' not in path: names.add(path)
        for name in names: byname.setdefault(name,[]).append(x)
    for s,g in soname_groups.items():
        if len({x['sha256'] for x in g if x['source']=='candidate'})>1: errors.append('conflicting candidate providers for SONAME '+s)
    for name,g in byname.items():
        if len({x['sha256'] for x in g if x['source']=='candidate'})>1: errors.append('conflicting candidate providers for filename '+name)
        if len({id(x) for x in g if x['source']=='candidate'})>1 and any(name in x.get('providerNames',[]) for x in g): errors.append('ambiguous candidate alias '+name)
    index={}
    candidate_names={name for name,group in byname.items() if any(x['source']=='candidate' for x in group)}
    for x in items:
        if x['source']=='platform' and any(name in candidate_names for name in byname if x in byname[name]): continue
        for e in x['exports']:
            # Reachable platform exports describe API availability only, never runtime proof.
            keys={(e['name'],e['version'])}
            if e['version'] is None or e.get('default'): keys.add((e['name'],None))
            for key in keys: index.setdefault(key,[]).append((x,e))
    for consumer in items:
        if consumer['source']!='candidate': continue
        reachable=set(); todo=list(consumer.get('needed',[])); seen=set()
        while todo:
            n=todo.pop()
            if n in seen: continue
            seen.add(n); providers=[p for p in items if p['path']==n] if '/' in n else byname.get(n,[]); providers=[p for p in providers if p.get('elfType')=='DYN']; cand=[p for p in providers if p['source']=='candidate']; chosen=cand if cand else [p for p in providers if p['source']=='platform']
            if not chosen: errors.append(f"{consumer['path']}: unknown DT_NEEDED {n}"); continue
            reachable.update(id(p) for p in chosen)
            for p in chosen: todo.extend(p.get('needed',[]))
        for imp in consumer['imports']:
            possible=index.get((imp['name'],imp['version']),[])
            if any(export_matches(e,imp) and (p is consumer or id(p) in reachable) for p,e in possible): continue
            anywhere=[p for p,e in possible if p['source']=='candidate' and p is not consumer and export_matches(e,imp)]
            item={'consumer':consumer['path'],'symbol':imp['name'],'version':imp['version'],'type':imp['type']}
            if imp['weak']: weak.append(item)
            elif anywhere: context.append(item)
            else: unresolved.append(item)
    return errors,context,weak,unresolved
def process_elf(path,source,display,pkg=None):
    h=parse_header(run_readelf(path,'h'))
    if h['class']!='ELF64' or not (h['data'] or '').startswith("2's complement, little endian") or 'AArch64' not in (h['machine'] or ''): raise ValueError(f'foreign ELF rejected: {display}: {h}')
    if h['elfType']=='REL':
        return {'path':display,'package':pkg,'sha256':hashlib.sha256(Path(path).read_bytes()).hexdigest(),**h,'staticLinkAbi':'NOT_PROVEN'}
    if h['elfType'] not in ('DYN','EXEC'): raise ValueError(f'non-loadable ELF rejected: {display}: {h["elfType"]}')
    interp=parse_program_headers(run_readelf(path,'l'))
    if interp not in (None,ALLOWED_INTERP): raise ValueError(f'unsafe interpreter rejected: {display}: {interp}')
    soname,needed,runpath=parse_dynamic(run_readelf(path,'d')); imports,exports=parse_symbols(run_readelf(path,'s'))
    return {'path':display,'package':pkg,'source':source,'sha256':hashlib.sha256(Path(path).read_bytes()).hexdigest(),**h,'interpreter':interp,'soname':soname,'needed':needed,'runpath':runpath,'imports':imports,'exports':exports,'undefinedCount':len(imports),'undefinedStrongCount':sum(not i['weak'] for i in imports),'undefinedWeakCount':sum(i['weak'] for i in imports),'versionedUndefinedCount':sum(i['version'] is not None for i in imports)}
def _archive_path(name):
    """Normalize a tar member path without allowing traversal."""
    parts=[]
    for part in name.split('/'):
        if part in ('', '.'):
            continue
        if part=='..':
            if not parts: return None
            parts.pop()
        else: parts.append(part)
    return '/'.join(parts) if parts else None

def _link_target(member_path, linkname, is_absolute=False):
    # Debian payload absolute links can name the installed Termux prefix; never
    # reinterpret arbitrary system paths as candidate payload paths.
    prefix='/data/user/0/com.karat.aibuilder/files/usr/'
    if linkname.startswith('/'):
        if not linkname.startswith(prefix): return None
        target=linkname[len(prefix):]
    else:
        target=linkname if is_absolute else str(Path(member_path).parent / linkname)
    return _archive_path(target)

def candidate_debs(root,temp):
    root=Path(root)
    if not root.is_dir(): raise ValueError('packages directory missing or not a directory')
    debs=sorted(root.glob('*.deb'))
    if not debs: raise ValueError('packages directory contains no deb files')
    found=[]; payload_paths={}; links={}
    for deb in debs:
        p=subprocess.Popen(['dpkg-deb','--fsys-tarfile',str(deb)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=clean_env())
        try:
            with tarfile.open(fileobj=p.stdout,mode='r|*') as tf:
                total=count=0
                for member in tf:
                    count+=1; total+=max(member.size,0)
                    if count>MAX_MEMBERS or total>MAX_TAR: raise ValueError(f'tar limits exceeded: {deb}')
                    name=_archive_path(member.name)
                    if not name: continue
                    if member.issym() or member.islnk():
                        # A link name can be mapped later, after every deb was scanned.
                        target=_link_target(name,member.linkname,member.islnk())
                        if target: links.setdefault(name,set()).add(target)
                        continue
                    if not member.isfile(): continue
                    f=tf.extractfile(member)
                    if not f: continue
                    head=f.read(4)
                    if head!=b'\x7fELF': continue
                    if member.size>MAX_ELF: raise ValueError(f'ELF exceeds size cap: {member.name}')
                    data=head+f.read(MAX_ELF-3)
                    if len(data)>MAX_ELF: raise ValueError(f'ELF exceeds size cap: {member.name}')
                    digest=hashlib.sha256(data).hexdigest(); target=Path(temp)/(digest+'.elf')
                    if not target.exists(): target.write_bytes(data)
                    record=process_elf(target,'candidate',name,deb.name)
                    found.append(record); payload_paths.setdefault(name,[]).append(record)
            err=p.stderr.read().decode(errors='replace') if p.stderr else ''; rc=p.wait()
            if rc: raise ValueError(f'dpkg-deb failed for {deb}: {err.strip()}')
        except Exception: p.kill(); p.wait(); raise
    # Resolve chains against archive payload paths. Cycles, duplicate targets,
    # and dangling/external links contribute no provider alias.
    def resolve(path,seen):
        if path in seen: return []
        direct=payload_paths.get(path,set())
        if direct: return direct
        targets=links.get(path,set())
        if len(targets)!=1: return []
        return resolve(next(iter(targets)),seen|{path})
    for alias in links:
        targets=resolve(alias,set())
        if len(targets)==1:
            record=targets[0]; record.setdefault('providerNames',[]).append(alias.rsplit('/',1)[-1])
    for record in found:
        if record.get('providerNames'): record['providerNames']=sorted(set(record['providerNames']))
    return found

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--packages-dir',required=True); ap.add_argument('--platform-stubs-dir',required=True); ap.add_argument('--report',required=True); a=ap.parse_args()
    items=[]; non_loadable=[]; fatal=[]; contexts=[]; weak=[]; unresolved=[]; candidate_count=platform_count=0
    try:
        with tempfile.TemporaryDirectory(prefix='termux-elf-audit-') as td:
            candidate_records=candidate_debs(a.packages_dir,td); non_loadable=[x for x in candidate_records if x['elfType']=='REL']; items += [x for x in candidate_records if x['elfType']!='REL']; candidate_count=sum(x['source']=='candidate' for x in items)
            stubdir=Path(a.platform_stubs_dir)
            if not stubdir.is_dir(): raise ValueError('platform stubs directory missing or not a directory')
            for f in sorted(stubdir.rglob('*.so')):
                if not f.is_file() or f.is_symlink(): continue
                with f.open('rb') as stream: magic=stream.read(4)
                if magic!=b'\x7fELF': continue
                items.append(process_elf(f,'platform',str(f.relative_to(stubdir)))); platform_count+=1
            if candidate_count==0: fatal.append('no candidate ELF files found')
            if platform_count==0: fatal.append('no platform ELF stubs found')
            errors,contexts,weak,unresolved=resolve_inventory(items); fatal+=errors
    except Exception as e: fatal.append(str(e))
    report={'schema':'termux-static-elf-symbol-inventory-v1','qualified':False,'productionAllowed':False,'android':'NOT_RUN','completeElfAbiQualification':False,'staticSymbolCoverage':'PASS' if not fatal and not contexts and not unresolved else 'FAIL','loaderReachability':'NOT_PROVEN','runpathMeaning':'inventory only; does not establish pathname reachability','scopeExclusions':['static archives','relocatable objects are inventoried separately; static-link ABI not proven','nested archives','runtime behavior','dlopen binding contexts not proven'],'candidateElfCount':candidate_count,'platformStubCount':platform_count,'elfCount':len(items),'elfs':items,'nonLoadableElfInventory':non_loadable,'weakUnresolved':weak,'runtimeLoaderContextRequired':contexts,'unresolvedStrong':unresolved,'errors':fatal}
    Path(a.report).write_text(json.dumps(report,indent=2,sort_keys=True)+'\n'); return 2 if fatal or contexts or unresolved else 0
if __name__=='__main__': sys.exit(main())
