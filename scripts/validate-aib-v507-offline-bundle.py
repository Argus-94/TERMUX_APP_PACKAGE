#!/usr/bin/env python3
"""Fail-closed source/build gates for the unsigned Karat v507 feed handoff."""
from __future__ import annotations
import argparse, gzip, hashlib, io, json, pathlib, posixpath, re, subprocess, sys, tarfile, zipfile
from typing import Any

ROOT = pathlib.Path(__file__).resolve().parents[1]
LOCK_PATH = ROOT / "termux-private-package-kit/v507/package-lock.json"
APP_ID = "com.karat.aibuilder"
APP_DATA = "/data/data/com.karat.aibuilder"
PREFIX = APP_DATA + "/files/usr"
ARCH = "aarch64"
FORMAT = "aibuilder-offline-package-bundle"
CERT_SHA256 = "b5dacc6f9c37adceace5c0d715eecb2762b5a0417468e221ec9c534ea1e6328e"
REBUILT = {
    "ttf-dejavu",
    "xorgproto",
    "xorg-util-macros",
    "termux-auth",
    "openssh",
    "openssh-sftp-server",
    "perl",
}
class GateError(Exception): pass
def need(ok: bool, code: str) -> None:
    if not ok: raise GateError(code)
def sha256(path: pathlib.Path) -> str:
    h=hashlib.sha256()
    with path.open("rb") as f:
        for b in iter(lambda:f.read(1024*1024),b""): h.update(b)
    return h.hexdigest()
def parse_control(text: str) -> dict[str,str]:
    out={}; key=None
    for line in text.splitlines()+[""]:
        if not line: continue
        if line[:1] in (" ","\t"):
            need(key is not None,"CONTROL_ORPHAN_CONTINUATION"); out[key]+="\n"+line[1:]
        else:
            k,sep,v=line.partition(":"); need(bool(sep) and k not in out,"CONTROL_MALFORMED_OR_DUPLICATE_FIELD"); key=k; out[k]=v.lstrip()
    return out
def parse_index(path: pathlib.Path) -> list[dict[str,str]]:
    try: text=path.read_text(encoding="utf-8",errors="strict")
    except Exception as e: raise GateError("PACKAGES_INDEX_UNREADABLE") from e
    rec=[parse_control(b) for b in re.split(r"\n\s*\n",text.strip()) if b.strip()]
    need(bool(rec),"PACKAGES_INDEX_EMPTY"); return rec
def safe_rel(value: str) -> pathlib.PurePosixPath:
    p=pathlib.PurePosixPath(value)
    need(value and not p.is_absolute() and ".." not in p.parts and "\\" not in value and "\x00" not in value,"BUNDLE_PATH_UNSAFE")
    return p
def payload_absolute(name: str) -> str:
    while name.startswith("./"): name=name[2:]
    if name in ("", "."): return "/"
    need(not name.startswith("/") and "\\" not in name and "\x00" not in name,"DEB_PAYLOAD_PATH_INVALID")
    parts=name.split("/"); need(all(x not in ("", ".", "..") for x in parts),"DEB_PAYLOAD_PATH_TRAVERSAL")
    return "/"+"/".join(parts)
