#!/usr/bin/env python3
"""Fail-closed aggregate control/payload audit. Payload is streamed, never extracted."""
import argparse, hashlib, importlib.util, json, pathlib, re, subprocess, sys, tarfile, io
from collections import defaultdict

MAX_DEB=512*1024*1024; MAX_TAR=2*1024*1024*1024; MAX_MEMBER=512*1024*1024; MAX_MEMBERS=100000
class Reject(Exception): pass
def req(ok, why):
    if not ok: raise Reject(why)
def depmod():
    p=pathlib.Path(__file__).with_name('verify-candidate-dependency-closure.py')
    s=importlib.util.spec_from_file_location('depclosure',p); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); return m
D=depmod()
def control_parse(data):
    try: lines=data.decode('utf-8','strict').splitlines()
    except UnicodeError as e: raise Reject('CONTROL_ENCODING') from e
    d={}; prev=None
    for line in lines:
        if not line: continue
        if line[0] in ' \t':
            req(prev is not None,'CONTROL_ORPHAN_CONTINUATION'); d[prev]+=' '+line.strip(); continue
        k,sep,v=line.partition(':'); req(sep and re.fullmatch(r'[A-Za-z0-9-]+',k),'CONTROL_MALFORMED_FIELD'); k=k.lower()
        req(k not in d,'CONTROL_DUPLICATE_FIELD:'+k); d[k]=v.strip(); prev=k
    for k in ('package','version','architecture'): req(d.get(k),'CONTROL_IDENTITY_MISSING:'+k)
    return d
def normname(n):
    req(n and not n.startswith('/') and '\\' not in n and '\0' not in n,'UNSAFE_PATH:'+repr(n))
    if n.startswith('./'): n=n[2:]
    req(not n.startswith('./') and not n.endswith('//'),'UNSAFE_PATH:'+repr(n))
    if n.endswith('/'): n=n[:-1]
    if n=='.': return '.'
    ps=n.split('/'); req(all(x not in ('','.','..') for x in ps),'UNSAFE_PATH:'+repr(n)); return '/'.join(ps)
