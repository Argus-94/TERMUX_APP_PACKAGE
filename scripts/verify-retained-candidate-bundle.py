#!/usr/bin/env python3
"""Strictly verify retained candidate evidence (offline, non-production qualification only)."""
import argparse, io, gzip, hashlib, importlib.util, json, os, re, shutil, subprocess, tarfile, tempfile, zipfile
from pathlib import Path, PurePosixPath
MAX_MEMBERS=20000
MAX_TOTAL=2*1024**3
MAX_FILE=1024**3
KEY="aibuilder-termux-feed-keyring.gpg"
META="feed-signing.json"
class Invalid(ValueError): pass

def sha(data): return hashlib.sha256(data).hexdigest()
def digest(path):
 h=hashlib.sha256()
 with open(path,"rb") as f:
  for b in iter(lambda:f.read(1024*1024),b""): h.update(b)
 return h.hexdigest()
def need(ok,why):
 if not ok: raise Invalid(why)
def loadj_bytes(b):
 try:
  v=json.loads(b.decode("utf-8")); need(isinstance(v,dict),"expected JSON object"); return v
 except (UnicodeError,json.JSONDecodeError) as e: raise Invalid("invalid JSON evidence") from e
def loadj(p):
 try: return loadj_bytes(Path(p).read_bytes())
 except OSError as e: raise Invalid(f"invalid JSON: {p}") from e

def inspect_tar(archive):
 found={}; total=0
 try:
  with tarfile.open(archive,"r:gz") as tf:
   for i,m in enumerate(tf):
    need(i<MAX_MEMBERS,"archive member count exceeds bounds")
    n=m.name; need(n and not n.startswith("/") and "\\" not in n,"absolute or malformed archive path")
    need(all(x not in ("", ".", "..") for x in n.split("/")),"archive traversal or noncanonical path")
    need(m.isfile(),"archive contains non-regular entry (links/directories/devices forbidden)")
    need(n not in found,"duplicate archive path")
    need(0<=m.size<=MAX_FILE,"archive member size exceeds bounds")
    total+=m.size; need(total<=MAX_TOTAL,"archive expanded size exceeds bound")
    # Retain only validated member metadata; read while the TarFile remains open.
    f=tf.extractfile(m); need(f is not None,"cannot read archive member")
    b=f.read(MAX_FILE+1); need(len(b)==m.size,"truncated archive member")
    found[n]=b
 except (OSError,tarfile.TarError) as e: raise Invalid("invalid gzip tar archive") from e
 names=set(found)
 for n in names:
  parts=n.split("/")
  for i in range(1,len(parts)):
   need("/".join(parts[:i]) not in names,"archive file is ancestor of another path")
 return found

def allowed_paths(names,manifest_name):
 fixed={"SHA256SUMS","SHA256SUMS.asc","provenance.json","provenance.json.asc",manifest_name,"public-key/"+KEY,"public-key/"+META,"reports/build-result.json","reports/audit-report.json","reports/app-private-properties.patch","input-metadata/script-hashes.json","input-metadata/unified-candidate-input-lock.json","input-metadata/toolchain-candidate-source-closure-locks.json","reports/source-closure.json","signed-feed/dists/stable/Release","signed-feed/dists/stable/InRelease","signed-feed/dists/stable/Release.gpg","signed-feed/dists/stable/main/binary-aarch64/Packages","signed-feed/dists/stable/main/binary-aarch64/Packages.gz"}
 for n in names:
  if n in fixed or re.fullmatch(r"packages/[^/]+\.deb",n) or re.fullmatch(r"signed-feed/pool/.+\.deb",n): continue
  raise Invalid(f"unexpected evidence path: {n}")
 required={"SHA256SUMS","SHA256SUMS.asc","provenance.json","provenance.json.asc",manifest_name,"public-key/"+KEY,"public-key/"+META,"reports/build-result.json","reports/audit-report.json","reports/app-private-properties.patch","input-metadata/script-hashes.json","signed-feed/dists/stable/Release","signed-feed/dists/stable/InRelease","signed-feed/dists/stable/Release.gpg","signed-feed/dists/stable/main/binary-aarch64/Packages","signed-feed/dists/stable/main/binary-aarch64/Packages.gz"}
 need(required<=names,"required evidence missing")

