#!/usr/bin/env python3
"""Check consistency of signed Android qualification evidence; never qualifies a device or promotes a package."""
from __future__ import annotations
import argparse, datetime as dt, hashlib, json, pathlib, re, subprocess, sys
import tempfile
from typing import Any
APP="com.karat.aibuilder"; HEX64=re.compile(r"^[a-f0-9]{64}$"); HEX40=re.compile(r"^[A-F0-9]{40}$")
class EvidenceError(Exception): pass
def need(ok, code):
    if not ok: raise EvidenceError(code)
def obj(pairs):
    out={}
    for k,v in pairs:
        need(k not in out,"JSON_DUPLICATE_KEY"); out[k]=v
    return out
def load(path):
    try: x=json.loads(path.read_text(encoding="utf-8"),object_pairs_hook=obj)
    except (OSError,UnicodeError,json.JSONDecodeError) as e: raise EvidenceError("JSON_INVALID") from e
    need(type(x) is dict,"JSON_OBJECT_REQUIRED"); return x
def exact(x,keys,code): need(type(x) is dict and set(x)==set(keys),code)
def sha_file(path):
    h=hashlib.sha256()
    with path.open("rb") as f:
        for b in iter(lambda:f.read(1024*1024),b""): h.update(b)
    return h.hexdigest()
def artifact(root,rel):
    need(type(rel) is str and rel and "\\" not in rel,"ARTIFACT_PATH_INVALID")
    p=pathlib.PurePosixPath(rel)
    need(not p.is_absolute() and p.as_posix()==rel and all(s not in ("",".","..") for s in p.parts),"ARTIFACT_PATH_INVALID")
    need(not any(x.is_symlink() for x in (root, *root.parents)),"ARTIFACT_ROOT_INVALID"); cur=root
    for part in p.parts:
        cur=cur/part; need(not cur.is_symlink(),"ARTIFACT_SYMLINK_REJECTED")
    need(cur.is_file() and not cur.is_symlink(),"ARTIFACT_FILE_REQUIRED"); return cur
def digest_ref(root,entry):
    exact(entry,("path","sha256"),"ARTIFACT_REF_INVALID")
    need(type(entry["sha256"]) is str and HEX64.fullmatch(entry["sha256"]),"ARTIFACT_HASH_INVALID")
    need(sha_file(artifact(root,entry["path"]))==entry["sha256"],"ARTIFACT_HASH_MISMATCH"); return entry["sha256"]
