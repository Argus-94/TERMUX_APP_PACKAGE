import importlib.util
import json
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

p = Path(__file__).parents[1] / "stage-candidate-retention.py"
spec = importlib.util.spec_from_file_location("retention", p)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

COMMIT = "5" * 40
SOURCE = "a" * 40
BUILDER = "ghcr.io/termux/package-builder@sha256:" + "b" * 64


class RetentionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.repo = root / "repo"
        self.output = root / "out"
        self.feed = root / "feed"
        self.key = root / "key"
        self.dest = root / "bundle"
        for d in (self.repo, self.output / "packages", self.feed / "dists/stable/main/binary-aarch64",
                  self.feed / "pool/main/make", self.key / "keys", self.key / "gnupg"):
            d.mkdir(parents=True, exist_ok=True)
        self.manifest = self.repo / "manifest.json"
        self.manifest.write_text(json.dumps({"packages": [{"name": "make", "version": "4.4.1-1", "architecture": "aarch64", "sourceCommit": SOURCE}]}))
        self.deb = self.output / "packages/make_4.4.1-1_aarch64.deb"
        self.deb.write_bytes(b"deb bytes")
        import hashlib
        digest = hashlib.sha256(self.deb.read_bytes()).hexdigest()
        (self.output / "build-result.json").write_text(json.dumps({"status": "audit-passed; device-runtime-test-not-run", "installed": False, "packageFile": self.deb.name, "packageSha256": digest, "sourceCommit": SOURCE, "builderImageRef": BUILDER}))
        (self.output / "audit-report.json").write_text(json.dumps({"ok": True, "status": "static-audit-passed; installation-and-device-runtime-unverified"}))
        (self.output / "build.log").write_text("build succeeded\n")
        (self.output / "app-private-properties.patch").write_text("diff --git app private\n")
        self.pooldeb = self.feed / "pool/main/make" / self.deb.name
        self.pooldeb.write_bytes(self.deb.read_bytes())
        for name in ("Release", "InRelease", "Release.gpg"):
            (self.feed / "dists/stable" / name).write_text(name)
        for name in ("Packages", "Packages.gz"):
            (self.feed / "dists/stable/main/binary-aarch64" / name).write_text(name)
        self.pub = self.key / "keys" / m.PUBLIC_KEY
        self.pub.write_bytes(b"public keyring")
        (self.key / "keys" / m.PUBLIC_META).write_text(json.dumps({"fingerprint": "F" * 40}))
        self.args = (self.output, self.feed, self.key, self.manifest, self.dest, self.repo, "12", COMMIT, SOURCE, BUILDER, "owner/repo", None)

    def tearDown(self):
        self.temp.cleanup()

    def run_stage(self):
        def run(args, **kwargs):
            if args[0] == "dpkg-deb":
                return type("Result", (), {"stdout": "Package: make\nVersion: 4.4.1-1\nArchitecture: aarch64\n", "stderr": ""})()
            return type("Result", (), {"stdout": "[GNUPG:] VALIDSIG " + "F" * 40 + "\n", "stderr": ""})()
        with patch.object(m.subprocess, "run", side_effect=run):
            m.stage(*self.args)

    def test_stages_verified_allowlist_only(self):
        self.run_stage()
        self.assertTrue((self.dest / "packages" / self.deb.name).is_file())
        self.assertTrue((self.dest / "signed-feed/dists/stable/InRelease").is_file())
        self.assertTrue((self.dest / "reports/app-private-properties.patch").is_file())
        self.assertFalse((self.dest / "private.key").exists())
        self.assertTrue((self.dest / "SHA256SUMS").is_file())
        import tarfile
        archive = self.dest.with_name(self.dest.name + ".tar.gz")
        self.assertTrue(archive.is_file())
        with tarfile.open(archive, "r:gz") as tar:
            self.assertIn("packages/" + self.deb.name, tar.getnames())
            self.assertIn("SHA256SUMS", tar.getnames())
            names = tar.getnames()
            self.assertIn("signed-feed/pool/main/make/" + self.deb.name, names)
            self.assertIn("signed-feed/dists/stable/InRelease", names)
            self.assertIn("signed-feed/dists/stable/Release.gpg", names)
            self.assertEqual(tar.extractfile("packages/" + self.deb.name).read(), self.deb.read_bytes())
            self.assertEqual(tar.extractfile("signed-feed/pool/main/make/" + self.deb.name).read(), self.deb.read_bytes())
            self.assertFalse(any("private-key" in n.lower() or "secret" in n.lower() or "gnupg" in n.lower() for n in names))
            self.assertTrue(all(not Path(n).is_absolute() and ".." not in Path(n).parts for n in names))
        provenance = json.loads((self.dest / "provenance.json").read_text())
        self.assertEqual(provenance["repository"], "owner/repo")
        self.assertEqual(provenance["repositoryCommit"], COMMIT)
        self.assertEqual(provenance["publicKeyFingerprint"], "F" * 40)

    def test_rejects_symlink_in_feed_tree(self):
        (self.feed / "pool/unexpected").symlink_to(self.deb)
        with self.assertRaises(ValueError):
            self.run_stage()

    def test_rejects_unexpected_private_key_file(self):
        (self.key / "private-key.asc").write_text("not for retention")
        with self.assertRaises(ValueError):
            self.run_stage()

    def test_explicit_source_closure_cli_string(self):
        closure = self.output / "explicit-source-closure.json"
        closure.write_text(json.dumps({"sourceCommit": SOURCE, "packages": [{"name": "make"}]}))
        args = list(self.args)
        args[-1] = str(closure)
        self.args = tuple(args)
        self.run_stage()
        self.assertTrue((self.dest / "reports/source-closure.json").is_file())
    def test_rejects_missing_report(self):
        (self.output / "audit-report.json").unlink()
        with self.assertRaises(ValueError):
            self.run_stage()

    def test_rejects_package_set_mismatch(self):
        self.deb.rename(self.output / "packages/wget_1_aarch64.deb")
        with self.assertRaises(ValueError):
            self.run_stage()

    def test_rejects_extra_package_output_file_with_json_diagnostic(self):
        (self.output / "packages" / "odd\nname.txt").write_text("unexpected")
        with self.assertRaisesRegex(ValueError, '"expectedIdentities"') as error:
            self.run_stage()
        self.assertIn('"expectedCount": 1', str(error.exception))
        self.assertIn('"foundFilenames": ["make_4.4.1-1_aarch64.deb", "odd\\nname.txt"]', str(error.exception))

    def test_accepts_exact_gh_builder_checksum_metadata_without_retaining_it(self):
        (self.output / "packages/SHA256SUMS").write_text(f"{m.sha(self.deb)}  {self.deb}\n")
        self.run_stage()
        self.assertEqual([p.name for p in (self.dest / "packages").iterdir()], [self.deb.name])

    def test_rejects_checksum_metadata_with_wrong_digest(self):
        (self.output / "packages/SHA256SUMS").write_text(f"{'0' * 64}  {self.deb}\n")
        with self.assertRaisesRegex(ValueError, "SHA256SUMS metadata"):
            self.run_stage()

    def test_rejects_checksum_metadata_with_unbound_path(self):
        (self.output / "packages/SHA256SUMS").write_text(f"{m.sha(self.deb)}  /different/root/{self.deb.name}\n")
        with self.assertRaisesRegex(ValueError, "SHA256SUMS metadata"):
            self.run_stage()

    def test_rejects_extra_packages_sha256sums(self):
        (self.output / "packages" / "SHA256SUMS").write_text("deadbeef  make.deb\n")
        with self.assertRaises(ValueError):
            self.run_stage()

    def test_make_checksum_sidecar_is_outside_package_directory(self):
        builder = Path(__file__).parents[2] / "termux-private-package-kit/make-v476/build-make-private-aarch64.sh"
        source = builder.read_text()
        self.assertIn('> "$OUTPUT_DIR/package-SHA256SUMS"', source)
        self.assertNotIn('> "$OUTPUT_DIR/packages/SHA256SUMS"', source)

    def test_rejects_hash_mismatch_between_pool_and_candidate(self):
        self.pooldeb.write_bytes(b"different")
        with self.assertRaises(ValueError):
            self.run_stage()

    def test_accepts_exact_multi_package_profile(self):
        import hashlib
        (self.output / "source-closure.json").write_text(json.dumps({"sourceCommit": SOURCE, "packages": [{"name": "make"}, {"name": "libmake"}]}))
        extra = self.output / "packages/libmake_2.0_aarch64.deb"
        extra.write_bytes(b"second deb")
        (self.feed / "pool/main/make/libmake_2.0_aarch64.deb").write_bytes(extra.read_bytes())
        self.manifest.write_text(json.dumps({"packages": [
            {"name": "make", "version": "4.4.1-1", "architecture": "aarch64", "sourceCommit": SOURCE},
            {"name": "libmake", "version": "2.0", "architecture": "aarch64", "sourceCommit": SOURCE}]}))
        first_sha = hashlib.sha256(self.deb.read_bytes()).hexdigest()
        second_sha = hashlib.sha256(extra.read_bytes()).hexdigest()
        result = {"status": "audit-passed; device-runtime-test-not-run", "installed": False,
                  "sourceCommit": SOURCE, "builderImage": BUILDER, "packages": [
                      {"name": "make", "version": "4.4.1-1", "architecture": "aarch64", "filename": self.deb.name, "sha256": first_sha},
                      {"name": "libmake", "version": "2.0", "architecture": "aarch64", "file": extra.name, "sha256": second_sha}]}
        (self.output / "build-result.json").write_text(json.dumps(result))
        def identity(path):
            if path.name.startswith("libmake_"):
                return "libmake", "2.0", "aarch64"
            return "make", "4.4.1-1", "aarch64"
        with patch.object(m, "deb_identity", side_effect=identity), patch.object(m.subprocess, "run", return_value=type("Result", (), {"stdout": "[GNUPG:] VALIDSIG " + "F" * 40, "stderr": ""})()):
            m.stage(*self.args)
        self.assertEqual(len(list((self.dest / "packages").glob("*.deb"))), 2)

    def test_real_dpkg_and_gpg_end_to_end(self):
        import hashlib
        import os
        import subprocess
        package_root = Path(self.temp.name) / "package-root"
        (package_root / "DEBIAN").mkdir(parents=True)
        (package_root / "DEBIAN/control").write_text(
            "Package: make\nVersion: 1:4.4.1-1\nArchitecture: aarch64\nDescription: fixture\n")
        (package_root / "usr/share/doc").mkdir(parents=True)
        subprocess.run(["dpkg-deb", "--build", str(package_root), str(self.deb)], check=True, capture_output=True)
        self.manifest.write_text(json.dumps({"packages": [{"name": "make", "version": "1:4.4.1-1", "architecture": "aarch64", "sourceCommit": SOURCE}]}))
        epoch_deb = self.output / "packages" / "make_1:4.4.1-1_aarch64.deb"
        self.pooldeb.unlink()
        self.deb.rename(epoch_deb)
        self.pooldeb = self.feed / "pool/main/make" / epoch_deb.name
        self.pooldeb.write_bytes(epoch_deb.read_bytes())
        self.deb = epoch_deb
        digest = hashlib.sha256(self.deb.read_bytes()).hexdigest()
        (self.output / "build-result.json").write_text(json.dumps({"status": "audit-passed; device-runtime-test-not-run", "installed": False, "packageFile": self.deb.name, "packageSha256": digest, "sourceCommit": SOURCE, "builderImageRef": BUILDER}))

        home = self.key / "gnupg"
        env = dict(os.environ, GNUPGHOME=str(home))
        subprocess.run(["gpg", "--batch", "--passphrase", "", "--quick-generate-key", "Candidate Fixture <candidate@example.invalid>", "ed25519", "sign", "0"], env=env, check=True, capture_output=True)
        fingerprint = subprocess.check_output(["gpg", "--batch", "--with-colons", "--list-secret-keys"], env=env, text=True)
        fingerprint = next(line.split(":")[9] for line in fingerprint.splitlines() if line.startswith("fpr:"))
        self.pub.write_bytes(subprocess.check_output(["gpg", "--batch", "--export", fingerprint], env=env))
        (self.key / "keys" / m.PUBLIC_META).write_text(json.dumps({"fingerprint": fingerprint}))
        release = self.feed / "dists/stable/Release"
        release.write_text("Suite: stable\n")
        subprocess.run(["gpg", "--batch", "--yes", "--clearsign", "--output", str(self.feed / "dists/stable/InRelease"), str(release)], env=env, check=True, capture_output=True)
        subprocess.run(["gpg", "--batch", "--yes", "--detach-sign", "--output", str(self.feed / "dists/stable/Release.gpg"), str(release)], env=env, check=True, capture_output=True)
        m.stage(*self.args)
        subprocess.run(["gpg", "--batch", "--verify", str(self.dest / "provenance.json.asc"), str(self.dest / "provenance.json")], env=env, check=True, capture_output=True)
        subprocess.run(["gpg", "--batch", "--verify", str(self.dest / "SHA256SUMS.asc"), str(self.dest / "SHA256SUMS")], env=env, check=True, capture_output=True)
        archive = self.dest.with_name(self.dest.name + ".tar.gz")
        with tarfile.open(archive, "r:gz") as tar:
            names = tar.getnames()
            epoch_path = "make_1:4.4.1-1_aarch64.deb"
            self.assertIn("packages/" + epoch_path, names)
            self.assertIn("signed-feed/pool/main/make/" + epoch_path, names)
            self.assertEqual(tar.extractfile("packages/" + epoch_path).read(), self.deb.read_bytes())
            self.assertEqual(tar.extractfile("signed-feed/pool/main/make/" + epoch_path).read(), self.deb.read_bytes())
            for path in ("provenance.json.asc", "SHA256SUMS.asc", "SHA256SUMS",
                         "signed-feed/dists/stable/InRelease", "signed-feed/dists/stable/Release.gpg"):
                self.assertIn(path, names)
            self.assertFalse(any("private-keys-v1.d" in n or "secret" in n.lower() for n in names))
            self.assertTrue(all(not Path(n).is_absolute() and ".." not in Path(n).parts for n in names))



if __name__ == "__main__":
    unittest.main()