def parse_packages(raw):
 try: text=raw.decode("utf-8")
 except UnicodeError as e: raise Invalid("Packages index is not UTF-8") from e
 records=[]
 for stanza in re.split(r"\n\s*\n",text.strip()):
  if not stanza: continue
  d={}; previous=None
  for line in stanza.splitlines():
   if line[:1].isspace():
    need(previous is not None,"orphan Packages continuation"); d[previous]+="\n"+line; continue
   k,sep,v=line.partition(":"); need(bool(sep) and bool(k) and k not in d,"malformed or duplicate Packages field"); d[k]=v.lstrip(); previous=k
  need(all(k in d for k in ("Package","Version","Architecture","Filename","Size","SHA256")),"Packages record lacks required fields")
  need(re.fullmatch(r"[0-9]+",d["Size"]) and re.fullmatch(r"[0-9a-f]{64}",d["SHA256"]),"invalid Packages size or digest")
  records.append(d)
 return records

def verify(archive,repository,commit,run_id,fingerprint,repo_root,outdir,report):
 if zipfile.is_zipfile(archive):
  helper=Path(__file__).with_name("verify-gradle-android-candidate-zip.py")
  spec=importlib.util.spec_from_file_location("verify_gradle_android_candidate_zip",helper)
  if spec is None or spec.loader is None: raise Invalid("cannot load Gradle candidate ZIP verifier")
  module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
  return module.verify_candidate_zip(archive,repository,commit,str(run_id),fingerprint,repo_root,outdir,report)
 need(repository=="Argus-94/TERMUX_APP_PACKAGE","repository mismatch")
 need(re.fullmatch(r"[0-9a-f]{40}",commit or "") and re.fullmatch(r"[0-9]+",str(run_id)),"invalid commit/run id")
 need(re.fullmatch(r"[0-9A-F]{40,64}",fingerprint or ""),"external fingerprint must be uppercase hex")
 data=inspect_tar(archive); members=set(data)
 roots=[n for n in members if "/" not in n and n.endswith(".json") and n!="provenance.json"]
 need(len(roots)==1,"archive must contain exactly one root manifest"); manifest_name=roots[0]; allowed_paths(members,manifest_name)
 keymeta=loadj_bytes(data["public-key/"+META]); actual=str(keymeta.get("fingerprint","")).replace(" ","").upper()
 need(actual==fingerprint,"external fingerprint mismatch")
 if keymeta.get("publicKeyringSha256") is not None: need(keymeta["publicKeyringSha256"]==sha(data["public-key/"+KEY]),"public keyring digest mismatch")
 with tempfile.TemporaryDirectory(prefix="retained-verify-") as td:
  home=Path(td)/"home"; home.mkdir(mode=0o700); key=Path(td)/KEY; key.write_bytes(data["public-key/"+KEY])
  for content,sig in (("SHA256SUMS","SHA256SUMS.asc"),("provenance.json","provenance.json.asc"),("signed-feed/dists/stable/InRelease",None),("signed-feed/dists/stable/Release","signed-feed/dists/stable/Release.gpg")):
   a=Path(td)/"signed"; a.write_bytes(data[content]); args=["gpgv","--homedir",str(home),"--keyring",str(key),"--status-fd","1"]
   if content.endswith("InRelease"):
    plain=Path(td)/"InRelease.plain"; args += ["--output",str(plain),str(a)]
   elif sig:
    s=Path(td)/"sig"; s.write_bytes(data[sig]); args += [str(s),str(a)]
   else: args += [str(a)]
   try: r=subprocess.run(args,check=True,text=True,capture_output=True)
   except (OSError,subprocess.CalledProcessError) as e: raise Invalid(f"signature verification failed: {content}") from e
   vals=re.findall(r"\[GNUPG:\] VALIDSIG ([0-9A-F]+)",r.stdout+r.stderr)
   need(bool(vals) and all(x==fingerprint for x in vals),"signature fingerprint mismatch")
   if content.endswith("InRelease"): need(plain.read_bytes()==data["signed-feed/dists/stable/Release"],"InRelease cleartext differs from Release")
 sums={}
 try:
  for line in data["SHA256SUMS"].decode("utf-8").splitlines():
   m=re.fullmatch(r"([0-9a-f]{64})  ([A-Za-z0-9_./:+@=-]+)",line); need(m is not None,"malformed checksum entry"); h,n=m.groups(); need(n not in sums,"duplicate checksum path"); sums[n]=h
 except UnicodeError as e: raise Invalid("invalid checksum encoding") from e
 covered=members-{"SHA256SUMS","SHA256SUMS.asc","provenance.json.asc"}
 need(set(sums)==covered,"checksum list does not exactly cover bundle files"); need(all(sums[n]==sha(data[n]) for n in sums),"checksum mismatch")
 prov=loadj_bytes(data["provenance.json"])
 need(prov.get("repository")==repository and prov.get("repositoryCommit")==commit and str(prov.get("workflowRunId"))==str(run_id),"provenance repository/commit/run mismatch")
 need(prov.get("sourceCommit") and re.fullmatch(r"[0-9a-f]{40}",prov["sourceCommit"]),"invalid source commit")
 need(isinstance(prov.get("builderImageDigest"),str) and "@sha256:" in prov["builderImageDigest"],"builder image is not digest pinned")
 need(prov.get("manifest")==manifest_name and prov.get("manifestSha256")==sha(data[manifest_name]),"manifest provenance mismatch")
 root=Path(repo_root).resolve(); head=subprocess.run(["git","-C",str(root),"rev-parse","HEAD"],check=True,text=True,capture_output=True).stdout.strip()
 need(head==commit,"pinned checkout HEAD differs from --commit")
 pinned=root/manifest_name; need(pinned.is_file() and not pinned.is_symlink() and digest(pinned)==sha(data[manifest_name]),"manifest differs from pinned checkout")
 manifest=loadj_bytes(data[manifest_name]); records=manifest.get("packages"); need(isinstance(records,list) and records,"manifest package list absent")
 source=manifest.get("source",{}) if isinstance(manifest.get("source",{}),dict) else {}; first=records[0] if isinstance(records[0],dict) else {}
 need(source.get("commit",source.get("sourceCommit",first.get("sourceCommit")))==prov["sourceCommit"],"manifest sourceCommit differs from provenance")
 need(source.get("builderImageDigest",source.get("builderImage",first.get("builderImageDigest",first.get("builderImage"))))==prov["builderImageDigest"],"manifest builder differs from provenance")
 expected=[]
 for x in records:
  need(isinstance(x,dict) and all(isinstance(x.get(k),str) for k in ("name","version","architecture")),"invalid manifest package identity"); expected.append((x["name"],x["version"],x["architecture"]))
 need(len(set(expected))==len(expected),"duplicate manifest identity")
 need(prov.get("publicKeyFingerprint")==fingerprint and prov.get("packageCount")==len(expected),"provenance fingerprint/count mismatch")
 pnames=[n for n in members if n.startswith("packages/") and n.endswith(".deb")]; pool=[n for n in members if n.startswith("signed-feed/pool/") and n.endswith(".deb")]; need(len(pnames)==len(pool)==len(expected),"package tuple count mismatch")
 ident={}
 with tempfile.TemporaryDirectory(prefix="retained-deb-inspect-") as td:
  for i,n in enumerate(pnames+pool):
   f=Path(td)/f"package-{i}.deb"; f.write_bytes(data[n])
   try: r=subprocess.run(["dpkg-deb","-f",str(f),"Package","Version","Architecture"],check=True,text=True,capture_output=True)
   except (OSError,subprocess.CalledProcessError) as e: raise Invalid("dpkg-deb metadata inspection failed") from e
   fields=dict(line.split(": ",1) for line in r.stdout.splitlines() if ": " in line); tup=tuple(fields.get(k) for k in ("Package","Version","Architecture")); need(tup in expected,"unexpected package tuple"); ident.setdefault(tup,{})["pool" if n in pool else "package"]=n
 need(set(ident)==set(expected) and all(set(v)=={"package","pool"} and data[v["package"]]==data[v["pool"]] for v in ident.values()),"package/feed bytes or tuples differ")
 for fname in ("build-result.json","audit-report.json","app-private-properties.patch"): need(prov.get("evidenceHashes",{}).get(fname)==sha(data["reports/"+fname]),"evidence hash mismatch")
 need(len(expected)==1 or "reports/source-closure.json" in members,"multi-package source closure missing")
 if "reports/source-closure.json" in members:
  closure=loadj_bytes(data["reports/source-closure.json"]); need(closure.get("sourceCommit")==prov["sourceCommit"] and {p.get("name") for p in closure.get("packages",[])}=={x[0] for x in expected},"source closure names/sourceCommit mismatch")
  need(prov.get("evidenceHashes",{}).get("source-closure.json")==sha(data["reports/source-closure.json"]),"source closure hash mismatch")
 build=loadj_bytes(data["reports/build-result.json"]); audit=loadj_bytes(data["reports/audit-report.json"])
 need(build.get("sourceCommit")==prov["sourceCommit"] and build.get("builderImageRef",build.get("builderImage"))==prov["builderImageDigest"],"build provenance mismatch")
 need(build.get("status")=="audit-passed; device-runtime-test-not-run" and build.get("installed") is False and audit.get("ok") is True,"build/audit gate failed")
 report_records=build.get("packages")
 if report_records is None:
  need(len(expected)==1,"scalar report cannot represent multiple packages")
  report_records=[{"name":expected[0][0],"version":expected[0][1],"architecture":expected[0][2],"filename":build.get("packageFile"),"sha256":build.get("packageSha256")}]
 reported={}
 for item in report_records:
  identity=(item.get("name"),item.get("version"),item.get("architecture")); need(identity not in reported,"duplicate build report identity")
  reported[identity]=(item.get("filename",item.get("file",item.get("packageFile"))),item.get("sha256",item.get("packageSha256")))
 need(set(reported)==set(expected),"build report package set mismatch")
 for identity,paths in ident.items():
  package_path=paths["package"]; need(reported[identity]==(PurePosixPath(package_path).name,sha(data[package_path])),"build report package bytes mismatch")
 locks=prov.get("inputLockHashes",{}); scripts=prov.get("scriptHashes",{}); need(isinstance(locks,dict) and isinstance(scripts,dict),"hash metadata malformed")
 expected_locks={name for name in ("unified-candidate-input-lock.json","toolchain-candidate-source-closure-locks.json") if (root/name).is_file()}
 need(set(locks)==expected_locks,"input lock inventory incomplete")
 expected_scripts=set(root.glob("scripts/*.sh"))|set(root.glob("scripts/*.py"))|set(root.glob("termux-private-package-kit/*/*.sh"))|set(root.glob("termux-private-package-kit/*/*.py"))|set(root.glob("termux-private-package-kit/*/*.json"))|set(root.glob("termux-private-package-kit/*/*.patch"))
 need(set(scripts)=={p.relative_to(root).as_posix() for p in expected_scripts if p.is_file() and not p.is_symlink()},"script hash inventory incomplete")
 need(prov.get("publicKeyMetadataSha256")==sha(data["public-key/"+META]),"public key metadata hash mismatch")
 for name,rel in (("unified-candidate-input-lock.json","input-metadata/unified-candidate-input-lock.json"),("toolchain-candidate-source-closure-locks.json","input-metadata/toolchain-candidate-source-closure-locks.json")):
  if name in locks: need(rel in data and locks[name]==sha(data[rel]),"input lock hash mismatch"); need(digest(root/name)==locks[name],"checkout input lock differs")
 need(scripts==loadj_bytes(data["input-metadata/script-hashes.json"]),"script hash metadata mismatch")
 for rel,h in scripts.items():
  q=PurePosixPath(rel); need(not q.is_absolute() and ".." not in q.parts,"unsafe script hash path"); target=root.joinpath(*q.parts); need(target.is_file() and not target.is_symlink() and digest(target)==h,"checkout script hash mismatch: "+rel)
 release=data["signed-feed/dists/stable/Release"].decode("utf-8",errors="strict"); checks={}
 section=False
 for line in release.splitlines():
  if line=="SHA256:": section=True; continue
  if section:
   if line and not line[0].isspace(): section=False; continue
   m=re.fullmatch(r"\s+([0-9a-f]{64})\s+([0-9]+)\s+(\S+)\s*",line); need(m is not None,"malformed Release SHA256 entry"); h,size,path=m.groups(); need(path not in checks,"duplicate Release path"); checks[path]=(h,int(size))
 base="main/binary-aarch64/"
 for path in ("Packages","Packages.gz"):
  full=base+path; need(checks.get(full)==(sha(data["signed-feed/dists/stable/"+full]),len(data["signed-feed/dists/stable/"+full])),"Release SHA256/size mismatch: "+path)
 raw=data["signed-feed/dists/stable/"+base+"Packages"]; gz=data["signed-feed/dists/stable/"+base+"Packages.gz"]
 try:
  with gzip.GzipFile(fileobj=io.BytesIO(gz)) as stream: need(stream.read(len(raw)+1)==raw,"Packages.gz differs from Packages")
 except (OSError,EOFError) as e: raise Invalid("invalid Packages.gz") from e
 pkgs=parse_packages(raw); need(len(pkgs)==len(expected),"Packages record count mismatch")
 expected_files={}
 for t,v in ident.items():
  pn=v["pool"]; expected_files["pool/"+pn.removeprefix("signed-feed/pool/")]=(t,len(data[pn]),sha(data[pn]))
 seen=set()
 for r in pkgs:
  path=r["Filename"]; tup=(r["Package"],r["Version"],r["Architecture"]); need(path in expected_files,"Packages Filename not exact retained pool path"); need((tup,int(r["Size"]),r["SHA256"])==expected_files[path],"Packages tuple/size/SHA256 mismatch"); need(path not in seen,"duplicate Packages filename"); seen.add(path)
 need(seen==set(expected_files),"Packages does not enumerate exact pool")
 out=Path(outdir).resolve(); need(not out.exists(),"output directory must not already exist"); stage=Path(tempfile.mkdtemp(prefix=".retained-verify-",dir=str(out.parent)))
 try:
  for n,b in data.items(): p=stage.joinpath(*PurePosixPath(n).parts); p.parent.mkdir(parents=True,exist_ok=True); p.write_bytes(b)
  stage.rename(out)
 except Exception: shutil.rmtree(stage,ignore_errors=True); raise
 result={"valid":True,"productionAllowed":False,"qualified":False,"android":"NOT_RUN","fingerprint":fingerprint,"packageCount":len(expected),"archiveSha256":digest(archive),"repositoryCommit":commit,"workflowRunId":str(run_id),"sourceCommit":prov["sourceCommit"],"builderImageDigest":prov["builderImageDigest"],"manifestSha256":prov["manifestSha256"],"signedInputValidated":True,"controlElfPayloadQualified":False}; Path(report).write_text(json.dumps(result,sort_keys=True,indent=2)+"\n",encoding="utf-8")

def main():
 p=argparse.ArgumentParser(description=__doc__)
 for n in ("archive","repository","commit","run-id","fingerprint","repo-root","output-dir","report"): p.add_argument("--"+n,required=True)
 a=p.parse_args()
 try: verify(a.archive,a.repository,a.commit,a.run_id,a.fingerprint,a.repo_root,a.output_dir,a.report)
 except Exception as e: print(f"verification failed: {e}",file=__import__("sys").stderr); return 1
 return 0
if __name__=="__main__": raise SystemExit(main())