def validate(args):
    root=args.artifact_root; need(root.is_dir() and not any(x.is_symlink() for x in (root, *root.parents)),"ARTIFACT_ROOT_INVALID")
    need(not args.trusted_keyring.is_symlink() and args.trusted_keyring.is_file(),"TRUST_KEYRING_INVALID")
    need(not args.signature.is_symlink() and args.signature.is_file(),"SIGNATURE_INVALID")
    need(not args.evidence.is_symlink() and args.evidence.is_file(),"EVIDENCE_FILE_INVALID")
    need(HEX40.fullmatch(args.expected_fingerprint) is not None,"EXPECTED_FINGERPRINT_INVALID")
    keyring=args.trusted_keyring.resolve(strict=True)
    try: v=subprocess.run(["gpgv","--status-fd=1","--keyring",str(keyring),str(args.signature),str(args.evidence)],capture_output=True,text=True,timeout=30,check=False)
    except (OSError,subprocess.SubprocessError) as e: raise EvidenceError("SIGNATURE_VERIFICATION_FAILED") from e
    need(v.returncode==0,"SIGNATURE_VERIFICATION_FAILED")
    valid=[line.split() for line in v.stdout.splitlines() if line.startswith("[GNUPG:] VALIDSIG ")]
    need(len(valid)==1 and len(valid[0])>=12 and valid[0][11]==args.expected_fingerprint,"SIGNER_FINGERPRINT_MISMATCH")
    need(not args.candidate_manifest.is_symlink() and args.candidate_manifest.is_file(),"CANDIDATE_MANIFEST_INVALID")
    m=load(args.candidate_manifest); e=load(args.evidence)
    exact(e,("schemaVersion","applicationId","candidateManifestSha256","apk","device","feed","checks","projectSourceSnapshot"),"EVIDENCE_KEYS_INVALID")
    need(sha_file(args.candidate_manifest)==e.get("candidateManifestSha256"),"CANDIDATE_MANIFEST_HASH_MISMATCH")
    need({"schemaVersion","target","channel","releaseGate"} <= set(m),"CANDIDATE_MANIFEST_INVALID")
    need(type(m["schemaVersion"]) is int and m["schemaVersion"]==1,"CANDIDATE_MANIFEST_INVALID")
    need(type(m["target"]) is dict and {"applicationId","architecture"} <= set(m["target"]),"CANDIDATE_MANIFEST_INVALID")
    need(m["target"]["applicationId"]==APP and m["target"]["architecture"]=="aarch64","CANDIDATE_TARGET_INVALID")
    need(m["channel"]=="candidate-only","CANDIDATE_CHANNEL_INVALID")
    need(type(m["releaseGate"]) is dict and "publicationAllowed" in m["releaseGate"],"CANDIDATE_MANIFEST_INVALID")
    need(m["releaseGate"]["publicationAllowed"] is False,"CANDIDATE_PUBLICATION_ALLOWED")
    need(type(e["schemaVersion"]) is int and e["schemaVersion"]==1 and e["applicationId"]==APP,"EVIDENCE_IDENTITY_INVALID")
    need(type(e["candidateManifestSha256"]) is str and HEX64.fullmatch(e["candidateManifestSha256"]),"MANIFEST_HASH_INVALID")
    exact(e["apk"],("artifact","signingCertificateSha256","versionName"),"APK_INVALID"); digest_ref(root,e["apk"]["artifact"])
    need(type(e["apk"]["signingCertificateSha256"]) is str and HEX64.fullmatch(e["apk"]["signingCertificateSha256"]),"APK_CERTIFICATE_INVALID")
    need(type(e["apk"]["versionName"]) is str and bool(e["apk"]["versionName"].strip()),"APK_VERSION_INVALID")
    d=e["device"]; exact(d,("apiLevel","abi","buildFingerprint","observedDataDir","observedPrefix"),"DEVICE_INVALID")
    need(type(d["apiLevel"]) is int and d["apiLevel"]>=24 and d["abi"]=="aarch64","DEVICE_PLATFORM_INVALID")
    need(type(d["buildFingerprint"]) is str and d["buildFingerprint"].strip(),"DEVICE_FINGERPRINT_INVALID")
    need(type(d["observedDataDir"]) is str and re.fullmatch(r"/data/user/[0-9]+/com\.karat\.aibuilder|/data/data/com\.karat\.aibuilder",d["observedDataDir"]),"DEVICE_DATA_DIR_INVALID")
    need(d["observedPrefix"]==d["observedDataDir"]+"/files/usr","DEVICE_PREFIX_INVALID")
    f=e["feed"]; exact(f,("url","keyFingerprint","keyring","release","inRelease"),"FEED_INVALID")
    from urllib.parse import urlsplit
    u=urlsplit(f["url"] if type(f["url"]) is str else "")
    need(u.scheme=="https" and u.hostname and not u.username and not u.password and not u.query and not u.fragment,"FEED_URL_INVALID")
    need(type(f["keyFingerprint"]) is str and HEX40.fullmatch(f["keyFingerprint"]),"FEED_KEY_FINGERPRINT_INVALID")
    exact(f["keyring"],("path","sha256"),"FEED_KEYRING_INVALID")
    keyhash=digest_ref(root,f["keyring"]); digest_ref(root,f["release"]); digest_ref(root,f["inRelease"])
    need(keyhash!=sha_file(keyring),"CANDIDATE_KEYRING_IS_TRUST")
    with tempfile.TemporaryDirectory(prefix="aib-evidence-key-") as home:
        pub=subprocess.run(["gpg","--batch","--no-options","--homedir",home,"--with-colons","--show-keys",str(artifact(root,f["keyring"]["path"]).resolve())],capture_output=True,text=True,timeout=30,check=False)
    need(pub.returncode==0,"FEED_KEYRING_UNREADABLE")
    primary=[]; awaiting=False
    for line in pub.stdout.splitlines():
        fields=line.split(":")
        if fields[0]=="pub": awaiting=True
        elif fields[0]=="sub": awaiting=False
        elif fields[0]=="fpr" and awaiting:
            need(len(fields)>9,"FEED_KEYRING_UNREADABLE")
            primary.append(fields[9]); awaiting=False
    need(primary==[f["keyFingerprint"]],"FEED_KEYRING_FINGERPRINT_MISMATCH")
    need(f["keyFingerprint"]!=args.expected_fingerprint,"CANDIDATE_KEYRING_IS_TRUST")
    exact(e["projectSourceSnapshot"],("path","sha256"),"SOURCE_SNAPSHOT_INVALID"); digest_ref(root,e["projectSourceSnapshot"])
    checks=e["checks"]; names=("install","runtime","projectBuild","upgrade","rollback"); exact(checks,names,"CHECK_SET_INVALID")
    now=dt.datetime.now(dt.timezone.utc)
    for name in names:
        c=checks[name]; keys=("status","timestamp","commands","beforeSnapshot","afterSnapshot") if name in ("upgrade","rollback") else ("status","timestamp","commands")
        exact(c,keys,"CHECK_INVALID"); need(c["status"]=="PASS","CHECK_NOT_PASS")
        try:
            stamp=c["timestamp"]; need(type(stamp) is str and stamp.endswith("Z"),"CHECK_TIMESTAMP_INVALID")
            when=dt.datetime.fromisoformat(stamp[:-1]+"+00:00"); need(when.utcoffset()==dt.timedelta(0),"CHECK_TIMESTAMP_INVALID")
        except (ValueError,TypeError): raise EvidenceError("CHECK_TIMESTAMP_INVALID")
        need(when<=now+dt.timedelta(minutes=5),"CHECK_TIMESTAMP_FUTURE")
        need(type(c["commands"]) is list and c["commands"],"CHECK_COMMANDS_REQUIRED")
        for cmd in c["commands"]:
            exact(cmd,("command","exitCode","log"),"COMMAND_INVALID")
            need(type(cmd["command"]) is str and cmd["command"].strip() and type(cmd["exitCode"]) is int and cmd["exitCode"]==0,"COMMAND_FAILED")
            digest_ref(root,cmd["log"])
    for name in ("upgrade","rollback"):
        c=checks[name]; before,after=c["beforeSnapshot"],c["afterSnapshot"]
        digest_ref(root,before); digest_ref(root,after); need(before["sha256"]!=after["sha256"],"SNAPSHOTS_NOT_DISTINCT")
    need(checks["rollback"]["beforeSnapshot"]["sha256"]==checks["upgrade"]["afterSnapshot"]["sha256"],"ROLLBACK_BASELINE_MISMATCH")
    need(checks["rollback"]["afterSnapshot"]["sha256"]==checks["upgrade"]["beforeSnapshot"]["sha256"],"ROLLBACK_RESTORE_MISMATCH")
def main():
    p=argparse.ArgumentParser(description=__doc__)
    for x in ("evidence","artifact-root","candidate-manifest","trusted-keyring","expected-fingerprint","signature"):
        p.add_argument("--"+x,required=True,type=pathlib.Path if x in ("evidence","artifact-root","candidate-manifest","trusted-keyring","signature") else str)
    a=p.parse_args()
    try: validate(a)
    except (EvidenceError,OSError,ValueError,KeyError,TypeError,subprocess.SubprocessError) as ex:
        print("EVIDENCE_BUNDLE_REJECTED:"+(str(ex) if isinstance(ex,EvidenceError) else "INPUT_INVALID"),file=sys.stderr); return 2
    print("EVIDENCE_BUNDLE_CONSISTENT device_claims_independently_verified=0 production_publication=blocked pkg_ensure=blocked"); return 0
if __name__=="__main__": raise SystemExit(main())
