#!/usr/bin/env python3
"""Unit tests; all payload bytes are explicitly synthetic arbitrary fixture data."""
import hashlib
import io
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest

HERE = Path(__file__).resolve().parents[1]
HELPER = HERE / "candidate-packaging-policy.py"
APPLIER = HERE / "apply-candidate-packaging-policy.py"
spec = importlib.util.spec_from_file_location("candidate_policy", HELPER)
policy = importlib.util.module_from_spec(spec); spec.loader.exec_module(policy)
PREFIX = "data/user/0/com.karat.aibuilder/files/usr"
BASE = Path(os.environ["AIB_PINNED_SOURCE_ROOT"]) if os.environ.get("AIB_PINNED_SOURCE_ROOT") else None

class CandidatePolicyTests(unittest.TestCase):
    def fixture(self, root, reverse=False):
        # Arbitrary fake fixture bytes only; this is NOT a package or candidate artifact.
        payload = root / PREFIX
        (payload / "lib").mkdir(parents=True)
        (payload / "bin").mkdir()
        (payload / "lib" / "fixture.bin").write_bytes(b"arbitrary fake fixture bytes\x00\x01")
        os.link(payload / "lib" / "fixture.bin", payload / "bin" / "fixture-hardlink")
        (payload / "fixture-link").symlink_to("lib/fixture.bin")
        if reverse:
            payload.chmod(0o755); (payload / "lib").chmod(0o755); (payload / "bin").chmod(0o755)
        else:
            payload.chmod(0o700); (payload / "lib").chmod(0o700); (payload / "bin").chmod(0o700)
        return payload

    def test_creation_history_and_initial_modes_give_identical_payload_tar_and_size(self):
        with tempfile.TemporaryDirectory() as td:
            a, b = Path(td)/"a", Path(td)/"b"; a.mkdir(); b.mkdir()
            self.fixture(a, False); self.fixture(b, True)
            outs = []
            for stage in (a, b):
                out = subprocess.check_output(["python3", str(HELPER), "--stage", str(stage), "--prefix", "/"+PREFIX, "--normalize"], text=True).strip()
                tarpath = stage.parent / (stage.name + ".tar")
                subprocess.run(["tar", "--sort=name", "--mtime=@1234567890", "--owner=0", "--group=0", "--numeric-owner", "-cf", str(tarpath), "-H", "gnu", "./"+PREFIX], cwd=stage, check=True, stdout=subprocess.PIPE)
                outs.append((out, hashlib.sha256(tarpath.read_bytes()).hexdigest()))
            self.assertEqual(outs[0], outs[1])
            self.assertEqual(outs[0][0], "5")
            self.assertEqual((a/PREFIX).stat().st_mode & 0o777, 0o700)
            self.assertEqual((a/PREFIX/"lib").stat().st_mode & 0o777, 0o700)

    def test_helper_rejects_foreign_prefix_outside_content_and_special_payload(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td); self.fixture(root)
            for prefix in ("data/user/0/other/files/usr",):
                with self.assertRaises(ValueError): policy.apply(root, prefix)
            (root/"unexpected").write_bytes(b"arbitrary fake fixture bytes")
            with self.assertRaises(ValueError): policy.apply(root, PREFIX)
        with tempfile.TemporaryDirectory() as td:
            root=Path(td); payload=self.fixture(root)
            os.mkfifo(payload/"fifo")
            with self.assertRaises(ValueError): policy.apply(root, PREFIX)

    def test_symlink_ancestor_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td); (root/"data").symlink_to("/tmp")
            with self.assertRaises(ValueError): policy.apply(root, PREFIX)

    @unittest.skipUnless(BASE and BASE.is_dir(), "pinned source fixture requires AIB_PINNED_SOURCE_ROOT")
    def test_source_apply_is_pinned_idempotent_and_deb_untouched(self):
        with tempfile.TemporaryDirectory() as td:
            source=Path(td)/"source"
            for rel in ("scripts/build/termux_step_create_debian_package.sh", "scripts/build/termux_create_debian_subpackages.sh"):
                dest=source/rel; dest.parent.mkdir(parents=True, exist_ok=True); shutil.copyfile(BASE/rel, dest)
            # Explicit arbitrary fake archive bytes prove the applier does not touch .deb files.
            deb=source/"fixture.deb"; deb.write_bytes(b"arbitrary fake fixture bytes, not a deb")
            before=deb.read_bytes()
            cmd=["python3", str(APPLIER), "--source-root", str(source)]
            subprocess.run(cmd, check=True, stdout=subprocess.PIPE, text=True)
            before_second={p:p.read_bytes() for p in (source/"scripts/build/termux_step_create_debian_package.sh", source/"scripts/build/termux_create_debian_subpackages.sh", source/"scripts/build/.aib-candidate-packaging-policy.py")}
            subprocess.run(cmd, check=True, stdout=subprocess.PIPE, text=True)
            self.assertEqual(before_second, {p:p.read_bytes() for p in before_second})
            self.assertEqual(deb.read_bytes(), before)
            self.assertTrue((source/"scripts/build/.aib-candidate-packaging-policy.py").is_file())

    def test_source_hash_drift_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            source=Path(td)/"source"; source.mkdir()
            for rel in ("scripts/build/termux_step_create_debian_package.sh", "scripts/build/termux_create_debian_subpackages.sh"):
                p=source/rel; p.parent.mkdir(parents=True, exist_ok=True); p.write_text("modified fixture\n")
            result=subprocess.run(["python3", str(APPLIER), "--source-root", str(source)], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)

    def test_individual_rounding_empty_meta_and_virtual_absolute_link(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td)
            _,target=policy.apply(root,PREFIX)
            self.assertEqual(policy.installed_size(target),1)
            (target/"one").write_bytes(b"1"); (target/"two").write_bytes(b"2")
            self.assertEqual(policy.installed_size(target),3)
            (target/"absolute").symlink_to("/"+PREFIX+"/one")
            policy.apply(root,PREFIX)
            self.assertEqual(policy.installed_size(target),4)
            (target/"absolute").unlink(); (target/"escape").symlink_to("/etc/passwd")
            with self.assertRaises(ValueError): policy.apply(root,PREFIX)

    @unittest.skipUnless(BASE and BASE.is_dir(), "pinned source fixture requires AIB_PINNED_SOURCE_ROOT")
    def test_actual_patched_main_function_builds_identical_synthetic_debs(self):
        # Actual pinned Bash function builds explicit synthetic test archives.
        # These are not candidate packages, are never installed, and live only in this fixture.
        with tempfile.TemporaryDirectory() as td:
            root=Path(td); source=root/"source"
            for rel in ("scripts/build/termux_step_create_debian_package.sh", "scripts/build/termux_create_debian_subpackages.sh"):
                dest=source/rel; dest.parent.mkdir(parents=True,exist_ok=True); shutil.copyfile(BASE/rel,dest)
            subprocess.run(["python3",str(APPLIER),"--source-root",str(source)],check=True,capture_output=True)
            for script in source.glob("scripts/build/*.sh"):
                subprocess.run(["bash","-n",str(script)],check=True)
            deb_bytes=[]
            for suffix,reverse in (("a",False),("b",True)):
                stage=root/("stage-"+suffix); stage.mkdir(); self.fixture(stage,reverse)
                env=os.environ.copy()
                for key in ("BREAKS","PRE_DEPENDS","DEPENDS","CONFLICTS","RECOMMENDS","REPLACES","PROVIDES","SUGGESTS","CONFFILES"):
                    env["TERMUX_PKG_"+key]=""
                for key in ("pack", "cache", "out"):
                    (root/(key+suffix)).mkdir()
                env.update(TERMUX_PKG_METAPACKAGE="false",TERMUX_PKG_PLATFORM_INDEPENDENT="false",TERMUX_GLOBAL_LIBRARY="false",TERMUX_PKG_ESSENTIAL="false",TERMUX_ARCH="aarch64",TERMUX_PKG_NAME="synthetic-test-fixture-only",TERMUX_PKG_FULLVERSION="1",TERMUX_PKG_MAINTAINER="Synthetic fixture",TERMUX_PKG_HOMEPAGE="https://example.invalid/fixture",TERMUX_PKG_DESCRIPTION="Arbitrary synthetic test payload; not a candidate",TERMUX_PREFIX="/"+PREFIX,TERMUX_PREFIX_CLASSICAL="/"+PREFIX,TERMUX_PKG_MAKE_PROCESSES="1",SOURCE_DATE_EPOCH="1234567890",DEBUG="",TERMUX_PKG_PACKAGEDIR=str(root/("pack"+suffix)),TERMUX_COMMON_CACHEDIR=str(root/("cache"+suffix)),TERMUX_OUTPUT_DIR=str(root/("out"+suffix)))
                script='umask 022; source "$1"; termux_step_create_debscripts(){ :; }; termux_step_create_alternatives(){ :; }; termux_step_create_python_debscripts(){ :; }; termux_step_create_debian_package'
                subprocess.run(["bash","-eu","-c",script,"fixture",str(source/"scripts/build/termux_step_create_debian_package.sh")],cwd=stage,env=env,check=True,capture_output=True)
                deb=next((root/("out"+suffix)).glob("*.deb")); deb_bytes.append(deb.read_bytes())
                payload=subprocess.check_output(["ar","p",str(deb),"data.tar.xz"])
                with tarfile.open(fileobj=io.BytesIO(payload),mode="r:xz") as tar:
                    for member in tar:
                        name=member.name.removeprefix("./")
                        self.assertTrue(name==PREFIX or name.startswith(PREFIX+"/"),name)
                        if member.isdir(): self.assertEqual(member.mode,0o700)
                ctl=subprocess.check_output(["dpkg-deb","-f",str(deb),"Installed-Size"],text=True).strip()
                self.assertEqual(ctl,"5")
            self.assertEqual(deb_bytes[0],deb_bytes[1])

    @unittest.skipUnless(BASE and BASE.is_dir(), "pinned source fixture requires AIB_PINNED_SOURCE_ROOT")
    def test_actual_patched_subpackage_function_archives_normalized_prefix(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td); source=root/"source"
            for rel in ("scripts/build/termux_step_create_debian_package.sh", "scripts/build/termux_create_debian_subpackages.sh"):
                dest=source/rel; dest.parent.mkdir(parents=True,exist_ok=True); shutil.copyfile(BASE/rel,dest)
            subprocess.run(["python3",str(APPLIER),"--source-root",str(source)],check=True,capture_output=True)
            # Unrelated maintainer-script generator is a no-op synthetic fixture.
            (source/"scripts/build/termux_step_create_subpkg_debscripts.sh").write_text("termux_step_create_subpkg_debscripts(){ :; }\n")
            stage=root/"stage"; payload=stage/PREFIX; (payload/"lib").mkdir(parents=True)
            (payload/"lib/fixture-synthetic").write_bytes(b"1")
            for n in ("builder","tmp","cache","out","top"): (root/n).mkdir()
            (root/"builder/synthetic-sub-fixture.subpackage.sh").write_text('TERMUX_SUBPKG_INCLUDE="lib/fixture-synthetic"\nTERMUX_SUBPKG_DEPEND_ON_PARENT=false\nTERMUX_SUBPKG_DESCRIPTION="Synthetic fixture only"\n')
            env=os.environ.copy(); env.update(TERMUX_PACKAGE_LIBRARY="bionic",TERMUX_GLOBAL_LIBRARY="false",TERMUX_PKG_NO_STATICSPLIT="true",TERMUX_PKG_PLATFORM_INDEPENDENT="false",TERMUX_ARCH="aarch64",TERMUX_PKG_NAME="synthetic-parent",TERMUX_PKG_FULLVERSION="1",TERMUX_PKG_MAINTAINER="Synthetic fixture",TERMUX_PKG_HOMEPAGE="https://example.invalid/fixture",TERMUX_PKG_DEPENDS="",TERMUX_PREFIX="/"+PREFIX,TERMUX_PREFIX_CLASSICAL="/"+PREFIX,TERMUX_PKG_MAKE_PROCESSES="1",SOURCE_DATE_EPOCH="1234567890",DEBUG="",TERMUX_PKG_MASSAGEDIR=str(stage),TERMUX_SCRIPTDIR=str(source),TERMUX_TOPDIR=str(root/"top"),TERMUX_PKG_BUILDER_DIR=str(root/"builder"),TERMUX_PKG_TMPDIR=str(root/"tmp"),TERMUX_COMMON_CACHEDIR=str(root/"cache"),TERMUX_OUTPUT_DIR=str(root/"out"))
            script='umask 022; source "$1"; termux_step_create_python_debscripts(){ :; }; termux_create_debian_subpackages'
            subprocess.run(["bash","-e","-c",script,"fixture",str(source/"scripts/build/termux_create_debian_subpackages.sh")],cwd=payload,env=env,check=True,capture_output=True)
            deb=next((root/"out").glob("*.deb")); data=subprocess.check_output(["ar","p",str(deb),"data.tar.xz"])
            with tarfile.open(fileobj=io.BytesIO(data),mode="r:xz") as tar:
                for member in tar:
                    name=member.name.removeprefix("./")
                    self.assertTrue(name==PREFIX or name.startswith(PREFIX+"/"),name)
                    if member.isdir(): self.assertEqual(member.mode,0o700)
            self.assertEqual(subprocess.check_output(["dpkg-deb","-f",str(deb),"Installed-Size"],text=True).strip(),"3")

if __name__ == "__main__": unittest.main()
