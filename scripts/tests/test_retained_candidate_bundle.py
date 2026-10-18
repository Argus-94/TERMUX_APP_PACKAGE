import gzip
import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPT=Path(__file__).parents[1]/"verify-retained-candidate-bundle.py"
spec=importlib.util.spec_from_file_location("verify_retained",SCRIPT)
verify=importlib.util.module_from_spec(spec); spec.loader.exec_module(verify)

class ArchiveSafetyTests(unittest.TestCase):
    def archive(self, entries):
        td=tempfile.TemporaryDirectory(); self.addCleanup(td.cleanup); path=Path(td.name)/"x.tar.gz"
        with tarfile.open(path,"w:gz") as t:
            for name,kind,payload in entries:
                info=tarfile.TarInfo(name); info.type=kind
                if kind==tarfile.REGTYPE: info.size=len(payload); t.addfile(info, __import__('io').BytesIO(payload))
                else: t.addfile(info)
        return path
    def rejected(self, entries):
        with self.assertRaises(verify.Invalid): verify.inspect_tar(self.archive(entries))
    def test_traversal(self): self.rejected([("../escape",tarfile.REGTYPE,b"x")])
    def test_absolute(self): self.rejected([("/escape",tarfile.REGTYPE,b"x")])
    def test_symlink(self): self.rejected([("link",tarfile.SYMTYPE,b"")])
    def test_hardlink(self): self.rejected([("link",tarfile.LNKTYPE,b"")])
    def test_duplicate_path(self): self.rejected([("a",tarfile.REGTYPE,b"1"),("a",tarfile.REGTYPE,b"2")])
    def test_ancestor_file_collision(self): self.rejected([("a",tarfile.REGTYPE,b"x"),("a/b",tarfile.REGTYPE,b"y")])
    def test_live_tar_member_read(self):
        # Regression: extraction must occur before TarFile closes.
        self.assertEqual(verify.inspect_tar(self.archive([("a",tarfile.REGTYPE,b"payload")]))["a"],b"payload")

