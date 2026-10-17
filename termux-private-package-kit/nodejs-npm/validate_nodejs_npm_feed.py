#!/usr/bin/env python3
"""Validate a temporary Node.js/npm candidate feed against pinned audit/build records."""
from __future__ import annotations
import argparse, email.parser, gzip, hashlib, json, pathlib, subprocess, sys
PIN="505e06ef0c8dbd7611abfb90e9eb60826dcd01d7"
COUNT=11
ALT_COUNT=14
NPM_DEPENDS="nodejs | nodejs-lts"
def require(ok: bool, code: str) -> None:
    if not ok: raise ValueError(code)
def package_records(path: pathlib.Path):
    records=[]; cur={}; prev=None
    for line in path.read_text(encoding="utf-8",errors="strict").splitlines()+[""]:
        if not line:
            if cur: records.append(cur); cur={}; prev=None
        elif line[0] in " \t":
            require(prev is not None,"INDEX_ORPHAN_CONTINUATION"); cur[prev]+=" "+line.strip()
        else:
            k,sep,v=line.partition(":"); require(bool(sep) and k not in cur,"INDEX_FIELD_INVALID"); cur[k]=v.strip(); prev=k
    return records
def validate_indexes(root, feed, specs):
    base=root/"dists/stable/main/binary-aarch64"; idx=base/"Packages"; gz=base/"Packages.gz"
    require(idx.is_file() and not idx.is_symlink() and gz.is_file() and not gz.is_symlink(),"PACKAGES_INDEX_MISSING")
    try: raw=gzip.decompress(gz.read_bytes())
    except (OSError,EOFError): raise ValueError("PACKAGES_GZIP_INVALID")
    require(raw==idx.read_bytes(),"PACKAGES_GZIP_MISMATCH"); records=package_records(idx); require(len(records)==COUNT,"INDEX_RECORD_COUNT_MISMATCH")
    out={}
    for r in records:
        n=r.get("Package",""); require(n in specs and n not in out,"INDEX_PACKAGE_SET_MISMATCH")
        require((r.get("Version"),r.get("Architecture"))==(specs[n]["version"],specs[n]["architecture"]),"INDEX_PACKAGE_IDENTITY_MISMATCH")
        fn=r.get("Filename",""); pp=pathlib.PurePosixPath(fn); require(fn and not pp.is_absolute() and ".." not in pp.parts and "." not in pp.parts and "\\" not in fn,"INDEX_FILENAME_TRAVERSAL")
        deb=feed[n]; require(fn==deb.relative_to(root).as_posix(),"INDEX_FILENAME_MISMATCH")
        require(deb.is_file() and not deb.is_symlink() and r.get("Size")==str(deb.stat().st_size),"INDEX_PACKAGE_FILE_MISMATCH")
        require(r.get("SHA256")==hashlib.sha256(deb.read_bytes()).hexdigest(),"INDEX_PACKAGE_SHA256_MISMATCH"); out[n]=r
    return out
def validate_npm_provider(depends: str) -> None:
    require(depends == NPM_DEPENDS, "NPM_DEPENDS_NOT_EXACT")