def inspect(path,prefix):
    prefix=prefix.lstrip('/')
    req(path.is_file() and path.stat().st_size<=MAX_DEB,'DEB_SIZE_OR_NOT_FILE:'+str(path))
    fields={k:subprocess.run(['dpkg-deb','-f',str(path),k],capture_output=True,check=True,timeout=30).stdout.decode().strip() for k in ('Package','Version','Architecture')}
    raw=subprocess.run(['dpkg-deb','-f',str(path)],capture_output=True,check=True,timeout=30).stdout
    ctl=control_parse(raw); ident=(ctl['package'],ctl['version'],ctl['architecture']); req(ident==(fields['Package'],fields['Version'],fields['Architecture']),'CONTROL_IDENTITY_INCONSISTENT')
    h=hashlib.sha256(path.read_bytes()).hexdigest(); stream=subprocess.Popen(['dpkg-deb','--fsys-tarfile',str(path)],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    entries={}; total=0
    try:
      with tarfile.open(fileobj=stream.stdout,mode='r|') as tf:
       for i,m in enumerate(tf):
        req(i<MAX_MEMBERS,'TOO_MANY_MEMBERS'); n=normname(m.name)
        req(m.uid==0 and m.gid==0,'ROOT_UID_GID_ANOMALY:'+n); req(not (m.mode&0o6000),'SETID_MODE:'+n)
        if n=='.': req(m.isdir(),'BAD_ROOT_MEMBER'); continue
        if m.isdir(): kind='dir'
        elif m.isfile(): kind='file'
        elif m.issym(): kind='symlink'
        elif m.islnk(): kind='hardlink'
        else: raise Reject('SPECIAL_PAYLOAD:'+n)
        req(m.size<=MAX_MEMBER,'MEMBER_TOO_LARGE:'+n); total+=m.size; req(total<=MAX_TAR,'EXPANDED_TAR_TOO_LARGE')
        if kind=='dir': req(n==prefix or n.startswith(prefix+'/') or prefix.startswith(n+'/'),'OUTSIDE_PREFIX:'+n); req(not m.mode&0o002,'WORLD_WRITABLE_DIRECTORY:'+n)
        else: req(n.startswith(prefix+'/'),'OUTSIDE_PREFIX:'+n)
        data=b''
        if kind=='file':
         f=tf.extractfile(m); req(f is not None,'UNREADABLE:'+n); data=f.read(MAX_MEMBER+1); req(len(data)==m.size,'SIZE_MISMATCH:'+n)
        item={'kind':kind,'mode':m.mode,'uid':m.uid,'gid':m.gid,'size':m.size,'sha256':hashlib.sha256(data).hexdigest() if kind=='file' else None,'linktarget':m.linkname if kind in ('symlink','hardlink') else None}
        if n in entries: req(kind==entries[n]['kind']=='dir' and item['mode']==entries[n]['mode'],'INTRA_PACKAGE_COLLISION:'+n)
        else: entries[n]=item
      stream.stdout.close(); err=stream.stderr.read(); rc=stream.wait(); req(rc==0,'DPKG_TAR_FAILED')
    except Exception:
      stream.kill(); stream.wait(); raise
    finally:
      stream.stdout.close(); stream.stderr.close()
    return ctl,ident,h,entries

def audit(manifest,prefix,paths):
    req(prefix.startswith('/') and not prefix.endswith('/'),'PREFIX_INVALID')
    try: m=json.loads(manifest.read_text())
    except Exception as e: raise Reject('PACKAGE_SET_UNREADABLE') from e
    specs={}
    for p in m.get('packages',[]):
      req(isinstance(p,dict) and all(isinstance(p.get(k),str) and p[k] for k in ('name','version','architecture')),'MANIFEST_PACKAGE_INVALID')
      key=p['name']; spec=(p['version'],p['architecture']); req(key not in specs or specs[key]==spec,'MANIFEST_IDENTITY_CONFLICT'); specs[key]=spec
    req(bool(specs),'MANIFEST_PACKAGES_EMPTY')
    pkgs={}; owner={}; replacements=[]
    for path in paths:
      ctl,ident,digest,entries=inspect(path,prefix); name,ver,arch=ident
      req(name in specs and specs[name]==(ver,arch),'MANIFEST_PACKAGE_MISMATCH:'+name)
      if ident in pkgs:
       req(pkgs[ident]['sha256']==digest,'DUPLICATE_PACKAGE_DIFFERENT_HASH:'+':'.join(ident)); continue
      pkgs[ident]={'sha256':digest,'control':ctl,'entries':entries}
    req(set(x[0] for x in pkgs)==set(specs),'PACKAGE_SET_PATHS_MISMATCH')
    provides=defaultdict(list)
    for ident,p in pkgs.items():
      c=p['control']
      for f in ('Provides',):
       if c.get(f.lower()):
        for v in D.split_top_level(c[f.lower()],','):
         r=D.parse_alternative(v); req(r[2] in (None,'='),'PROVIDES_VERSION_OPERATOR_UNSUPPORTED'); provides[r[0]].append((ident,r[3]))
      for f in ('Replaces',):
       if c.get(f.lower()):
        for v in D.split_top_level(c[f.lower()],','): replacements.append({'package':ident[0],'relation':v,'parsed':D.parse_alternative(v)[0]})
    def sat(rel,exclude=None):
      nm,q,op,w=rel
      for i,p in pkgs.items():
       if i==exclude: continue
       if i[0]==nm and (q!='aarch64' or i[2]=='aarch64') and D.version_matches(i[1],op,w): return True
      for i,v in provides[nm]:
       if i==exclude: continue
       if q in (None,'aarch64','native') and ((op is None) or (v is not None and D.version_matches(v,op,w))): return True
      return False
    for ident,p in pkgs.items():
      c=p['control']
      for f in ('Depends','Pre-Depends'):
       if c.get(f.lower()):
        for group in D.split_top_level(c[f.lower()],','): req(any(sat(D.parse_alternative(x)) for x in D.split_top_level(group,'|')),'DEPENDENCY_UNSATISFIED:'+ident[0]+':'+f+':'+group)
      for f in ('Conflicts','Breaks'):
       if c.get(f.lower()):
        for group in D.split_top_level(c[f.lower()],','):
         for atom in D.split_top_level(group,'|'):
          r=D.parse_alternative(atom); req(not sat(r,exclude=ident),'CONFLICT_OR_BREAKS:'+ident[0]+':'+atom)
      for n,e in p['entries'].items():
       old=owner.get(n)
       if old: req(e['kind']==old[0]['kind']=='dir' and e['mode']==old[0]['mode'],'CROSS_PACKAGE_COLLISION:'+n)
       else: owner[n]=(e,ident[0])
    for n,(e,_) in owner.items():
      for i in range(1,len(n.split('/'))): req(owner.get('/'.join(n.split('/')[:i]),({'kind':'dir'},))[0]['kind']=='dir','FILE_ANCESTOR_CONFLICT:'+n)
    def resolve(n,seen=()):
      # Walk path tokens in order: `..` is meaningful only after preceding
      # symlinks have been followed, so never normalize it lexically first.
      boundary=prefix.strip('/').split('/'); root='/'.join(boundary)
      req(n==root or n.startswith(root+'/'),'LINK_ESCAPE:'+n)
      stack=list(boundary); pending=n.split('/')[len(boundary):]; links=0; states=set()
      while pending:
       part=pending.pop(0)
       if part in ('','.'): continue
       if part=='..':
        req(len(stack)>len(boundary),'LINK_ESCAPE:'+n); stack.pop(); continue
       candidate='/'.join(stack+[part]); req(candidate in owner,'DANGLING_LINK:'+candidate); e,who=owner[candidate]
       if e['kind']=='symlink':
        links+=1; req(links<=40,'SYMLINK_CHAIN_TOO_LONG:'+n)
        state=(candidate,tuple(pending)); req(state not in states,'SYMLINK_CYCLE:'+candidate); states.add(state)
        t=e['linktarget']; req(t and '\0' not in t,'BAD_LINK_TARGET:'+candidate)
        if t.startswith('/'):
         req(t==prefix or t.startswith(prefix+'/'),'LINK_ESCAPE:'+candidate)
         stack=list(boundary); target=t.lstrip('/').split('/')[len(boundary):]
        else: target=t.split('/')
        pending=target+pending
        continue
       req(not pending or e['kind']=='dir','DANGLING_LINK:'+candidate)
       stack.append(part)
      candidate='/'.join(stack); req(candidate in owner,'DANGLING_LINK:'+candidate)
      return owner[candidate]
    for n,(e,who) in owner.items():
      if e['kind']=='symlink': resolve(n)
      if e['kind']=='hardlink':
       target=normname(e['linktarget']); req(target in owner and owner[target][1]==who,'HARDLINK_CROSS_PACKAGE_OR_MISSING:'+n)
       seen=set(); cur=target
       for _ in range(40):
        req(cur not in seen,'HARDLINK_CYCLE:'+n); seen.add(cur); x,ow=owner[cur]
        if x['kind']=='file': break
        req(x['kind']=='hardlink' and ow==who,'HARDLINK_BAD_TARGET:'+n); cur=normname(x['linktarget'])
       else: raise Reject('HARDLINK_CHAIN_TOO_LONG:'+n)
    return {'audit':'unified-control-payload','qualified':False,'productionAllowed':False,'elf':'NOT_RUN','packageCount':len(pkgs),'packages':[{'identity':':'.join(i),'sha256':p['sha256']} for i,p in sorted(pkgs.items())],'payloadCount':len(owner),'payloadInventory':[{'path':n,'owner':who,**entry} for n,(entry,who) in sorted(owner.items())],'signedInputValidated':False,'replacesRecorded':replacements,'result':'pass-limited-no-ELF-or-ABI-qualification'}
def main():
 p=argparse.ArgumentParser(); p.add_argument('--package-set',required=True,type=pathlib.Path); p.add_argument('--prefix',required=True); p.add_argument('--report',required=True,type=pathlib.Path); p.add_argument('debs',nargs='+',type=pathlib.Path); a=p.parse_args()
 try:
  r=audit(a.package_set,a.prefix,a.debs); a.report.write_text(json.dumps(r,indent=2,sort_keys=True)+'\n'); print(json.dumps(r,sort_keys=True)); return 0
 except (Reject,OSError,subprocess.SubprocessError,ValueError,KeyError,tarfile.TarError) as e:
  why=str(e) or type(e).__name__; print('REJECTED: '+why,file=sys.stderr)
  try: a.report.write_text(json.dumps({'result':'rejected','reason':why},indent=2)+'\n')
  except OSError: pass
  return 2
if __name__=='__main__': raise SystemExit(main())