class RetainedBundleIntegrationTests(unittest.TestCase):
    def setUp(self):
        for cmd in ("gpg","gpgv","dpkg-deb","dpkg-scanpackages","git"): self.assertIsNotNone(shutil.which(cmd),cmd)
        # Reuse the existing fixture's genuine dpkg package and ephemeral GPG key setup.
        path=Path(__file__).with_name("test_candidate_retention.py")
        sp=importlib.util.spec_from_file_location("candidate_retention_tests",path); mod=importlib.util.module_from_spec(sp); sp.loader.exec_module(mod)
        self.fixture=mod.RetentionTests("test_real_dpkg_and_gpg_end_to_end"); self.fixture.setUp(); self.addCleanup(self.fixture.tearDown)
        f=self.fixture; repo=f.repo
        subprocess.run(["git","init","-q",str(repo)],check=True); subprocess.run(["git","-C",str(repo),"config","user.name","Fixture"],check=True); subprocess.run(["git","-C",str(repo),"config","user.email","fixture@example.invalid"],check=True)
        self.manifest=f.manifest; self.manifest.write_text(json.dumps({"source":{"commit":mod.SOURCE,"builderImage":mod.BUILDER},"packages":[{"name":"make","version":"1:4.4.1-1","architecture":"aarch64"}]}))
        subprocess.run(["git","-C",str(repo),"add","manifest.json"],check=True); subprocess.run(["git","-C",str(repo),"commit","-qm","fixture"],check=True)
        self.commit=subprocess.check_output(["git","-C",str(repo),"rev-parse","HEAD"],text=True).strip()
        a=list(f.args); a[7]=self.commit; a[10]="Argus-94/TERMUX_APP_PACKAGE"; f.args=tuple(a)
        f.test_real_dpkg_and_gpg_end_to_end()
        # The reused setup helper writes its own manifest; restore the intended committed source/builder fields.
        self.manifest.write_text(json.dumps({"source":{"commit":mod.SOURCE,"builderImage":mod.BUILDER},"packages":[{"name":"make","version":"1:4.4.1-1","architecture":"aarch64"}]}))
        subprocess.run(["git","-C",str(repo),"add","manifest.json"],check=True); subprocess.run(["git","-C",str(repo),"commit","-qm","manifest provenance"],check=False)
        self.commit=subprocess.check_output(["git","-C",str(repo),"rev-parse","HEAD"],text=True).strip()
        a=list(f.args); a[7]=self.commit; f.args=tuple(a)
        self.prepare_signed_feed()
        shutil.rmtree(f.dest)
        from importlib import import_module
        retention=mod.m
        self.retention=retention
        retention.stage(*f.args)
        self.archive=f.dest.with_name(f.dest.name+".tar.gz")
        self.fingerprint=json.loads((f.key/"keys"/retention.PUBLIC_META).read_text())["fingerprint"].replace(" ","").upper()
    def prepare_signed_feed(self, index_text=None):
        f=self.fixture; feed=f.feed; pool=feed/"pool"
        r=subprocess.run(["dpkg-scanpackages","pool","/dev/null"],cwd=feed,check=True,text=True,capture_output=True)
        text=r.stdout if index_text is None else index_text
        index=feed/"dists/stable/main/binary-aarch64/Packages"; index.write_text(text)
        (index.parent/"Packages.gz").write_bytes(gzip.compress(text.encode(),mtime=0))
        rel=feed/"dists/stable/Release"; files=[]
        for n in ("Packages","Packages.gz"):
            p=index.parent/n; files.append(f" {hashlib.sha256(p.read_bytes()).hexdigest()} {p.stat().st_size} main/binary-aarch64/{n}")
        rel.write_text("Suite: stable\nSHA256:\n"+"\n".join(files)+"\n")
        env=dict(os.environ,GNUPGHOME=str(f.key/"gnupg"))
        subprocess.run(["gpg","--batch","--yes","--clearsign","--output",str(feed/"dists/stable/InRelease"),str(rel)],env=env,check=True,capture_output=True)
        subprocess.run(["gpg","--batch","--yes","--detach-sign","--output",str(feed/"dists/stable/Release.gpg"),str(rel)],env=env,check=True,capture_output=True)
    def verify_call(self, fingerprint=None):
        f=self.fixture; out=Path(self.tempdir.name)/"verified"; report=Path(self.tempdir.name)/"report.json"
        return verify.verify(self.archive,"Argus-94/TERMUX_APP_PACKAGE",self.commit,"12",fingerprint or self.fingerprint,f.repo,out,report)
    @property
    def tempdir(self): return self.fixture.temp
    def test_real_signed_gpg_dpkg_feed_verifies(self):
        self.verify_call(); result=json.loads((Path(self.tempdir.name)/"report.json").read_text())
        self.assertTrue(result["valid"]); self.assertFalse(result["productionAllowed"])
    def test_tampered_checksum_payload_rejected_by_verify(self):
        self.assert_invalid_archive_edit("SHA256SUMS",lambda b:b.replace(b"  ",b"  ",1)+b"\n")
    def test_signed_but_incorrect_packages_digest_rejected(self):
        import re
        index=self.fixture.feed/"dists/stable/main/binary-aarch64/Packages"
        changed=re.sub(r"(?m)^SHA256: [a-f0-9]{64}$", "SHA256: "+"0"*64, index.read_text())
        self.prepare_signed_feed(changed)
        self.retention.stage(*self.fixture.args)
        with self.assertRaisesRegex(verify.Invalid,"Packages tuple/size/SHA256 mismatch"):
            self.verify_call()
    def test_debian_description_continuation(self):
        raw=b"Package: x\nVersion: 1\nArchitecture: all\nFilename: pool/x.deb\nSize: 1\nSHA256: "+b"0"*64+b"\nDescription: short\n long description\n .\n paragraph\n"
        self.assertIn("long description",verify.parse_packages(raw)[0]["Description"])
    def test_external_fingerprint_mismatch_rejected_by_verify(self):
        with self.assertRaisesRegex(verify.Invalid,"fingerprint mismatch"):
            self.verify_call("0"*40)
    def assert_invalid_archive_edit(self,name,edit):
        # Keep every archive member, change one content byte; verification must detect it.
        with tarfile.open(self.archive,"r:gz") as src:
            files={m.name:src.extractfile(m).read() for m in src if m.isfile()}
        files[name]=edit(files[name]); path=self.archive.with_name("tampered.tar.gz")
        with tarfile.open(path,"w:gz") as dst:
            for n,b in files.items():
                ti=tarfile.TarInfo(n); ti.size=len(b); dst.addfile(ti,__import__('io').BytesIO(b))
        old=self.archive; self.archive=path
        try:
            with self.assertRaises(verify.Invalid): self.verify_call()
        finally: self.archive=old

if __name__=="__main__": unittest.main()