def validate(package_set, source_closure, feed_root, build_path, audit_path, prefix):
    from audit_nodejs_npm_closure import validate_manifest
    manifest,_,specs=validate_manifest(argparse.Namespace(package_set=package_set,source_closure=source_closure,prefix=prefix))
    build=json.loads(build_path.read_text()); audit=json.loads(audit_path.read_text())
    require(manifest.get("releaseGate",{}).get("publicationAllowed") is False,"PUBLICATION_GATE_OPEN")
    from audit_nodejs_npm_closure import BUILDER_IMAGE, normalize_prefix
    canonical_prefix=normalize_prefix(prefix)
    require(build.get("status")=="audit-passed; device-runtime-test-not-run" and
            build.get("sourceCommit")==PIN and build.get("builderImage")==BUILDER_IMAGE and
            build.get("prefix")==canonical_prefix and
            build.get("prefixProvenance")=="ci-model-only; device-observation-not-run" and
            build.get("installed") is False and build.get("deviceSmokeTest")=="NOT RUN" and
            build.get("rollback")=="NOT RUN", "BUILD_GATE_STATE_MISMATCH")
    require(build.get("sourceClosure")=={"profile":"nodejs-npm-candidate","rootPackages":["nodejs","npm"],
            "buildTargetPackages":["nodejs","npm"],"packageCount":COUNT,
            "dependencyAlternativeCount":ALT_COUNT}, "BUILD_CLOSURE_MISMATCH")
    require(audit.get("ok") is True and audit.get("sourceCommit")==PIN and
            audit.get("builderImage")==BUILDER_IMAGE and audit.get("prefix")==canonical_prefix and
            audit.get("prefixProvenance")=="ci-model-only; device-observation-not-run" and
            audit.get("deviceInstall")=="NOT RUN" and audit.get("rollback")=="NOT RUN", "AUDIT_GATE_STATE_MISMATCH")
    require(audit.get("sourceClosureProfile")=="nodejs-npm-candidate" and audit.get("sourceBuildTargetPackage")=="npm" and
            audit.get("sourceClosurePackageCount")==COUNT and audit.get("candidatePackageCount")==COUNT and
            audit.get("sourceClosureDependencyAlternativeCount")==ALT_COUNT, "AUDIT_CLOSURE_MISMATCH")
    specs_by={x["name"]:x for x in specs}; expected=set(specs_by); debs=sorted(feed_root.glob("pool/main/*/*.deb")); require(len(debs)==COUNT,"FEED_DEB_COUNT_MISMATCH")
    feed={}
    for d in debs:
        raw=subprocess.run(["dpkg-deb","-f",str(d)],check=True,capture_output=True,text=True,timeout=30).stdout; f=email.parser.Parser().parsestr(raw); n=f.get("Package","")
        require(n in expected and n not in feed,"FEED_PACKAGE_SET_MISMATCH")
        require((f.get("Version"),f.get("Architecture"))==(specs_by[n]["version"],specs_by[n]["architecture"]),"FEED_PACKAGE_IDENTITY_MISMATCH")
        h=hashlib.sha256(d.read_bytes()).hexdigest(); ar={x["name"]:x for x in audit["packages"]}; br={x["name"]:x for x in build.get("packages",[])}
        require(h==ar[n].get("sha256")==br[n].get("sha256"),"FEED_PACKAGE_HASH_MISMATCH"); feed[n]=d
    require(set(feed)==expected,"FEED_PACKAGE_SET_MISMATCH")
    index=validate_indexes(feed_root,feed,specs_by)
    npm=index["npm"]; validate_npm_provider(npm.get("Depends", ""))
    require(not {"nodejs-lts","nodejs-current","nodejs-dev"}&expected,"FORBIDDEN_NODE_PROVIDER_PRESENT")
    node=feed.get("nodejs")
    node_fields=email.parser.Parser().parsestr(subprocess.run(["dpkg-deb","-f",str(node)],check=True,capture_output=True,text=True,timeout=30).stdout)
    provides={x.strip().split(" ",1)[0] for x in node_fields.get("Provides", "").split(",") if x.strip()}
    require("nodejs-lts" not in provides,"FORBIDDEN_NODE_LTS_PROVIDES")
    return True
def main():
    p=argparse.ArgumentParser(description=__doc__)
    for arg in ("package-set","source-closure","feed-root","build-result","audit-report"): p.add_argument("--"+arg,type=pathlib.Path,required=True)
    p.add_argument("--prefix",required=True); a=p.parse_args()
    try:
        validate(a.package_set,a.source_closure,a.feed_root,a.build_result,a.audit_report,a.prefix); print("NODEJS_NPM_TEMP_FEED_VALIDATED packages=11 npm-provider=nodejs install=NOT_PERFORMED"); return 0
    except (OSError,ValueError,KeyError,TypeError,json.JSONDecodeError,subprocess.SubprocessError) as e: print("NODEJS_NPM_FEED_REJECTED:"+(str(e) if isinstance(e,ValueError) else "INPUT_INVALID"),file=sys.stderr); return 2
if __name__=="__main__": raise SystemExit(main())