def check_deb(deb: pathlib.Path, strict_strings: bool=True) -> dict[str,Any]:
    need(deb.is_file() and not deb.is_symlink(),"DEB_NOT_REGULAR_FILE")
    fields={}
    for key in ("Package","Version","Architecture","Depends","Pre-Depends","Provides","Multi-Arch"):
        p=subprocess.run(["dpkg-deb","-f",str(deb),key],capture_output=True,text=True)
        if p.returncode==0: fields[key]=p.stdout.strip()
    need(re.fullmatch(r"[a-z0-9][a-z0-9+.-]*",fields.get("Package","")) is not None,"DEB_PACKAGE_NAME_INVALID")
    need(fields.get("Architecture") in (ARCH,"all"),"DEB_ARCHITECTURE_MISMATCH_"+fields.get("Package","unknown"))
    p=subprocess.run(["dpkg-deb","--fsys-tarfile",str(deb)],capture_output=True,check=True)
    try: archive=tarfile.open(fileobj=io.BytesIO(p.stdout),mode="r:")
    except tarfile.TarError as e: raise GateError("DEB_DATA_TAR_INVALID") from e
    for m in archive:
        member=payload_absolute(m.name)
        if member=="/" or (m.isdir() and PREFIX.startswith(member+"/")): continue
        need(member==PREFIX or member.startswith(PREFIX+"/"),"DEB_PATH_OUTSIDE_TARGET_PREFIX:"+fields["Package"]+":"+member)
        if m.issym() or m.islnk():
            target=m.linkname; need(target and "\x00" not in target and "\\" not in target,"DEB_LINK_TARGET_INVALID")
            resolved=posixpath.normpath(target if target.startswith("/") else posixpath.join(posixpath.dirname(member),target))
            need(resolved==PREFIX or resolved.startswith(PREFIX+"/"),"DEB_LINK_ESCAPES_TARGET_PREFIX:"+fields["Package"])
        if m.isfile() and (strict_strings or (m.mode & 0o111)):
            stream=archive.extractfile(m)
            if stream:
                overlap=b""
                while True:
                    b=stream.read(1024*1024)
                    if not b: break
                    data=overlap+b
                    need(b"/data/data/com.termux" not in data,"DEB_FOREIGN_TERMUX_PATH:"+fields["Package"])
                    for match in re.finditer(rb"/data/(?:data|user/0)/[A-Za-z0-9_.]+",data):
                        path=match.group(0).decode("ascii")
                        need(path==APP_DATA or path.startswith(APP_DATA+"/"),"DEB_FOREIGN_ANDROID_APP_PATH:"+fields["Package"]+":"+path)
                    overlap=data[-128:]
    fields.update({"Filename":deb.name,"Size":deb.stat().st_size,"SHA256":sha256(deb)})
    return fields
def dependency_strings(fields: dict[str,str]) -> list[str]:
    return [key+": "+" ".join(fields[key].split()) for key in ("Depends","Pre-Depends") if fields.get(key)]
def audit_debs(directory: pathlib.Path) -> int:
    debs=sorted(directory.rglob("*.deb")); need(bool(debs),"NO_DEBS_TO_AUDIT")
    for f in debs: check_deb(f,True)
    print(f"DEB_STATIC_AUDIT_OK count={len(debs)} target_prefix={PREFIX}; device_test=NOT_RUN"); return len(debs)
def verify_base(source: pathlib.Path,index: pathlib.Path,out: pathlib.Path) -> int:
    src=source.resolve(strict=True); recs=parse_index(index); dest=out.resolve()
    need(dest!=src and not dest.is_relative_to(src),"BASE_OUTPUT_OVERLAPS_SOURCE"); dest.mkdir(parents=True,exist_ok=True)
    indexed=set(); copied=0
    for r in recs:
        for k in ("Package","Version","Architecture","Filename","Size","SHA256"): need(k in r,"BASE_INDEX_FIELD_MISSING_"+k)
        rel=safe_rel(r["Filename"]); need(rel.parts[:2]==("pool","main"),"BASE_INDEX_OUTSIDE_POOL")
        f=src.joinpath(*rel.parts); need(f.is_file() and not f.is_symlink(),"BASE_DEB_MISSING_OR_SYMLINK:"+r["Package"])
        need(str(f.stat().st_size)==r["Size"] and sha256(f)==r["SHA256"],"BASE_DEB_HASH_OR_SIZE_MISMATCH:"+r["Package"])
        meta={k:subprocess.run(["dpkg-deb","-f",str(f),k],capture_output=True,text=True,check=True).stdout.strip() for k in ("Package","Version","Architecture")}
        need((meta["Package"],meta["Version"],meta["Architecture"])==(r["Package"],r["Version"],r["Architecture"]),"BASE_DEB_METADATA_MISMATCH:"+r["Package"])
        indexed.add(rel.as_posix())
        if r["Package"] in REBUILT: continue
        check_deb(f,True); target=dest.joinpath(*rel.parts); target.parent.mkdir(parents=True,exist_ok=True)
        import shutil; shutil.copy2(f,target); copied+=1
    present={p.relative_to(src).as_posix() for p in (src/"pool").rglob("*.deb") if p.is_file() and not p.is_symlink()}
    need(present==indexed,"BASE_POOL_INDEX_SET_MISMATCH")
    print(f"BASE_INDEX_HASHES_OK records={len(recs)} safe_copied={copied} replaced_known_bad={len(recs)-copied}; unexpected_bad_payloads=FAIL_CLOSED")
    return len(recs)
