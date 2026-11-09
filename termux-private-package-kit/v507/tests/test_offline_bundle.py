from __future__ import annotations
import gzip
import hashlib
import importlib.util
import json
import pathlib
import shutil
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[3]
SCRIPT = ROOT / "scripts/validate-aib-v507-offline-bundle.py"
LOCK = json.loads((ROOT / "termux-private-package-kit/v507/package-lock.json").read_text())
spec = importlib.util.spec_from_file_location("v507_gate", SCRIPT)
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


@unittest.skipUnless(shutil.which("dpkg-deb") and shutil.which("dpkg") and shutil.which("dpkg-scanpackages"), "dpkg tools required")
class OfflineFeedTests(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="aib-v507-test-"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def make_deb(self, name="demo", version="1", depends="", pre_depends="", payload="data/data/com.karat.aibuilder/files/usr/share/demo/item", arch="aarch64", content="fixture\n"):
        root = self.tmp / ("root-" + name + version.replace("/", "_"))
        shutil.rmtree(root, ignore_errors=True)
        (root / "DEBIAN").mkdir(parents=True)
        control = f"Package: {name}\nVersion: {version}\nArchitecture: {arch}\nMaintainer: fixture\nDescription: test fixture\n"
        if depends:
            control += f"Depends: {depends}\n"
        if pre_depends:
            control += f"Pre-Depends: {pre_depends}\n"
        (root / "DEBIAN/control").write_text(control)
        f = root / payload
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(content)
        out = self.tmp / f"{name}_{version}_{arch}.deb"
        subprocess.run(["dpkg-deb", "--build", str(root), str(out)], check=True, capture_output=True)
        return out

    def make_index(self, feed, debs):
        lines = []
        for deb in debs:
            rel = pathlib.Path("pool/main") / subprocess.check_output(["dpkg-deb", "-f", str(deb), "Package"], text=True).strip() / deb.name
            dest = feed / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(deb, dest)
            fields = {k: subprocess.check_output(["dpkg-deb", "-f", str(dest), k], text=True).strip() for k in ("Package", "Version", "Architecture")}
            row = [f"{k}: {fields[k]}" for k in ("Package", "Version", "Architecture")]
            for key in ("Pre-Depends", "Depends"):
                value = subprocess.run(["dpkg-deb", "-f", str(dest), key], text=True, capture_output=True)
                if value.returncode == 0 and value.stdout.strip():
                    row.append(f"{key}: {value.stdout.strip()}")
            row.extend([f"Filename: {rel.as_posix()}", f"Size: {dest.stat().st_size}", f"SHA256: {hashlib.sha256(dest.read_bytes()).hexdigest()}"])
            lines.append("\n".join(row))
        idx = feed / "dists/stable/main/binary-aarch64/Packages"
        idx.parent.mkdir(parents=True, exist_ok=True)
        idx.write_text("\n\n".join(lines) + "\n")
        gz = idx.with_name("Packages.gz")
        gz.write_bytes(gzip.compress(idx.read_bytes(), mtime=0))
        return idx

    def make_status(self, version="2", arch="all"):
        p = self.tmp / "status"
        p.write_text(f"Package: ca-certificates\nStatus: install ok installed\nVersion: {version}\nArchitecture: {arch}\n\n")
        return p

    def test_payload_paths_and_foreign_android_paths_fail_closed(self):
        good = self.make_deb()
        self.assertEqual(gate.check_deb(good)["Package"], "demo")
        bad = self.make_deb("bad", payload="data/data/com.termux/files/usr/bin/bad")
        with self.assertRaises(gate.GateError):
            gate.check_deb(bad)
        foreign_string = self.make_deb("foreign-string", content="/data/data/com.termux/files/usr/bin/tool\n")
        with self.assertRaises(gate.GateError):
            gate.check_deb(foreign_string)
        other_app = self.make_deb("other-app", content="/data/user/0/com.example.other/files/usr\n")
        with self.assertRaises(gate.GateError):
            gate.check_deb(other_app)

    def test_draft_v2_manifest_exact_fields_dependencies_and_tamper_detection(self):
        feed = self.tmp / "feed"
        deb = self.make_deb(depends="libc (>= 1)", pre_depends="ca-certificates")
        self.make_index(feed, [deb])
        gate.write_unsigned_release(feed)
        root = self.tmp / "handoff"
        shutil.copytree(feed, root / "feed")
        commit = "505e06ef0c8dbd7611abfb90e9eb60826dcd01d7"
        m = gate.write_manifest(root, commit, True)
        self.assertEqual(set(m), {"format", "schemaVersion", "appId", "architecture", "catalogState", "catalogCommit", "catalogSha256", "dependencyClosureComplete", "signatureAlgorithm", "signerCertificateSha256", "feedRoot", "files", "packages"})
        self.assertEqual(m["format"], "aibuilder-offline-package-bundle")
        self.assertEqual(m["schemaVersion"], 2)
        self.assertEqual(m["catalogState"], "build-gated-awaiting-karat-signature")
        self.assertTrue(m["dependencyClosureComplete"])
        self.assertEqual(m["signatureAlgorithm"], "SHA256withRSA")
        self.assertEqual(m["signerCertificateSha256"], gate.CERT_SHA256)
        self.assertEqual(m["packages"][0]["depends"], ["Depends: libc (>= 1)", "Pre-Depends: ca-certificates"])
        self.assertTrue(all(set(row) == {"name", "version", "architecture", "filename", "sizeBytes", "sha256", "depends"} for row in m["packages"]))
        dist = feed / "dists/stable"
        self.assertTrue((dist / "Release").is_file())
        self.assertFalse((dist / "InRelease").exists())
        self.assertFalse((dist / "Release.gpg").exists())
        self.assertNotIn("manifest.sig", [x["path"] for x in m["files"]])
        self.assertFalse((root / "manifest.sig").exists())
        gate.verify_manifest(root)
        (root / "feed/dists/stable/Release").write_text("tampered\n")
        with self.assertRaises(gate.GateError):
            gate.verify_manifest(root)

    def test_unsigned_verifier_rejects_extra_fields_and_production_state(self):
        feed = self.tmp / "feed"
        self.make_index(feed, [self.make_deb()])
        gate.write_unsigned_release(feed)
        root = self.tmp / "handoff"
        shutil.copytree(feed, root / "feed")
        gate.write_manifest(root, "505e06ef0c8dbd7611abfb90e9eb60826dcd01d7", True)
        manifest_path = root / "manifest.json"
        original = json.loads(manifest_path.read_text())
        extra = dict(original, bootstrapZipSha256="0" * 64)
        manifest_path.write_text(json.dumps(extra))
        with self.assertRaises(gate.GateError):
            gate.verify_manifest(root)
        production = dict(original, catalogState="production-qualified")
        manifest_path.write_text(json.dumps(production))
        with self.assertRaises(gate.GateError):
            gate.verify_manifest(root)

    def test_manifest_dependency_metadata_must_match_deb_control(self):
        feed = self.tmp / "feed"
        self.make_index(feed, [self.make_deb(depends="libc (>= 1)")])
        index = feed / "dists/stable/main/binary-aarch64/Packages"
        index.write_text(index.read_text().replace("Depends: libc (>= 1)", "Depends: other-lib"))
        with self.assertRaises(gate.GateError):
            gate.package_manifest(feed)

    def test_manifest_cannot_claim_closure_before_gate_or_invalid_commit(self):
        with self.assertRaises(gate.GateError):
            gate.write_manifest(self.tmp, "pin", False)
        feed = self.tmp / "feed"
        self.make_index(feed, [self.make_deb()])
        with self.assertRaises(gate.GateError):
            gate.write_manifest(self.tmp, "pin", True)

    def test_dependency_alternatives_versions_and_multiple_feed_versions(self):
        idx = self.tmp / "Packages"
        idx.write_text("Package: consumer\nVersion: 1\nArchitecture: aarch64\nDepends: absent (>= 9) | ca-certificates (>= 1)\n\nPackage: libsample\nVersion: 1\nArchitecture: aarch64\n\nPackage: libsample\nVersion: 3\nArchitecture: aarch64\n\nPackage: user\nVersion: 1\nArchitecture: aarch64\nDepends: libsample (>= 2)\n\n")
        gate.relations_closure(idx, self.make_status("2", "all"))

    def test_bootstrap_package_requires_exact_sufficient_version_and_architecture(self):
        idx = self.tmp / "Packages"
        idx.write_text("Package: consumer\nVersion: 1\nArchitecture: aarch64\nDepends: ca-certificates (>= 2)\n\n")
        gate.relations_closure(idx, self.make_status("2", "all"))
        with self.assertRaises(gate.GateError):
            gate.relations_closure(idx, self.make_status("1", "all"))
        with self.assertRaises(gate.GateError):
            gate.relations_closure(idx, self.make_status("2", "arm"))

    def test_bootstrap_ca_certificates_must_be_installed(self):
        p = self.tmp / "status"
        p.write_text("Package: ca-certificates\nStatus: deinstall ok config-files\nVersion: 1\nArchitecture: all\n\n")
        with self.assertRaises(gate.GateError):
            gate.parse_status(p)

    def test_package_lock_bootstrap_and_certificate_pins(self):
        self.assertEqual(LOCK["bootstrap"]["zipSha256"], "08a447f60c06783f33561583553149cf992ac7d9779071c71b8aaeeb452451b4")
        self.assertEqual(LOCK["manifest"]["signerCertificateSha256"], gate.CERT_SHA256)
        self.assertNotIn("karatCertificateSha256", LOCK["manifest"])
        outputs = {name for pkg in LOCK["packages"] for name in pkg["outputs"]}
        self.assertEqual(outputs, gate.REBUILT)
        self.assertEqual(LOCK["prefix"], "/data/data/com.karat.aibuilder/files/usr")


if __name__ == "__main__":
    unittest.main(verbosity=2)