def split_top(value: str, sep: str) -> list[str]:
    result=[]; depth=0; start=0
    for i,c in enumerate(value):
        if c=="(": depth+=1
        elif c==")": depth-=1; need(depth>=0,"DEPENDENCY_UNBALANCED")
        elif c==sep and depth==0: result.append(value[start:i].strip()); start=i+1
    need(depth==0,"DEPENDENCY_UNBALANCED"); result.append(value[start:].strip()); need(all(result),"DEPENDENCY_EMPTY_GROUP"); return result
REL=re.compile(r"^([a-z0-9][a-z0-9+.-]*)(?::([a-z0-9-]+))?(?:\s+\((<<|<=|=|>=|>>|<|>)\s+([^()]+)\))?$")
def version_ok(actual: str, op: str|None, wanted: str|None) -> bool:
    if not op: return True
    p=subprocess.run(["dpkg","--compare-versions",actual,{"<<":"lt","<":"lt","<=":"le","=":"eq",">=":"ge",">":"gt",">>":"gt"}[op],wanted or ""],check=False)
    need(p.returncode in (0,1),"DPKG_VERSION_COMPARE_FAILED"); return p.returncode==0
def parse_status(path: pathlib.Path) -> list[dict[str,str]]:
    try: text=path.read_text(encoding="utf-8",errors="strict")
    except Exception as e: raise GateError("BOOTSTRAP_STATUS_UNREADABLE") from e
    out=[]
    for b in re.split(r"\n\s*\n",text.strip()):
        if not b.strip(): continue
        d=parse_control(b)
        if d.get("Status")=="install ok installed": out.append(d)
    need(any(x.get("Package")=="ca-certificates" for x in out),"BOOTSTRAP_CA_CERTIFICATES_MISSING"); return out
def relations_closure(index: pathlib.Path,status: pathlib.Path) -> int:
    records=parse_index(index); installed=parse_status(status); checked=0
    by_name={}
    for r in records+installed: by_name.setdefault(r.get("Package",""),[]).append(r)
    def compatible(candidate: dict[str,str], qualifier: str|None) -> bool:
        arch=candidate.get("Architecture","")
        if arch not in (ARCH,"all"): return False
        if qualifier not in (None,"native","aarch64","any"): raise GateError("DEPENDENCY_ARCH_QUALIFIER_UNSUPPORTED:"+str(qualifier))
        if qualifier=="any" and arch!="all" and candidate.get("Multi-Arch") not in ("allowed","foreign"): return False
        return True
    def match(dep: tuple[str,str|None,str|None,str|None]) -> bool:
        name,qual,op,wanted=dep
        for c in by_name.get(name,[]):
            if compatible(c,qual) and version_ok(c.get("Version",""),op,wanted): return True
        # A provider can satisfy an unversioned dependency, or a versioned one only with an explicit versioned Provides.
        for c in records+installed:
            if not compatible(c,qual): continue
            for provided in split_top(c.get("Provides",""),",") if c.get("Provides") else []:
                m=REL.fullmatch(provided.strip()); need(m is not None,"PROVIDES_SYNTAX_UNSUPPORTED")
                pn,_,pop,pver=m.groups()
                if pn==name and (not op and not pop or op and pop=="=" and version_ok(pver,op,wanted)):
                    return True
        return False
    for rec in records:
        for field in ("Pre-Depends","Depends"):
            value=rec.get(field,"")
            if not value: continue
            need("[" not in value and "]" not in value and "<" not in value.split("(",1)[0],"DEPENDENCY_RESTRICTION_UNSUPPORTED:"+rec["Package"])
            for group in split_top(value,","):
                alts=[]
                for raw in split_top(group,"|"):
                    m=REL.fullmatch(raw.strip()); need(m is not None,"DEPENDENCY_SYNTAX_UNSUPPORTED:"+rec["Package"])
                    alts.append(m.groups())
                checked+=1; need(any(match(a) for a in alts),"DEPENDENCY_CLOSURE_INCOMPLETE:"+rec["Package"]+":"+field+":"+group)
    print(f"DEPENDENCY_CLOSURE_OK feed_records={len(records)} installed_baseline={len(installed)} exact_version_arch_alternatives=yes relation_groups={checked}")
    return checked
def extract_bootstrap_status(zip_path: pathlib.Path,out: pathlib.Path,expected_zip_sha256: str,entry: str="var/lib/dpkg/status") -> None:
    need(zip_path.is_file() and not zip_path.is_symlink(),"BOOTSTRAP_ZIP_MISSING")
    need(sha256(zip_path)==expected_zip_sha256,"BOOTSTRAP_ZIP_SHA256_MISMATCH")
    try: z=zipfile.ZipFile(zip_path)
    except Exception as e: raise GateError("BOOTSTRAP_ZIP_INVALID") from e
    matches=[i for i in z.infolist() if i.filename==entry and not i.is_dir()]
    need(len(matches)==1 and matches[0].file_size<8*1024*1024,"BOOTSTRAP_STATUS_ENTRY_INVALID")
    data=z.read(matches[0]); need(b"Package: ca-certificates\n" in data,"BOOTSTRAP_STATUS_CA_CERTIFICATES_MISSING"); out.write_bytes(data)
def feed_files(feed: pathlib.Path) -> list[pathlib.Path]:
    result=[]
    for p in sorted(feed.rglob("*")):
        if p.is_symlink(): raise GateError("FEED_SYMLINK_FORBIDDEN:"+p.relative_to(feed).as_posix())
        if p.is_file(): result.append(p)
    return result
def package_manifest(feed: pathlib.Path) -> list[dict[str,Any]]:
    idx=feed/"dists/stable/main/binary-aarch64/Packages"; result=[]
    for r in parse_index(idx):
        for k in ("Package","Version","Architecture","Filename","Size","SHA256"): need(k in r,"INDEX_FIELD_MISSING:"+k)
        rel=safe_rel(r["Filename"]); need(rel.parts[:2]==("pool","main"),"INDEX_FILE_OUTSIDE_POOL")
        f=feed.joinpath(*rel.parts); need(f.is_file() and not f.is_symlink(),"INDEX_FILE_MISSING")
        need(f.stat().st_size==int(r["Size"]) and sha256(f)==r["SHA256"],"INDEX_HASH_SIZE_MISMATCH")
        meta=check_deb(f,True); need((meta["Package"],meta["Version"],meta["Architecture"])==(r["Package"],r["Version"],r["Architecture"]),"INDEX_PACKAGE_METADATA_MISMATCH")
        for key in ("Depends","Pre-Depends"):
            need(" ".join(meta.get(key," ").split())==" ".join(r.get(key," ").split()),"INDEX_DEPENDENCY_METADATA_MISMATCH:"+r["Package"]+":"+key)
        result.append({"name":r["Package"],"version":r["Version"],"architecture":r["Architecture"],"filename":"feed/"+rel.as_posix(),"sizeBytes":int(r["Size"]),"sha256":r["SHA256"],"depends":dependency_strings(meta)})
    return result
def write_unsigned_release(feed: pathlib.Path) -> None:
    dist=feed/"dists/stable"; idx=dist/"main/binary-aarch64/Packages"; gz=idx.with_name("Packages.gz")
    need(idx.is_file() and gz.is_file(),"APT_INDEX_MISSING")
    need(gzip.decompress(gz.read_bytes())==idx.read_bytes(),"PACKAGES_GZIP_MISMATCH")
    lines=["Origin: Karat AI Builder", "Label: Karat AI Builder local package feed", "Suite: stable", "Codename: stable", "Architectures: aarch64", "Components: main", "Description: unsigned local APT metadata for offline validation", "SHA256:"]
    for f in (idx,gz): lines.append(f" {sha256(f)} {f.stat().st_size} main/binary-aarch64/{f.name}")
    (dist/"Release").write_text("\n".join(lines)+"\n",encoding="utf-8")
    need(not (dist/"InRelease").exists() and not (dist/"Release.gpg").exists(),"UNEXPECTED_SIGNED_APT_METADATA")
def write_manifest(root: pathlib.Path,catalog_commit: str,dependency_closure_complete: bool) -> dict[str,Any]:
    need(dependency_closure_complete,"DEPENDENCY_GATE_NOT_COMPLETE")
    need(re.fullmatch(r"[0-9a-fA-F]{40}",catalog_commit) is not None,"CATALOG_COMMIT_INVALID")
    feed=root/"feed"; packages=package_manifest(feed); files=[]
    for f in feed_files(feed): files.append({"path":"feed/"+f.relative_to(feed).as_posix(),"sizeBytes":f.stat().st_size,"sha256":sha256(f)})
    m={"format":FORMAT,"schemaVersion":2,"appId":APP_ID,"architecture":ARCH,"catalogState":"build-gated-awaiting-karat-signature","catalogCommit":catalog_commit,"catalogSha256":sha256(feed/"dists/stable/main/binary-aarch64/Packages"),"dependencyClosureComplete":True,"signatureAlgorithm":"SHA256withRSA","signerCertificateSha256":CERT_SHA256,"feedRoot":"feed","files":files,"packages":packages}
    (root/"manifest.json").write_text(json.dumps(m,sort_keys=True,indent=2)+"\n",encoding="utf-8"); return m
def verify_manifest(root: pathlib.Path) -> dict[str,Any]:
    p=root/"manifest.json"; need(p.is_file() and not p.is_symlink(),"MANIFEST_MISSING"); m=json.loads(p.read_text(encoding="utf-8"))
    required={"format","schemaVersion","appId","architecture","catalogState","catalogCommit","catalogSha256","dependencyClosureComplete","signatureAlgorithm","signerCertificateSha256","feedRoot","files","packages"}
    need(isinstance(m,dict) and set(m)==required,"MANIFEST_FIELDS_INVALID")
    need(m.get("format")==FORMAT and m.get("schemaVersion")==2,"MANIFEST_SCHEMA_INVALID")
    need(m.get("appId")==APP_ID and m.get("architecture")==ARCH and m.get("feedRoot")=="feed","MANIFEST_TARGET_INVALID")
    need(m.get("catalogState")=="build-gated-awaiting-karat-signature" and m.get("dependencyClosureComplete") is True,"MANIFEST_QUALIFICATION_INVALID")
    need(isinstance(m.get("catalogCommit"),str) and re.fullmatch(r"[0-9a-fA-F]{40}",m["catalogCommit"]) is not None,"MANIFEST_CATALOG_COMMIT_INVALID")
    need(m.get("signatureAlgorithm")=="SHA256withRSA" and m.get("signerCertificateSha256")==CERT_SHA256,"MANIFEST_KARAT_PIN_INVALID")
    need(isinstance(m.get("files"),list) and isinstance(m.get("packages"),list),"MANIFEST_ARRAY_FIELDS_INVALID")
    feed=root/"feed"; actual=["feed/"+f.relative_to(feed).as_posix() for f in feed_files(feed)]
    need(all(isinstance(x,dict) and "path" in x for x in m["files"]),"MANIFEST_FILE_ROW_FIELDS_INVALID")
    listed=[x["path"] for x in m["files"]]
    need(len(listed)==len(set(listed)) and set(listed)==set(actual),"MANIFEST_FILE_SET_MISMATCH")
    for ent in m["files"]:
        need(isinstance(ent,dict) and set(ent)=={"path","sizeBytes","sha256"},"MANIFEST_FILE_ROW_FIELDS_INVALID")
        rel=safe_rel(ent["path"]); f=root.joinpath(*rel.parts); need(f.stat().st_size==ent["sizeBytes"] and sha256(f)==ent["sha256"],"MANIFEST_FILE_HASH_OR_SIZE_MISMATCH:"+ent["path"])
    idx=feed/"dists/stable/main/binary-aarch64/Packages"; need(m.get("catalogSha256")==sha256(idx),"MANIFEST_CATALOG_HASH_MISMATCH")
    need(all(isinstance(x,dict) and set(x)=={"name","version","architecture","filename","sizeBytes","sha256","depends"} and isinstance(x["depends"],list) and all(isinstance(d,str) for d in x["depends"]) for x in m["packages"]),"MANIFEST_PACKAGE_ROW_FIELDS_INVALID")
    need(m.get("packages")==package_manifest(feed),"MANIFEST_PACKAGE_LIST_MISMATCH")
    need(not (root/"manifest.sig").exists(),"DETACHED_SIGNATURE_FORBIDDEN")
    return m
def main() -> int:
    ap=argparse.ArgumentParser(); sub=ap.add_subparsers(dest="cmd",required=True)
    x=sub.add_parser("audit-debs"); x.add_argument("--directory",type=pathlib.Path,required=True)
    x=sub.add_parser("verify-base"); x.add_argument("--source",type=pathlib.Path,required=True); x.add_argument("--index",type=pathlib.Path,required=True); x.add_argument("--out",type=pathlib.Path,required=True)
    x=sub.add_parser("extract-bootstrap-status"); x.add_argument("--zip",type=pathlib.Path,required=True); x.add_argument("--out",type=pathlib.Path,required=True); x.add_argument("--expected-zip-sha256",required=True); x.add_argument("--entry",default="var/lib/dpkg/status")
    x=sub.add_parser("closure"); x.add_argument("--index",type=pathlib.Path,required=True); x.add_argument("--status",type=pathlib.Path,required=True)
    x=sub.add_parser("write-release"); x.add_argument("--feed",type=pathlib.Path,required=True)
    x=sub.add_parser("write-manifest"); x.add_argument("--root",type=pathlib.Path,required=True); x.add_argument("--catalog-commit",required=True); x.add_argument("--dependency-closure-complete",action="store_true")
    x=sub.add_parser("verify-manifest"); x.add_argument("--root",type=pathlib.Path,required=True)
    a=ap.parse_args()
    try:
        if a.cmd=="audit-debs": audit_debs(a.directory)
        elif a.cmd=="verify-base": verify_base(a.source,a.index,a.out)
        elif a.cmd=="extract-bootstrap-status": extract_bootstrap_status(a.zip,a.out,a.expected_zip_sha256,a.entry)
        elif a.cmd=="closure": relations_closure(a.index,a.status)
        elif a.cmd=="write-release": write_unsigned_release(a.feed)
        elif a.cmd=="write-manifest":
            m=write_manifest(a.root,a.catalog_commit,a.dependency_closure_complete); print("UNSIGNED_BUILD_GATED_MANIFEST_WRITTEN files="+str(len(m["files"]))+" packages="+str(len(m["packages"]))+" karat_signature_pending=yes")
        elif a.cmd=="verify-manifest":
            m=verify_manifest(a.root); print(f"MANIFEST_FILE_HASHES_OK files={len(m['files'])} packages={len(m['packages'])} signature_pending=yes")
        return 0
    except (GateError,OSError,ValueError,KeyError,subprocess.SubprocessError,tarfile.TarError,zipfile.BadZipFile) as e:
        print("AIB_V507_GATE_REJECTED:"+(str(e) if isinstance(e,GateError) else "VALIDATION_INPUT_INVALID"),file=sys.stderr); return 2
if __name__=="__main__": raise SystemExit(main())
